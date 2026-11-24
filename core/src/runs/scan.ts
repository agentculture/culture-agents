/**
 * Store reads for the run service. Every run reported here is derived from its on-disk event log
 * and its worker's liveness (`deriveRun`); nothing is inferred another way. Reads settle an
 * orphaned run (no live worker, no terminal event) by appending `unknown`, because the core is
 * then the log's only writer (README: `unknown`).
 */
import { existsSync } from "node:fs";

import {
  isActive,
  isRunId,
  type ErrorBody,
  type ErrorData,
  type OutputData,
  type Run,
  type RunId,
  type RunResult,
  type TerminalState,
} from "../contract/index.js";
import { readLog } from "../store/event-log.js";
import { runDir } from "../store/files.js";
import { listRunIds, showRunAt } from "../store/run-store.js";

export interface ScanOptions {
  stateDir: string;
  /** Whether this core holds live control of the run's worker. */
  controllable: (runId: RunId) => boolean;
  /** Where to report a run that cannot be read (corrupt log or record). */
  warn: (line: string) => void;
}

/** One run as stored now, settling it when orphaned; null when unknown or not established. */
export function readRun(options: ScanOptions, runId: string): Run | null {
  if (!isRunId(runId)) return null;
  const dir = runDir(options.stateDir, runId);
  if (!existsSync(dir)) return null;
  try {
    return showRunAt(dir, { controllable: options.controllable(runId), settle: true })?.run ?? null;
  } catch (err) {
    options.warn(`culture-agents core: run ${runId} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Every established run in the store, newest first by `created_at` (README: runs.list). */
export function scanRuns(options: ScanOptions): Run[] {
  const runs: Run[] = [];
  for (const id of listRunIds(options.stateDir)) {
    const run = readRun(options, id);
    if (run !== null) runs.push(run);
  }
  return runs.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));
}

/** The active run holding a canonical repository, if any. A run whose worker survived a restart counts. */
export function activeRunFor(options: ScanOptions, repo: string): Run | null {
  return scanRuns(options).find((run) => run.repo === repo && isActive(run.state)) ?? null;
}

/**
 * The outcome of a terminal run, from its log. `summary` is the concatenation of the harness's
 * `text` output deltas (null when there were none); `error` is the last fatal `run.error`, and a
 * `failed` run without one reports its state reason as `internal`.
 */
export function resultOf(options: ScanOptions, run: Run): RunResult {
  const log = readLog(runDir(options.stateDir, run.id), run.id);
  let text: string | null = null;
  let fatal: ErrorBody | null = null;
  for (const event of log.events) {
    if (event.kind === "run.output") {
      const data = event.data as OutputData;
      if (data.channel === "text" && typeof data.text === "string") text = (text ?? "") + data.text;
    } else if (event.kind === "run.error") {
      const data = event.data as ErrorData;
      if (data.fatal) fatal = data.error;
    }
  }
  const state = run.state as TerminalState;
  let error: ErrorBody | null = state === "succeeded" ? null : fatal;
  if (state === "failed" && error === null) {
    error = { code: "internal", message: run.state_reason ?? "The run failed without a recorded error.", retryable: false };
  }
  return {
    run_id: run.id,
    state,
    summary: text,
    branch: run.branch,
    commits: [],
    ended_at: run.ended_at ?? run.updated_at,
    error,
  } as RunResult;
}
