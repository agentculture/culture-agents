/**
 * The run store: run directories under `<stateDir>/runs/<run-id>/`, the run record, and the
 * readers the core uses (list, show, read events after a cursor, follow events). Every state a
 * reader reports comes from `deriveRun` over the on-disk log and the worker's liveness.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { assertValid, isRunId, isTerminal, type Run, type RunEvent, type RunId, type RunState } from "../contract/index.js";
import { deriveRun, ORPHANED_REASON, type DerivedRun } from "./derive.js";
import { EventLogWriter, checkNext, readLog, type LogTail } from "./event-log.js";
import { FILE_MODE, atomicWriteJson, ensureDir, fsyncDir, nowIso, runDir, runFile, runsDir } from "./files.js";
import { checkLiveness, type Liveness, type LivenessOptions } from "./liveness.js";

/** Create a run's directory (0700) and its record (0600). Ids are never reused: an existing run is an error. */
export function createRun(stateDir: string, record: Run): string {
  const run = assertValid("run", record);
  const dir = runDir(stateDir, run.id);
  ensureDir(runsDir(stateDir));
  ensureDir(dir);
  writeFileSync(runFile(dir, "record"), `${JSON.stringify(run)}\n`, { mode: FILE_MODE, flag: "wx" });
  fsyncDir(dir);
  return dir;
}

export function readRecord(dir: string): Run {
  return assertValid("run", JSON.parse(readFileSync(runFile(dir, "record"), "utf8")));
}

/** Replace the record atomically (validated first). */
export function writeRecord(dir: string, record: Run, durable = false): void {
  atomicWriteJson(runFile(dir, "record"), assertValid("run", record), durable);
}

/** Every run id with a directory in the store (unordered). */
export function listRunIds(stateDir: string): RunId[] {
  try {
    return readdirSync(runsDir(stateDir)).filter((name) => isRunId(name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export interface ShowOptions extends LivenessOptions {
  /** Whether the caller holds live control of this run's worker (false after a core restart). */
  controllable?: boolean;
  /** Append `run.state` -> `unknown` when the run is orphaned (the core's duty as the only writer left). */
  settle?: boolean;
}

export interface ShownRun extends DerivedRun {
  liveness: Liveness;
}

/**
 * Append `run.state` -> `unknown` to an orphaned run's log. Re-checks first: it writes only when
 * the log has no terminal event and the worker is not alive. Returns the event, or null.
 */
export function settleOrphan(dir: string, runId: RunId, options: LivenessOptions = {}): RunEvent | null {
  const liveness = checkLiveness(dir, options);
  if (liveness.alive) return null;
  const writer = EventLogWriter.open(dir, runId, options.clock);
  try {
    if (writer.state === null || isTerminal(writer.state)) return null;
    return writer.transition("unknown", `${ORPHANED_REASON} (${liveness.reason})`, true);
  } finally {
    writer.close();
  }
}

/** The derived run for one run directory; null when the run is not established (no event 1). */
export function showRunAt(dir: string, options: ShowOptions = {}): ShownRun | null {
  const record = readRecord(dir);
  let liveness = checkLiveness(dir, options);
  let log = readLog(dir, record.id);
  const derive = () =>
    deriveRun({
      record,
      events: log.events,
      alive: liveness.alive,
      controllable: options.controllable ?? false,
      now: nowIso(options.clock),
      goneReason: liveness.reason,
    });
  let derived = derive();
  if (derived?.orphaned && options.settle) {
    settleOrphan(dir, record.id, options);
    liveness = checkLiveness(dir, options);
    log = readLog(dir, record.id);
    derived = derive();
  }
  return derived === null ? null : { ...derived, liveness };
}

export function showRun(stateDir: string, runId: RunId, options: ShowOptions = {}): ShownRun | null {
  return showRunAt(runDir(stateDir, runId), options);
}

export interface ListOptions extends Omit<ShowOptions, "controllable"> {
  state?: RunState;
  agentId?: string;
  limit?: number;
  /** Which runs the caller holds live control of. */
  controllable?: (runId: RunId) => boolean;
}

/** Derived runs, newest first by `created_at`, filtered and limited (README: runs.list). */
export function listRuns(stateDir: string, options: ListOptions = {}): Run[] {
  const runs: Run[] = [];
  for (const id of listRunIds(stateDir)) {
    const shown = showRunAt(runDir(stateDir, id), { ...options, controllable: options.controllable?.(id) ?? false });
    if (shown === null) continue;
    if (options.state !== undefined && shown.run.state !== options.state) continue;
    if (options.agentId !== undefined && shown.run.agent_id !== options.agentId) continue;
    runs.push(shown.run);
  }
  runs.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));
  return runs.slice(0, options.limit ?? 50);
}

export interface EventsPage {
  events: RunEvent[];
  /** The log's newest cursor at read time. */
  lastCursor: number;
  /** True when events after the last returned one exist. */
  more: boolean;
}

/** Events with cursor greater than `after`, ascending, at most `limit` (README: runs.logs). */
export function readEvents(dir: string, runId: RunId, after = 0, limit = 500): EventsPage {
  const log = readLog(dir, runId);
  if (!Number.isInteger(after) || after < 0 || after > log.tail.cursor) {
    throw new RangeError(`after ${after} is past the run's cursor ${log.tail.cursor}`);
  }
  const rest = log.events.slice(after);
  return { events: rest.slice(0, limit), lastCursor: log.tail.cursor, more: rest.length > limit };
}

export interface FollowOptions extends LivenessOptions {
  signal?: AbortSignal;
  /** Poll interval while idle. Default 20 ms. */
  pollMs?: number;
  /**
   * While idle, check the worker every this many ms and settle an orphaned run (append
   * `unknown`) so the stream ends honestly. 0 disables. Default 250 ms.
   */
  orphanCheckMs?: number;
}

/**
 * Every event with cursor greater than `after`, then live events as they are appended, with no
 * gap and no duplicate. Ends right after the terminal `run.state` event, or when `signal` aborts.
 */
export async function* followEvents(dir: string, runId: RunId, after = 0, options: FollowOptions = {}): AsyncGenerator<RunEvent> {
  const pollMs = options.pollMs ?? 20;
  const orphanCheckMs = options.orphanCheckMs ?? 250;
  let pos = 0;
  let pending = Buffer.alloc(0);
  let tail: LogTail = { cursor: 0, state: null };
  let lastOrphanCheck = Date.now();
  const path = runFile(dir, "events");
  while (!options.signal?.aborted) {
    let chunk = Buffer.alloc(0);
    try {
      const fh = await open(path, "r");
      try {
        const { size } = await fh.stat();
        if (size > pos) {
          chunk = Buffer.alloc(size - pos);
          const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
          chunk = chunk.subarray(0, bytesRead);
          pos += bytesRead;
        }
      } finally {
        await fh.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    pending = Buffer.concat([pending, chunk]);
    let nl: number;
    while ((nl = pending.indexOf(0x0a)) >= 0) {
      const line = pending.subarray(0, nl).toString("utf8");
      pending = pending.subarray(nl + 1);
      const next = checkNext(runId, tail, JSON.parse(line), tail.cursor + 1);
      tail = next.tail;
      if (next.event.cursor > after) yield next.event;
      if (tail.state !== null && isTerminal(tail.state)) return;
    }
    if (chunk.length === 0) {
      if (orphanCheckMs > 0 && Date.now() - lastOrphanCheck >= orphanCheckMs) {
        lastOrphanCheck = Date.now();
        // A torn tail left by a dead worker is dropped by the writer; restart reading from the
        // last complete line so the settled event is read cleanly.
        if (settleOrphan(dir, runId, options) !== null && pending.length > 0) {
          pos -= pending.length;
          pending = Buffer.alloc(0);
        }
      }
      try {
        await delay(pollMs, undefined, options.signal ? { signal: options.signal } : {});
      } catch {
        return;
      }
    }
  }
}
