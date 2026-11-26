/**
 * A per-run summary of a finished run (`summary.json`): its derived record plus the size of the
 * event log it was derived from. It is a cache. The event log stays the source of truth, so a
 * summary that is missing, unreadable, invalid or stale (the log's size differs) is ignored and the
 * run is derived from its log again, which writes a fresh summary. Deleting it changes no listing.
 * Only terminal runs get one: a run that may still change is always read from its log.
 */
import { readFileSync, statSync } from "node:fs";

import { validate, type Run } from "../contract/index.js";
import { atomicWriteJson, runFile } from "./files.js";

const SUMMARY_VERSION = 1;

interface Summary {
  summary_version: number;
  log_bytes: number;
  run: Run;
}

function logBytes(dir: string): number | null {
  try {
    return statSync(runFile(dir, "events")).size;
  } catch {
    return null;
  }
}

/** The cached terminal run, or null when there is no usable, current summary. Never reads the event log. */
export function readSummary(dir: string, readFile: (path: string) => Buffer = readFileSync): Run | null {
  try {
    const size = logBytes(dir);
    if (size === null) return null;
    const value = JSON.parse(readFile(runFile(dir, "summary")).toString("utf8")) as Partial<Summary> | null;
    if (value?.summary_version !== SUMMARY_VERSION || value.log_bytes !== size) return null;
    const run = validate("run", value.run);
    return run.ok && (run.value as Run).terminal ? (run.value as Run) : null;
  } catch {
    return null;
  }
}

/** Write the summary of a terminal run; a failure to write is ignored (the cache is optional). */
export function writeSummary(dir: string, run: Run): void {
  const size = logBytes(dir);
  if (size === null || !run.terminal) return;
  try {
    atomicWriteJson(runFile(dir, "summary"), { summary_version: SUMMARY_VERSION, log_bytes: size, run } satisfies Summary);
  } catch {
    // a cache that cannot be written costs one log read next time
  }
}
