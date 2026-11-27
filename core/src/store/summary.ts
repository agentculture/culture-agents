/**
 * A per-run summary of a finished run (`summary.json`): its derived record plus a digest of the
 * event log it was derived from. It is a cache. The event log stays the source of truth, so a
 * summary that is missing, unreadable, invalid or stale is ignored and the run is derived from its
 * log again, which writes a fresh summary. Deleting it changes no listing. Only terminal runs get
 * one: a run that may still change is always read from its log.
 *
 * A summary is believed only when all of these hold, each checked without parsing the whole log:
 *
 * - its run id is the directory's run id;
 * - the log's digest is unchanged: size, inode, modification and change time (nanoseconds), and
 *   a SHA-256 of its final bytes (up to `TAIL_BYTES`). The log is append-only and a finished run's
 *   log is never written again, so any later write changes the size or the times; an edit that
 *   keeps the size and resets the modification time still moves the change time, which only the
 *   kernel sets; and the hash catches a same-size rewrite of the end within one clock tick;
 * - the log's last complete line is the terminal `run.state` event the summary says: same run id,
 *   cursor, state, reason and time (`ended_at` and `updated_at`). An edited summary that keeps the
 *   digest still cannot claim another state or end time than the log.
 *
 * What remains is a same-size rewrite of an earlier line within the clock tick the summary was
 * written in. Retention never deletes on the summary's word: it re-derives the run from the log.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";

import { validate, type Run, type StateData } from "../contract/index.js";
import { atomicWriteJson, runFile } from "./files.js";

// 2: a version-1 summary carried only the log's size, and could hold a succeeded run without the
// branch its record holds (pr-15 finding 19). No version-1 summary is believed.
const SUMMARY_VERSION = 2;
/** How much of the end of the log is hashed and searched for the terminal event. */
export const TAIL_BYTES = 4096;

interface LogDigest {
  bytes: number;
  ino: string;
  mtime_ns: string;
  ctime_ns: string;
  tail_sha256: string;
}

interface Summary {
  summary_version: number;
  log: LogDigest;
  run: Run;
}

interface LogEnd {
  digest: LogDigest;
  /** The last complete line, or null when the final bytes hold no whole line. */
  lastLine: string | null;
}

function readTail(path: string, size: number): Buffer {
  const length = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buf, 0, length, size - length);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** The last newline-terminated line of `tail`, when it starts inside `tail` (or the tail is the whole file). */
function lastCompleteLine(tail: Buffer, wholeFile: boolean): string | null {
  const end = tail.lastIndexOf(0x0a);
  if (end < 0) return null;
  const start = tail.lastIndexOf(0x0a, end - 1);
  if (start < 0 && !wholeFile) return null;
  return tail.subarray(start + 1, end).toString("utf8");
}

/** The log's digest and its last complete line; null when the log is missing or cannot be read. */
function logEnd(dir: string): LogEnd | null {
  const path = runFile(dir, "events");
  try {
    const st = statSync(path, { bigint: true });
    const size = Number(st.size);
    const tail = readTail(path, size);
    const digest: LogDigest = {
      bytes: size,
      ino: st.ino.toString(),
      mtime_ns: st.mtimeNs.toString(),
      ctime_ns: st.ctimeNs.toString(),
      tail_sha256: createHash("sha256").update(tail).digest("hex"),
    };
    return { digest, lastLine: lastCompleteLine(tail, size <= TAIL_BYTES) };
  } catch {
    return null;
  }
}

function sameDigest(a: Partial<LogDigest> | undefined, b: LogDigest): boolean {
  return a?.bytes === b.bytes && a.ino === b.ino && a.mtime_ns === b.mtime_ns && a.ctime_ns === b.ctime_ns && a.tail_sha256 === b.tail_sha256;
}

/** True when `line` is the terminal `run.state` event that `run` reports. */
function endsAs(line: string | null, run: Run): boolean {
  if (line === null) return false;
  const event = validate("event", JSON.parse(line));
  if (!event.ok) return false;
  const { run_id, cursor, kind, time } = event.value;
  if (kind !== "run.state" || run_id !== run.id || cursor !== run.cursor) return false;
  const data = event.value.data as StateData;
  return data.to === run.state && data.reason === run.state_reason && time === run.ended_at && time === run.updated_at;
}

/** The cached terminal run, or null when there is no usable, current summary. Never parses the whole event log. */
export function readSummary(dir: string, readFile: (path: string) => Buffer = readFileSync): Run | null {
  try {
    const end = logEnd(dir);
    if (end === null) return null;
    const value = JSON.parse(readFile(runFile(dir, "summary")).toString("utf8")) as Partial<Summary> | null;
    if (value?.summary_version !== SUMMARY_VERSION || !sameDigest(value.log, end.digest)) return null;
    const checked = validate("run", value.run);
    if (!checked.ok) return null;
    const run = checked.value as Run;
    if (!run.terminal || run.id !== basename(dir) || !endsAs(end.lastLine, run)) return null;
    return run;
  } catch {
    return null;
  }
}

/** Write the summary of a terminal run; a failure to write is ignored (the cache is optional). */
export function writeSummary(dir: string, run: Run): void {
  if (!run.terminal) return;
  try {
    const end = logEnd(dir);
    if (end === null || !endsAs(end.lastLine, run)) return;
    atomicWriteJson(runFile(dir, "summary"), { summary_version: SUMMARY_VERSION, log: end.digest, run } satisfies Summary);
  } catch {
    // a cache that cannot be written costs one log read next time
  }
}
