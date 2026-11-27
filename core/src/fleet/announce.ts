/**
 * Announcing this core to its peers (docs/d2/part-two-design.md, Decision 3): every interval, one
 * `POST /v1/fleet/announce` over the fleet transport to each address in the local address list
 * (peers.ts), each call on its own connection with one timeout. The reply is the peer's own
 * announcement, authenticated by the peer's key, and goes into the member list like any other, so
 * two cores list each other when only one knows the other's address. On a clean stop the core
 * announces `leaving` once, with a short timeout, so its peers drop it at once.
 *
 * A call still in flight to an address is not started again. A clean stop waits for the round in
 * flight (at most `LEAVING_TIMEOUT_MS`) before it announces `leaving`, so a late `up` cannot list
 * the stopping core again. Outcomes are logged when they change
 * (reachable, refused, unreachable), never once per interval.
 */
import type { KeyObject } from "node:crypto";

import { API_VERSION_HEADER, validate, type Announcement } from "../contract/index.js";
import { ANNOUNCE_INTERVAL_MS, type Members } from "./members.js";
import type { PeerAddress } from "./peers.js";
import { FLEET_TIMEOUT_MS, fleetCall, type FleetCallOptions, type FleetResponse } from "./transport.js";
import type { TrustList } from "./trust.js";

/** An announcement and its reply are a few dozen bytes; read no more than this of a reply. */
export const MAX_REPLY_BYTES = 16 * 1024;
/** How long the `leaving` announcement of a clean stop may take. */
export const LEAVING_TIMEOUT_MS = 1000;

type Log = (line: string) => void;
type Call = (o: FleetCallOptions) => Promise<FleetResponse>;

export interface AnnouncerOptions {
  key: KeyObject;
  /** The trust list, read again for each round (the client checks each peer against it). */
  trust: () => TrustList;
  /** The address list, read again for each round. */
  peers: () => PeerAddress[];
  members: Members;
  log: Log;
  intervalMs?: number;
  /** One call's timeout. Default: one interval, at most the transport's 5 s. */
  timeoutMs?: number;
  /** The transport call (tests inject one). */
  call?: Call;
}

export interface Announcer {
  /** One announcement to every address not already in flight; resolves when all have settled. */
  round(): Promise<void>;
  /** Announce now and then every interval. */
  start(): void;
  /** Stop announcing, then announce `leaving` to every address once. Idempotent. */
  stop(): Promise<void>;
  /**
   * The address in the local address list whose last reply came from member `node`, authenticated as
   * that member's key; undefined when none did. A remote call goes only to such an address.
   */
  addressOf(node: string): PeerAddress | undefined;
}

const label = (p: PeerAddress): string => (p.host.includes(":") ? `[${p.host}]:${p.port}` : `${p.host}:${p.port}`);

function errorText(body: Buffer): string {
  try {
    // A refused announcement has its own body (fleet.json `announce_refusal`); any other error is error.json.
    const parsed = JSON.parse(body.toString("utf8")) as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
    const e = parsed.error ?? parsed;
    return `${String(e.code)}: ${String(e.message)}`.slice(0, 300);
  } catch {
    return "an unreadable error body";
  }
}

/** The peer's reply, which must be its own announcement. */
function replyOf(res: FleetResponse): Announcement {
  let body: unknown;
  try {
    body = JSON.parse(res.body.toString("utf8"));
  } catch {
    throw new Error("the reply is not JSON");
  }
  if (!validate("fleet#announcement", body).ok) throw new Error("the reply is not an announcement");
  return body as Announcement;
}

export function createAnnouncer(o: AnnouncerOptions): Announcer {
  const call = o.call ?? fleetCall;
  const intervalMs = o.intervalMs ?? ANNOUNCE_INTERVAL_MS;
  const inFlight = new Set<string>();
  const outcome = new Map<string, string>(); // last logged outcome per address
  const answeredAs = new Map<string, { node: string; peer: PeerAddress }>(); // by address: the member whose key last replied there
  let timer: NodeJS.Timeout | null = null;
  let stopping: Promise<void> | null = null;

  const note = (where: string, what: string, line: string): void => {
    if (outcome.get(where) === what) return;
    outcome.set(where, what);
    o.log(`culture-agents core: fleet: ${line}`);
  };

  const send = (peer: PeerAddress, state: Announcement["state"], timeoutMs: number): Promise<FleetResponse> => {
    const announcement = o.members.announcement(state);
    const headers = { [API_VERSION_HEADER]: announcement.api_version }; // the rule between cores: same MAJOR (contract/README.md)
    return call({ key: o.key, trust: o.trust(), host: peer.host, port: peer.port, method: "POST", path: "/v1/fleet/announce", body: JSON.stringify(announcement), headers, timeoutMs, maxResponseBytes: MAX_REPLY_BYTES });
  };

  async function announceTo(peer: PeerAddress): Promise<void> {
    const where = label(peer);
    try {
      const res = await send(peer, "up", o.timeoutMs ?? Math.min(intervalMs, FLEET_TIMEOUT_MS));
      answeredAs.delete(where);
      if (res.status !== 200) {
        note(where, `refused ${res.status}`, `${where} refused this core's announcement (${res.status}, ${errorText(res.body)})`);
        return;
      }
      const receipt = o.members.receive(res.member, replyOf(res));
      if (!receipt.ok) return;
      answeredAs.set(where, { node: res.member.node, peer });
      note(where, "ok", `announced to ${where}, which is member ${res.member.node}`);
    } catch (e) {
      answeredAs.delete(where);
      note(where, "failed", `cannot announce to ${where}: ${(e as Error).message}`);
    }
  }

  let current: Promise<unknown> = Promise.resolve();

  async function round(): Promise<void> {
    if (stopping) return;
    const due = o.peers().filter((p) => !inFlight.has(label(p)));
    current = Promise.allSettled(
      due.map(async (peer) => {
        inFlight.add(label(peer));
        try {
          await announceTo(peer);
        } finally {
          inFlight.delete(label(peer));
        }
      }),
    );
    await current;
  }

  const tick = (): void => {
    round().catch((e: unknown) => o.log(`culture-agents core: fleet: an announcement round failed: ${String(e)}`));
  };

  return {
    round,
    addressOf(node) {
      const listed = new Set(o.peers().map(label)); // an address the operator removed is not called
      for (const [where, a] of answeredAs) if (a.node === node && listed.has(where)) return a.peer;
      return undefined;
    },
    start() {
      if (timer || stopping) return;
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    stop() {
      stopping ??= (async () => {
        if (timer) clearInterval(timer);
        timer = null;
        // An `up` still in flight could land after the `leaving` and list this core again: let it
        // settle first, waiting no longer than the leaving's own timeout.
        let wait: NodeJS.Timeout | undefined;
        await Promise.race([current, new Promise((resolve) => (wait = setTimeout(resolve, LEAVING_TIMEOUT_MS)))]);
        clearTimeout(wait);
        const results = await Promise.allSettled(o.peers().map((peer) => send(peer, "leaving", LEAVING_TIMEOUT_MS)));
        const told = results.filter((r) => r.status === "fulfilled" && r.value.status === 200).length;
        if (results.length > 0) o.log(`culture-agents core: fleet: announced leaving to ${told} of ${results.length} address(es)`);
      })();
      return stopping;
    },
  };
}
