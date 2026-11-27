/**
 * Reading a run's event log for publishing, and the on-disk record of how far a run is published.
 *
 * The reader takes only what is published from each line: run id, cursor, time, kind and, for a
 * state transition, the new state. It never keeps or returns the rest of a line. Like every reader
 * of the log it counts only newline-terminated lines, so a torn final line is not an event.
 *
 * The position is `<run directory>/published.json`: the cursor of the last event the broker
 * acknowledged, the byte offset just past that event's line, and the run's state at that point.
 * The log is append-only (only a torn tail is ever truncated), so the offset stays valid; it is
 * checked all the same, and a position that does not match the log is replaced by a read from the
 * start that still skips nothing past the recorded cursor.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson, runFile } from "../store/files.js";
import type { RunFact } from "./envelope.js";

/** File name of the publish position inside a run directory. */
export const POSITION_FILE = "published.json";

export interface PublishPosition {
  /** Cursor of the last published event; 0 when nothing is published. */
  cursor: number;
  /** Byte offset in the log just past that event's line. */
  offset: number;
  /** The run's state after that event; null before event 1. */
  state: string | null;
}

export const START: PublishPosition = Object.freeze({ cursor: 0, offset: 0, state: null });

/** The log cannot be published past this point: a complete line breaks a rule of the log. */
export class LogHeldError extends Error {
  override readonly name = "LogHeldError";
}

/** The recorded position; `START` when the file is absent or does not hold a usable position. */
export function readPosition(dir: string): PublishPosition {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(dir, POSITION_FILE), "utf8"));
  } catch {
    return START;
  }
  if (value === null || typeof value !== "object") return START;
  const { cursor, offset, state } = value as Record<string, unknown>;
  const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!whole(cursor) || !whole(offset) || !(state === null || typeof state === "string")) return START;
  if ((cursor === 0) !== (offset === 0) || (cursor === 0) !== (state === null)) return START;
  return { cursor, offset, state };
}

/** Record the position (0600, replaced atomically). */
export function writePosition(dir: string, position: PublishPosition): void {
  atomicWriteJson(join(dir, POSITION_FILE), { cursor: position.cursor, offset: position.offset, state: position.state });
}

/** One event to publish, with the position that holds once it is published. */
export interface PendingFact {
  fact: RunFact;
  after: PublishPosition;
}

const CHUNK = 256 * 1024;

/** Bytes of the log from `offset` up to its last newline, at most about `CHUNK` unless one line is longer. */
function readLines(fd: number, offset: number, size: number): Buffer {
  let want = Math.min(CHUNK, size - offset);
  for (;;) {
    const buf = Buffer.alloc(want);
    const got = readSync(fd, buf, 0, want, offset);
    const end = buf.subarray(0, got).lastIndexOf(0x0a) + 1;
    if (end > 0 || offset + got >= size || got < want) return buf.subarray(0, end);
    want = Math.min(want * 2, size - offset); // one line longer than the chunk: read more of it
  }
}

function factOf(runId: string, line: string, previous: PublishPosition): RunFact {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new LogHeldError(`the line after cursor ${previous.cursor} is not JSON`);
  }
  if (value === null || typeof value !== "object") throw new LogHeldError(`the line after cursor ${previous.cursor} is not an event`);
  const { run_id, cursor, time, kind, data } = value as Record<string, unknown>;
  if (run_id !== runId) throw new LogHeldError(`the line after cursor ${previous.cursor} belongs to another run`);
  if (cursor !== previous.cursor + 1) throw new LogHeldError(`cursor ${typeof cursor === "number" ? cursor : "?"} follows cursor ${previous.cursor}`);
  if (typeof time !== "string" || typeof kind !== "string") throw new LogHeldError(`event ${previous.cursor + 1} has no time or kind`);
  let state = previous.state;
  if (kind === "run.state") {
    const to = data !== null && typeof data === "object" ? (data as Record<string, unknown>)["to"] : undefined;
    if (typeof to !== "string") throw new LogHeldError(`event ${previous.cursor + 1} is a state transition without a state`);
    state = to;
  }
  if (state === null) throw new LogHeldError("the first event is not a state transition");
  return { run_id: runId, kind, state, cursor: previous.cursor + 1, time };
}

/** The run's event log, open for reading, or null when it has none yet. */
function openLog(dir: string): number | null {
  try {
    return openSync(runFile(dir, "events"), "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The events of `buf` (whole lines read at `from`) into `out`, up to `max`. Returns the position
 * after the last line read, or null when a line that breaks a rule of the log ends the read after
 * some events: those are published, and the next call reports the line.
 */
function readChunk(runId: string, buf: Buffer, from: PublishPosition, skipThrough: number, out: PendingFact[], max: number): PublishPosition | null {
  let at = from;
  let start = 0;
  while (out.length < max && start < buf.length) {
    const end = buf.indexOf(0x0a, start);
    let fact: RunFact;
    try {
      fact = factOf(runId, buf.subarray(start, end).toString("utf8"), at);
    } catch (err) {
      if (out.length > 0 && err instanceof LogHeldError) return null; // publish what precedes it; the next call reports it
      throw err;
    }
    at = { cursor: fact.cursor, offset: at.offset + (end + 1 - start), state: fact.state };
    if (fact.cursor > skipThrough) out.push({ fact, after: at });
    start = end + 1;
  }
  return at;
}

/**
 * Up to `max` events after `from`, in cursor order. A complete line that breaks a rule of the log
 * ends the read: the events before it are returned, and the call that finds it first throws
 * `LogHeldError`. Nothing after it is ever returned.
 */
function readFrom(dir: string, runId: string, from: PublishPosition, skipThrough: number, max: number): PendingFact[] {
  const fd = openLog(dir);
  if (fd === null) return [];
  try {
    const size = fstatSync(fd).size;
    if (from.offset > size) throw new LogHeldError(`the log is shorter than the recorded offset ${from.offset}`);
    const out: PendingFact[] = [];
    let at = from;
    while (out.length < max && at.offset < size) {
      const buf = readLines(fd, at.offset, size);
      if (buf.length === 0) break; // only a torn tail is left
      const next = readChunk(runId, buf, at, skipThrough, out, max);
      if (next === null) return out;
      at = next;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/**
 * The next events to publish after `position`, at most `max`. A position whose offset does not
 * match the log (the file was edited, or the position is damaged) is not trusted: the log is read
 * from its start and events up to `position.cursor` are passed over, so none is skipped.
 */
export function pendingFacts(dir: string, runId: string, position: PublishPosition, max: number): PendingFact[] {
  if (position.offset === 0) return readFrom(dir, runId, START, position.cursor, max);
  try {
    return readFrom(dir, runId, position, position.cursor, max);
  } catch (err) {
    if (!(err instanceof LogHeldError)) throw err;
    return readFrom(dir, runId, START, position.cursor, max);
  }
}
