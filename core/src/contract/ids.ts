import { randomBytes } from "node:crypto";

import type { ActionId, MeshId, RunId, SessionId } from "./generated/index.js";

// Patterns mirror contract/common.json (the schemas stay authoritative: a test asserts
// these agree with the `pattern` of the matching $defs on every documented example).
const NODE = /^[a-z0-9]{1,32}$/;
const SUFFIX = /^[a-z0-9_]+(-[a-z0-9_]+)*$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type ScopedKind = "run" | "ses" | "act";

export interface MeshIdParts {
  node: string;
  /** The agent suffix (culture.yaml `suffix`). */
  agent: string;
}

export interface ScopedIdParts extends MeshIdParts {
  kind: ScopedKind;
  /** `<node>-<agent>`, the executing agent. */
  agentId: MeshId;
  ulid: string;
}

/** Build a mesh id `<node>-<agent>`; throws if either part breaks its pattern. */
export function buildMeshId(node: string, agent: string): MeshId {
  if (!NODE.test(node)) throw new RangeError(`invalid node: ${JSON.stringify(node)}`);
  if (!SUFFIX.test(agent)) throw new RangeError(`invalid agent suffix: ${JSON.stringify(agent)}`);
  const id = `${node}-${agent}`;
  if (id.length > 96) throw new RangeError("mesh id is longer than 96 characters");
  return id;
}

/** Split a mesh id at its first hyphen (the node has no hyphen); null when it does not match. */
export function parseMeshId(id: string): MeshIdParts | null {
  const cut = id.indexOf("-");
  if (cut < 1 || id.length > 96) return null;
  const node = id.slice(0, cut);
  const agent = id.slice(cut + 1);
  return NODE.test(node) && SUFFIX.test(agent) ? { node, agent } : null;
}

function build(kind: ScopedKind, agentId: string, ulid: string): string {
  if (parseMeshId(agentId) === null) throw new RangeError(`invalid agent id: ${JSON.stringify(agentId)}`);
  if (!ULID.test(ulid)) throw new RangeError(`invalid ULID: ${JSON.stringify(ulid)}`);
  return `${agentId}.${kind}.${ulid}`;
}

/** `<node>-<agent>.run.<ULID>`, where the agent is the executing agent's mesh id. */
export const buildRunId = (agentId: string, ulid: string): RunId => build("run", agentId, ulid);
/** `<node>-<agent>.ses.<ULID>`. */
export const buildSessionId = (agentId: string, ulid: string): SessionId => build("ses", agentId, ulid);
/** `<node>-<agent>.act.<ULID>`, using the run's agent. */
export const buildActionId = (agentId: string, ulid: string): ActionId => build("act", agentId, ulid);

/** Parse a run, session or action id; null when it matches none of the documented forms. */
export function parseScopedId(id: string): ScopedIdParts | null {
  const m = /^(.+)\.(run|ses|act)\.([^.]+)$/.exec(id);
  if (!m) return null;
  const agentId = m[1] as string;
  const ulid = m[3] as string;
  const mesh = parseMeshId(agentId);
  if (mesh === null || !ULID.test(ulid)) return null;
  return { ...mesh, kind: m[2] as ScopedKind, agentId, ulid };
}

const isKind = (kind: ScopedKind) => (id: string) => parseScopedId(id)?.kind === kind;
export const isRunId = (id: string): id is RunId => isKind("run")(id);
export const isSessionId = (id: string): id is SessionId => isKind("ses")(id);
export const isActionId = (id: string): id is ActionId => isKind("act")(id);

/** A run's host branch: `runs/<run_id>`. */
export function runBranch(runId: RunId): string {
  return `runs/${runId}`;
}

/**
 * A fresh ULID (48-bit millisecond time, 80 random bits). Not monotonic within one
 * millisecond; ids are assigned by the core and never reused, and 80 random bits make a
 * collision negligible.
 */
export function newUlid(timeMs: number = Date.now()): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs >= 2 ** 48) throw new RangeError("ULID time out of range");
  let out = "";
  let t = timeMs;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(10);
  let bits = 0n;
  for (const b of rand) bits = (bits << 8n) | BigInt(b);
  for (let i = 0; i < 16; i++) {
    out += CROCKFORD[Number(bits & 31n)];
    bits >>= 5n;
  }
  return out;
}
