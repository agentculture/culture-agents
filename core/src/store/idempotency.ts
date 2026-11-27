/**
 * The idempotency key index (contract/README.md: idempotency keys). One owner-only JSON file per
 * key under `<stateDir>/keys/`, named `<scope>-<sha256(key)>.json`, written by temp file and
 * rename and fsynced before the request it guards is acknowledged.
 *
 * A key belongs to one route (`scope`: submit, steer or cancel). Its entry holds a digest of the
 * request (`requestDigest`) and the run the key belongs to. It is `reserved` from the moment it is
 * written until its effect is established (the run's event 1 is on disk, or the worker recorded the
 * action as `run.control`), then `established`. A reserved key whose effect was never established
 * is released (deleted), so a repeat of it starts afresh. A key whose outcome is not known yet
 * (a live worker may still be delivering its action) stays reserved, so it takes effect at most once.
 *
 * Crash-safe submit order: key, then run directory, then spawn. After a restart `recoverKeys`
 * settles every reserved key from the run store, which is the only evidence.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { isTerminal, type ActionRecord, type RunEvent, type RunId } from "../contract/index.js";
import { readLog } from "./event-log.js";
import { atomicWriteJson, ensureDir, fsyncDir, runDir } from "./files.js";
import { checkLiveness } from "./liveness.js";

export type KeyScope = "submit" | "steer" | "cancel";

export interface KeyEntry {
  scope: KeyScope;
  key: string;
  /** `requestDigest` of the request that first used the key. */
  digest: string;
  /** The run the key belongs to (the run it created, or the run it acted on). */
  run_id: RunId;
  state: "reserved" | "established";
  /** Steer and cancel: the action record the key stands for. Null for a submit. */
  action: ActionRecord | null;
  recorded_at: string;
}

/** Code-unit order of two keys; not locale order, so a digest never depends on the host's locale. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Sorted-key JSON, so two equal requests have one text whatever their field order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => byCodeUnit(a, b));
    const members = entries.map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",");
    return `{${members}}`;
  }
  return JSON.stringify(value);
}

/**
 * The digest that decides "the same request": sha256 over the canonical JSON of the request body
 * without `idempotency_key` (for a submit, after the server canonicalized `repo`), plus the route
 * and, for steer and cancel, the run id of the path. Every other field counts, `caller` included.
 */
export function requestDigest(scope: KeyScope, request: object, runId?: string): string {
  const rest: Record<string, unknown> = { ...(request as Record<string, unknown>) };
  Reflect.deleteProperty(rest, "idempotency_key");
  const body = { scope, run_id: runId ?? null, request: rest };
  return `sha256:${createHash("sha256").update(canonical(body)).digest("hex")}`;
}

const KEY_FILE = /^(submit|steer|cancel)-[0-9a-f]{64}\.json$/;

/** `<stateDir>/keys`. */
export function keysDir(stateDir: string): string {
  return join(stateDir, "keys");
}

export class KeyIndex {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(readonly stateDir: string) {}

  private path(scope: KeyScope, key: string): string {
    return join(keysDir(this.stateDir), `${scope}-${createHash("sha256").update(key).digest("hex")}.json`);
  }

  /** The entry for a key, or null. A file that cannot be parsed throws: the key is not "unused". */
  get(scope: KeyScope, key: string): KeyEntry | null {
    let text: string;
    try {
      text = readFileSync(this.path(scope, key), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const entry = JSON.parse(text) as KeyEntry;
    if (entry.key !== key || entry.scope !== scope) throw new Error(`idempotency key file for ${scope} ${key} names another key`);
    return entry;
  }

  /** Write (or replace) an entry durably: file fsynced, renamed, directory fsynced. */
  put(entry: KeyEntry): void {
    const dir = keysDir(this.stateDir);
    ensureDir(dir);
    atomicWriteJson(this.path(entry.scope, entry.key), entry, true);
  }

  /** Mark a key established, optionally with its final action record. */
  establish(entry: KeyEntry, action: ActionRecord | null = entry.action): KeyEntry {
    const done: KeyEntry = { ...entry, state: "established", action };
    this.put(done);
    return done;
  }

  /** Forget a key; its next use starts afresh. */
  release(scope: KeyScope, key: string): void {
    rmSync(this.path(scope, key), { force: true });
    try {
      fsyncDir(keysDir(this.stateDir));
    } catch {
      // the directory is gone too: nothing to make durable
    }
  }

  /** Every readable entry; unreadable or foreign files are skipped. */
  list(): KeyEntry[] {
    let names: string[];
    try {
      names = readdirSync(keysDir(this.stateDir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const entries: KeyEntry[] = [];
    for (const name of names.filter((n) => KEY_FILE.test(n))) {
      try {
        entries.push(JSON.parse(readFileSync(join(keysDir(this.stateDir), name), "utf8")) as KeyEntry);
      } catch {
        // a broken entry is left for the operator; `get` reports it when the key is used
      }
    }
    return entries;
  }

  /** Run `fn` with no other `exclusive` call on the same key in this process running at once. */
  exclusive<T>(scope: KeyScope, key: string, fn: () => Promise<T>): Promise<T> {
    const id = `${scope}\n${key}`;
    const next = (this.chains.get(id) ?? Promise.resolve()).then(fn);
    const tail = next.catch(() => undefined);
    this.chains.set(id, tail);
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id);
    });
    return next;
  }
}

/** What the store says about a reserved key's effect. */
export type KeySettlement = "established" | "pending" | "released";

function runEstablished(stateDir: string, runId: RunId): "yes" | "no" | "pending" {
  const dir = runDir(stateDir, runId);
  if (!existsSync(dir)) return "no";
  try {
    if (readLog(dir, runId).events.length > 0) return "yes";
  } catch {
    // no readable log yet: decided by liveness
  }
  try {
    // A worker started but not yet durable will write event 1 itself: the key stays reserved.
    return checkLiveness(dir).alive ? "pending" : "no";
  } catch {
    return "pending"; // liveness unknown counts as alive
  }
}

/** The action's `run.control` in the log (the worker took it), or null. */
function recordedAction(events: RunEvent[], actionId: string): ActionRecord | null {
  for (const event of events) {
    if (event.kind !== "run.control") continue;
    const action = (event.data as { action?: ActionRecord }).action;
    if (action?.id === actionId) return action;
  }
  return null;
}

/** Whether the worker logged that it did not take the action: `run.refused`, or the `run.error` of a steer the harness refused (its message names the action id). */
function refusedInLog(events: RunEvent[], actionId: string): boolean {
  return events.some((event) => {
    if (event.kind === "run.refused") return (event.data as { action?: ActionRecord }).action?.id === actionId;
    return event.kind === "run.error" && ((event.data as { error?: { message?: string } }).error?.message ?? "").includes(actionId);
  });
}

/** What the store says about a steer or cancel. */
export type ActionOutcome = { taken: "yes"; action: ActionRecord } | { taken: "no" } | { taken: "unknown" };

/**
 * Whether the worker took a delivered action, from the run's event log: yes when the log records it
 * as `run.control`; no when the run directory is gone, the log records a refusal, the run is terminal
 * without it, or its worker is gone; otherwise unknown (a live worker may still be delivering it).
 * An unreadable log is unknown: it never counts as "not recorded".
 */
export function actionOutcome(stateDir: string, runId: RunId, actionId: string): ActionOutcome {
  const dir = runDir(stateDir, runId);
  if (!existsSync(dir)) return { taken: "no" };
  let log: ReturnType<typeof readLog>;
  try {
    log = readLog(dir, runId);
  } catch {
    return { taken: "unknown" };
  }
  const action = recordedAction(log.events, actionId);
  if (action !== null) return { taken: "yes", action };
  if (refusedInLog(log.events, actionId)) return { taken: "no" };
  const { state } = log.tail;
  if (state !== null && isTerminal(state)) return { taken: "no" };
  try {
    return checkLiveness(dir).alive ? { taken: "unknown" } : { taken: "no" };
  } catch {
    return { taken: "unknown" }; // liveness unknown counts as alive
  }
}

/** Settle a reserved steer or cancel key from its action's outcome. */
function settleAction(index: KeyIndex, entry: KeyEntry, action: ActionRecord): { settlement: KeySettlement; entry: KeyEntry } {
  const outcome = actionOutcome(index.stateDir, entry.run_id, action.id);
  if (outcome.taken === "yes") return { settlement: "established", entry: index.establish(entry, { ...action, outcome: "accepted" }) };
  if (outcome.taken === "unknown") return { settlement: "pending", entry };
  index.release(entry.scope, entry.key);
  return { settlement: "released", entry };
}

/**
 * Settle one reserved key from the store: established when its run has event 1 (submit) or its
 * action is in the log (steer, cancel); pending while a not-yet-durable worker is alive, or while
 * a live worker of a non-terminal run may still be delivering the action; otherwise released. An
 * established key is returned unchanged.
 */
export function settleKey(index: KeyIndex, entry: KeyEntry): { settlement: KeySettlement; entry: KeyEntry } {
  if (entry.state === "established") return { settlement: "established", entry };
  if (entry.scope !== "submit" && entry.action !== null) return settleAction(index, entry, entry.action);
  if (entry.scope === "submit") {
    const state = runEstablished(index.stateDir, entry.run_id);
    if (state === "yes") return { settlement: "established", entry: index.establish(entry) };
    if (state === "pending") return { settlement: "pending", entry };
  }
  index.release(entry.scope, entry.key);
  return { settlement: "released", entry };
}

export interface RecoveryReport {
  established: string[];
  pending: string[];
  released: string[];
}

/** Startup: settle every reserved key (after the store cleanup removed directories without event 1). */
export function recoverKeys(index: KeyIndex): RecoveryReport {
  const report: RecoveryReport = { established: [], pending: [], released: [] };
  for (const entry of index.list()) {
    if (entry.state !== "reserved") continue;
    const { settlement } = settleKey(index, entry);
    report[settlement].push(`${entry.scope}:${entry.key}`);
  }
  return report;
}

/** `atomicWriteJson`'s temporary names: `<file>.tmp-<pid>-<n>`. */
const TEMP_FILE = /\.tmp-\d+-\d+$/;

/** Start-up: remove the temp files a crash between open and rename left in the keys directory. Returns their names. */
export function sweepKeyTemps(index: KeyIndex): string[] {
  let names: string[];
  try {
    names = readdirSync(keysDir(index.stateDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const removed = names.filter((name) => TEMP_FILE.test(name));
  for (const name of removed) rmSync(join(keysDir(index.stateDir), name), { force: true });
  return removed;
}

/** Remove established keys `expired` says are over (README: how long a key is remembered). */
export function pruneKeys(index: KeyIndex, expired: (entry: KeyEntry) => boolean): string[] {
  const removed: string[] = [];
  for (const entry of index.list()) {
    if (entry.state !== "established" || !expired(entry)) continue;
    index.release(entry.scope, entry.key);
    removed.push(`${entry.scope}:${entry.key}`);
  }
  return removed;
}
