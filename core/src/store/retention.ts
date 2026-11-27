/**
 * Retention of finished run directories (contract/README.md: "Retention of finished runs"). A
 * directory is removed only when every one of these holds; any doubt keeps it:
 *
 * - its state is known and finished: the log ends in `succeeded`, `failed`, `cancelled`,
 *   `timed_out` or `unanswered` (`unknown`, an unreadable run, a directory under a newer store
 *   schema and a run that may still be working are never removed);
 * - its sandbox is not retained: `retained.json` is absent, or its `until` is past. The record is
 *   read by `readRetained`, the reader the sandbox reclaim uses: a damaged record counts as a
 *   retention for 7 days from its file time;
 * - the retention period has passed since the later of its end and its sandbox retention's end.
 *
 * The summary cache only picks the candidates: a run is re-derived from its event log, and the
 * rule checked again on that, before its directory is deleted.
 *
 * With no retention period configured nothing is removed.
 */
import { rmSync } from "node:fs";

import { readRetained } from "../worker/retained.js";
import { runDir } from "./files.js";
import { checkLiveness } from "./liveness.js";
import { listRunIds, showRunAt, type ShownRun } from "./run-store.js";

export const DAY_MS = 86_400_000;

export interface RetentionOptions {
  /** How long a finished run's directory is kept after it ended, in milliseconds. Null or 0 keeps every run. */
  retentionMs: number | null;
  now?: () => number;
  /** When the sandbox retention of a run ends (epoch ms); null when it has none. Default reads `retained.json`. */
  retainedUntil?: (dir: string) => number | null;
  readFile?: (path: string) => Buffer;
}

/** The retention period from `CULTURE_AGENTS_RUN_RETENTION_DAYS`: default 30 days; `off` or `0` disables; an unusable value disables. */
export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env["CULTURE_AGENTS_RUN_RETENTION_DAYS"];
  if (raw === undefined || raw === "") return 30 * DAY_MS;
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : null;
}

/** The end of a sandbox retention (epoch ms), or null when the run has none. */
function retainedUntilOf(dir: string): number | null {
  return readRetained(dir)?.until ?? null;
}

/** True when the shown run may be removed under the rule at `now`. */
function expired(shown: ShownRun | null, dir: string, options: RetentionOptions, now: number): boolean {
  const run = shown?.run;
  if (!run || shown.orphaned || !run.terminal || run.state === "unknown" || run.ended_at === null) return false;
  const until = (options.retainedUntil ?? retainedUntilOf)(dir);
  const since = Math.max(Date.parse(run.ended_at), until ?? 0);
  return Number.isFinite(since) && now >= since + (options.retentionMs ?? 0);
}

/** Whether one run directory may be removed: the cheap read picks it, the read of its log decides. */
function removable(dir: string, options: RetentionOptions, now: number): boolean {
  if (checkLiveness(dir).alive) return false;
  const read = options.readFile ? { readFile: options.readFile } : {};
  if (!expired(showRunAt(dir, read), dir, options, now)) return false;
  return expired(showRunAt(dir, { ...read, fromLog: true }), dir, options, now);
}

/** Remove the finished run directories the rule allows. Returns the removed run ids. */
export function pruneFinishedRuns(stateDir: string, options: RetentionOptions): string[] {
  if (options.retentionMs === null || options.retentionMs <= 0) return [];
  const now = (options.now ?? Date.now)();
  const removed: string[] = [];
  for (const id of listRunIds(stateDir)) {
    const dir = runDir(stateDir, id);
    try {
      if (!removable(dir, options, now)) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(id);
    } catch {
      // state unknown: the directory is kept
    }
  }
  return removed;
}
