/**
 * The retention record of a run (`retained.json` in the run directory). A run whose turn
 * completed but whose work could not be brought to the host keeps its sandbox, the only copy of
 * that work, for a limited time. The worker writes the record before the run's terminal event;
 * the daemon's reclaim of finished runs reads it and leaves the sandbox alone until it expires.
 */
import { readFileSync, statSync } from "node:fs";

import { atomicWriteJson, runFile } from "../store/files.js";
import { RETAIN_FAILED_SANDBOX_DAYS, type Retained } from "./driver.js";

const DAY_MS = 86_400_000;

/** Record the retention durably. Called before the run's terminal event is written. */
export function writeRetained(dir: string, retained: Retained): void {
  atomicWriteJson(runFile(dir, "retained"), { sandbox: retained.sandbox, until: retained.until }, true);
}

/**
 * The run's retention, or null when it has none. `until` is in epoch milliseconds. A record that
 * exists but cannot be read counts as a retention for the default period from when the file was
 * written (`sandbox` is then null): work is not lost to a damaged record, and nothing is kept
 * forever because of one.
 */
export function readRetained(dir: string): { sandbox: string | null; until: number } | null {
  const file = runFile(dir, "retained");
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { sandbox?: unknown; until?: unknown } | null;
    const until = typeof value?.until === "string" ? Date.parse(value.until) : Number.NaN;
    if (typeof value?.sandbox === "string" && Number.isFinite(until)) return { sandbox: value.sandbox, until };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
  }
  try {
    return { sandbox: null, until: statSync(file).mtimeMs + RETAIN_FAILED_SANDBOX_DAYS * DAY_MS };
  } catch {
    return null;
  }
}
