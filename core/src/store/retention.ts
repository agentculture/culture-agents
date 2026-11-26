/**
 * Retention of finished run directories (contract/README.md: "Retention of finished runs"). A
 * directory is removed only when every one of these holds; any doubt keeps it:
 *
 * - its state is known and finished: the log ends in `succeeded`, `failed` or `cancelled`
 *   (`unknown`, an unreadable run and a run that may still be working are never removed);
 * - its sandbox is not retained: `retained.json` is absent, or its `until` is past;
 * - the retention period has passed since the later of its end and its sandbox retention's end.
 *
 * With no retention period configured nothing is removed.
 */
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";

import { runDir, runFile } from "./files.js";
import { checkLiveness } from "./liveness.js";
import { listRunIds, showRunAt } from "./run-store.js";

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

/** The end of a sandbox retention; a record that exists but cannot be read counts as retained until a day past its file time. */
function retainedUntilOf(dir: string): number | null {
  const file = runFile(dir, "retained");
  if (!existsSync(file)) return null;
  try {
    const until = Date.parse((JSON.parse(readFileSync(file, "utf8")) as { until?: string }).until ?? "");
    if (Number.isFinite(until)) return until;
  } catch {
    // fall through
  }
  return statSync(file).mtimeMs + 7 * DAY_MS;
}

/** Remove the finished run directories the rule allows. Returns the removed run ids. */
export function pruneFinishedRuns(stateDir: string, options: RetentionOptions): string[] {
  if (options.retentionMs === null || options.retentionMs <= 0) return [];
  const now = (options.now ?? Date.now)();
  const removed: string[] = [];
  for (const id of listRunIds(stateDir)) {
    const dir = runDir(stateDir, id);
    try {
      if (checkLiveness(dir).alive) continue;
      const shown = showRunAt(dir, { ...(options.readFile && { readFile: options.readFile }) });
      const run = shown?.run;
      if (!run || shown.orphaned || !run.terminal || run.state === "unknown" || run.ended_at === null) continue;
      const until = (options.retainedUntil ?? retainedUntilOf)(dir);
      const since = Math.max(Date.parse(run.ended_at), until ?? 0);
      if (!Number.isFinite(since) || now < since + options.retentionMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(id);
    } catch {
      // state unknown: the directory is kept
    }
  }
  return removed;
}
