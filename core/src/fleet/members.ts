/**
 * The fleet member list (docs/d2/part-two-design.md, Decision 3), built from announcements only.
 *
 * - A peer is listed only after an announcement arrives from a key the transport authenticated
 *   against the trust list, and only under the node name the trust list gives that key. Nothing
 *   else adds an entry: not the trust list, not the address list.
 * - Two members never share a node name (c40). An announcement is refused with `conflict`, and
 *   reported to the operator (the core's log and `refused` in the list), when it claims a name the
 *   trust list does not give its key, when it claims this core's own name with another key, or when
 *   the name is still held by another listed key (the trust entry was replaced while the old key's
 *   core still runs; the name frees once that core leaves or goes silent).
 * - A member is dropped when nothing has been heard from it for more than `SILENCE_MS`, or at once
 *   when it announces `leaving`. A read never shows a member past its silence; the sweep, every
 *   `SWEEP_MS`, logs the drop. Silence is measured on this core's monotonic clock; the sender's
 *   clock is never read (c42).
 */
import { performance } from "node:perf_hooks";

import { apiVersion, type Announcement, type Member, type MemberList, type Refusal } from "../contract/index.js";
import type { TrustEntry } from "./trust.js";

/** How often a core announces itself, and the timeout of one announcement call. */
export const ANNOUNCE_INTERVAL_MS = 5000;
/** A member silent for longer than this is dropped. */
export const SILENCE_MS = 15000;
/** How often silent members are swept out (and the drop logged). */
export const SWEEP_MS = 1000;
/** The most refusals kept for the operator, newest first. */
export const MAX_REFUSALS = 32;
/** A refusal not repeated for this long leaves the report. */
const REFUSAL_KEEP_MS = 3_600_000;
/** A repeated refusal is logged again at most this often. */
const REFUSAL_LOG_MS = 60_000;

type Log = (line: string) => void;

export type Receipt = { ok: true } | { ok: false; reason: string; retryable: boolean };

export interface MemberListOptions {
  /** This core's own node name. */
  node: string;
  /** This core's own key fingerprint. */
  fingerprint: string;
  /** A monotonic clock in ms. Default: `performance.now`. */
  now?: () => number;
  silenceMs?: number;
  intervalMs?: number;
  log: Log;
}

export interface Members {
  /** An announcement from `from`, the trust entry the transport authenticated. */
  receive(from: TrustEntry, announcement: Announcement): Receipt;
  /** Drop and log every member silent for longer than the silence threshold. */
  sweep(): void;
  /** The list as the contract shapes it (`fleet.json`). */
  view(): MemberList;
  /** This core's own next announcement. */
  announcement(state: Announcement["state"]): Announcement;
}

interface Heard {
  member: Omit<Member, "heard_ms_ago">;
  at: number;
}

interface Refused {
  refusal: Omit<Refusal, "heard_ms_ago">;
  at: number;
  loggedAt: number;
}

const short = (fp: string): string => fp.slice(0, 16);

export function createMemberList(o: MemberListOptions): Members {
  const now = o.now ?? (() => performance.now());
  const silenceMs = o.silenceMs ?? SILENCE_MS;
  const heard = new Map<string, Heard>(); // by node name
  const refused = new Map<string, Refused>(); // by fingerprint and claimed name; insertion order is age
  let seq = 0;

  const silent = (h: Heard, t: number): boolean => t - h.at > silenceMs;

  function conflict(from: TrustEntry, a: Announcement, t: number): Receipt {
    if (a.node !== from.node) return { ok: false, reason: `the trust list names this key ${from.node}, not ${a.node}`, retryable: false };
    if (a.node === o.node && from.fingerprint !== o.fingerprint) return { ok: false, reason: `the node name ${a.node} is held by this core's own key`, retryable: false };
    const holder = heard.get(a.node);
    if (holder && holder.member.fingerprint !== from.fingerprint && !silent(holder, t)) {
      return { ok: false, reason: `the node name ${a.node} is held by another key (${short(holder.member.fingerprint)}), heard ${Math.round(t - holder.at)} ms ago`, retryable: true };
    }
    return { ok: true };
  }

  function report(from: TrustEntry, a: Announcement, reason: string, t: number): void {
    const id = `${from.fingerprint} ${a.node}`;
    const seen = refused.get(id);
    refused.delete(id); // re-inserted below: newest last
    const entry: Refused = seen ? { ...seen, refusal: { ...seen.refusal, reason, count: seen.refusal.count + 1 }, at: t } : { refusal: { node: a.node, trusted_as: from.node, fingerprint: from.fingerprint, reason, count: 1 }, at: t, loggedAt: -Infinity };
    if (t - entry.loggedAt > REFUSAL_LOG_MS) {
      entry.loggedAt = t;
      o.log(`culture-agents core: fleet: refused an announcement (conflict) from key ${short(from.fingerprint)}, trusted as ${from.node}, claiming node ${a.node}: ${reason}; seen ${entry.refusal.count} time(s)`);
    }
    refused.set(id, entry);
    for (const key of refused.keys()) {
      if (refused.size <= MAX_REFUSALS) break;
      refused.delete(key);
    }
  }

  function accept(from: TrustEntry, a: Announcement, t: number): void {
    const known = heard.get(a.node);
    if (a.state === "leaving") {
      heard.delete(a.node);
      if (known) o.log(`culture-agents core: fleet: member ${a.node} left (key ${short(from.fingerprint)})`);
      return;
    }
    if (!known || silent(known, t) || known.member.fingerprint !== from.fingerprint) o.log(`culture-agents core: fleet: member ${a.node} joined (key ${short(from.fingerprint)}, api ${a.api_version})`);
    heard.set(a.node, { member: { node: a.node, fingerprint: from.fingerprint, api_version: a.api_version, seq: a.seq }, at: t });
  }

  function sweep(): void {
    const t = now();
    for (const [node, h] of heard) {
      if (!silent(h, t)) continue;
      heard.delete(node);
      o.log(`culture-agents core: fleet: member ${node} dropped: silent for ${Math.round(t - h.at)} ms (limit ${silenceMs} ms)`);
    }
    for (const [id, r] of refused) if (t - r.at > REFUSAL_KEEP_MS) refused.delete(id);
  }

  return {
    receive(from, a) {
      const t = now();
      const receipt = conflict(from, a, t);
      if (receipt.ok) accept(from, a, t);
      else report(from, a, receipt.reason, t);
      return receipt;
    },
    sweep,
    view() {
      const t = now();
      const ago = (at: number): number => Math.max(0, Math.round(t - at));
      const members = [...heard.values()].filter((h) => !silent(h, t)).map((h) => ({ ...h.member, heard_ms_ago: ago(h.at) }));
      members.sort((a, b) => (a.node < b.node ? -1 : 1));
      const refusals = [...refused.values()].reverse().map((r) => ({ ...r.refusal, heard_ms_ago: ago(r.at) }));
      return { node: o.node, transport: "on", announce_interval_ms: o.intervalMs ?? ANNOUNCE_INTERVAL_MS, silence_ms: silenceMs, members, refused: refusals };
    },
    announcement(state) {
      return { node: o.node, api_version: apiVersion, seq: seq++, state };
    },
  };
}

/** The list a core with the fleet transport off reports: nothing announced, nothing heard. */
export function memberListOff(node: string): MemberList {
  return { node, transport: "off", announce_interval_ms: ANNOUNCE_INTERVAL_MS, silence_ms: SILENCE_MS, members: [], refused: [] };
}
