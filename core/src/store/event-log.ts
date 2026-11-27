/**
 * The append-only event log of one run (`events.jsonl`) and its cursor file.
 *
 * - Only newline-terminated lines count. A final segment without a newline is a torn append
 *   (a crash mid-write): readers ignore it and the next writer truncates it before appending,
 *   so earlier events are kept and no state is invented.
 * - Every complete line must validate against `event.json`, carry the run's id, continue the
 *   cursor (1, 2, 3, ...) and, for `run.state`, make a legal transition from the previous
 *   state. A broken line before the end is corruption and is reported, never skipped.
 * - There is exactly one writer at a time: the worker while it lives, the core afterwards.
 */
import { closeSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, writeSync } from "node:fs";

import {
  assertValid,
  canTransition,
  isTerminal,
  validate,
  type ActionRecord,
  type AnswerData,
  type ControlData,
  type ErrorData,
  type EventKind,
  type OutputData,
  type QuestionData,
  type RefusedData,
  type RunEvent,
  type RunId,
  type RunState,
  type StateData,
} from "../contract/index.js";
import { FILE_MODE, atomicWrite, runFile } from "./files.js";

/** The event log breaks a contract rule somewhere other than a torn final line. */
export class EventLogCorruptError extends Error {
  constructor(
    readonly line: number,
    detail: string,
  ) {
    super(`event log line ${line}: ${detail}`);
    this.name = "EventLogCorruptError";
  }
}

/**
 * An event without its envelope bookkeeping; the writer adds run_id, cursor and time. Loosely
 * typed on purpose: `append` validates the whole event against `event.json` before writing.
 */
export interface EventInput {
  kind: EventKind;
  data: StateData | OutputData | ControlData | RefusedData | ErrorData | QuestionData | AnswerData | { action: ActionRecord };
}

/** Running summary of a log, enough to validate the next event. */
export interface LogTail {
  cursor: number;
  state: RunState | null;
}

/** Check one parsed event against the previous tail; returns the new tail. */
export function checkNext(runId: RunId, tail: LogTail, value: unknown, line: number): { event: RunEvent; tail: LogTail } {
  const result = validate("event", value);
  if (!result.ok) throw new EventLogCorruptError(line, `does not validate: ${result.issues[0]?.path} ${result.issues[0]?.message}`);
  const event = result.value;
  if (event.run_id !== runId) throw new EventLogCorruptError(line, `run_id ${event.run_id} is not ${runId}`);
  if (event.cursor !== tail.cursor + 1) throw new EventLogCorruptError(line, `cursor ${event.cursor} after ${tail.cursor}`);
  if (tail.state !== null && isTerminal(tail.state)) throw new EventLogCorruptError(line, "event after the terminal state");
  let state = tail.state;
  if (event.kind === "run.state") {
    const data = event.data as { from: RunState | null; to: RunState };
    if (data.from !== tail.state || !canTransition(data.from, data.to)) {
      throw new EventLogCorruptError(line, `illegal transition ${String(data.from)} -> ${data.to} after ${String(tail.state)}`);
    }
    state = data.to;
  } else if (tail.cursor === 0) {
    throw new EventLogCorruptError(line, "the first event must be run.state null -> queued");
  }
  return { event, tail: { cursor: event.cursor, state } };
}

/** Result of parsing a log's bytes. */
export interface ParsedLog {
  events: RunEvent[];
  tail: LogTail;
  /** Bytes of complete lines; anything after this offset is a torn append. */
  completeBytes: number;
  torn: boolean;
}

/** Parse log content. Only newline-terminated lines count; a trailing partial line is reported as torn. */
export function parseLog(runId: RunId, content: Buffer | string): ParsedLog {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const end = buf.lastIndexOf(0x0a) + 1;
  const events: RunEvent[] = [];
  let tail: LogTail = { cursor: 0, state: null };
  const text = buf.subarray(0, end).toString("utf8");
  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  lines.forEach((raw, i) => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new EventLogCorruptError(i + 1, "is not JSON");
    }
    const next = checkNext(runId, tail, value, i + 1);
    events.push(next.event);
    tail = next.tail;
  });
  return { events, tail, completeBytes: end, torn: end < buf.length };
}

/** Read and parse a run's whole log (missing file = empty log). */
export function readLog(dir: string, runId: RunId, readFile: (path: string) => Buffer = readFileSync): ParsedLog {
  let content: Buffer;
  try {
    content = readFile(runFile(dir, "events"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return parseLog(runId, "");
    throw err;
  }
  return parseLog(runId, content);
}

/** Read the cursor file; null when absent or unreadable. */
export function readCursorFile(dir: string): number | null {
  try {
    const n = Number(readFileSync(runFile(dir, "cursor"), "utf8").trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The single writer of a run's log. Opening it validates the existing log and drops a torn
 * final line. Appends are synchronous, so a crash leaves at most one torn line. `durable` appends
 * are fsynced together with the cursor file.
 *
 * A line counts only once every byte of it, newline included, is in the file. An append that fails
 * before that (a short write followed by ENOSPC, for example) leaves at most a partial line with
 * no newline, which readers already ignore as a torn tail; the writer truncates it, at once when
 * it can and otherwise before its next append, so a later line never joins onto it.
 */
export class EventLogWriter {
  private readonly fd: number;
  private tail: LogTail;
  /** Bytes of complete lines: where the next line starts. */
  private bytes: number;
  /** True when a failed append may have left bytes past `bytes`. */
  private torn = false;

  private constructor(
    private readonly dir: string,
    readonly runId: RunId,
    private readonly clock: () => number,
  ) {
    this.fd = openSync(runFile(dir, "events"), "a+", FILE_MODE);
    const size = fstatSync(this.fd).size;
    const buf = Buffer.alloc(size);
    if (size > 0) readSync(this.fd, buf, 0, size, 0);
    const parsed = parseLog(runId, buf);
    if (parsed.torn) {
      ftruncateSync(this.fd, parsed.completeBytes);
      fsyncSync(this.fd);
    }
    this.tail = parsed.tail;
    this.bytes = parsed.completeBytes;
  }

  static open(dir: string, runId: RunId, clock: () => number = Date.now): EventLogWriter {
    return new EventLogWriter(dir, runId, clock);
  }

  get cursor(): number {
    return this.tail.cursor;
  }

  get state(): RunState | null {
    return this.tail.state;
  }

  /** Drop what a failed append left after the last complete line. Throws when it cannot. */
  private repair(): void {
    if (!this.torn) return;
    ftruncateSync(this.fd, this.bytes);
    this.torn = false;
  }

  /** Write every byte of `line` (a short write is continued); on failure the partial line is dropped. */
  private writeLine(line: Buffer): void {
    let written = 0;
    try {
      while (written < line.length) {
        const n = writeSync(this.fd, line, written, line.length - written);
        if (n <= 0) throw new Error("the event log accepted no bytes");
        written += n;
      }
    } catch (err) {
      this.torn = true; // assume bytes landed even when the failing call reported none
      try {
        this.repair();
      } catch {
        // Still torn: readers ignore the partial line, and the next append repairs before it writes.
      }
      throw err;
    }
  }

  /**
   * Append one event at the next cursor; throws (and writes nothing) if it breaks the contract.
   * When the write itself fails, nothing is appended and the cursor does not advance. Once the
   * whole line is in the file the cursor advances, before the fsync: if the fsync or the cursor
   * file then fails, this throws but the event stays in the log and its cursor is never reused.
   */
  append(input: EventInput, durable = false): RunEvent {
    const candidate = {
      run_id: this.runId,
      cursor: this.tail.cursor + 1,
      time: new Date(this.clock()).toISOString(),
      kind: input.kind,
      data: input.data,
    };
    const checked = checkNext(this.runId, this.tail, assertValid("event", candidate), candidate.cursor);
    const line = Buffer.from(`${JSON.stringify(checked.event)}\n`, "utf8");
    this.repair();
    this.writeLine(line);
    this.bytes += line.length;
    this.tail = checked.tail;
    if (durable) fsyncSync(this.fd);
    atomicWrite(runFile(this.dir, "cursor"), `${checked.tail.cursor}\n`, durable);
    return checked.event;
  }

  /** Append a `run.state` transition from the current state. */
  transition(to: RunState, reason: string | null, durable = false): RunEvent {
    return this.append({ kind: "run.state", data: { from: this.tail.state, to, reason } }, durable || isTerminal(to));
  }

  close(): void {
    closeSync(this.fd);
  }
}
