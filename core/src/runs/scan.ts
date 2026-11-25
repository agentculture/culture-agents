/**
 * Store reads for the run service. Every run reported here is derived from its on-disk event log
 * and its worker's liveness (`deriveRun`); nothing is inferred another way. Reads settle an
 * orphaned run (no live worker, no terminal event) by appending `unknown`, because the core is
 * then the log's only writer (README: `unknown`).
 */
import { existsSync, readFileSync } from "node:fs";

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
import { runDir, runFile } from "../store/files.js";
import { checkLiveness } from "../store/liveness.js";
import { listRunIds, showRunAt } from "../store/run-store.js";

export interface ScanOptions {
  stateDir: string;
  /** Whether this core holds live control of the run's worker. */
  controllable: (runId: RunId) => boolean;
  /** Where to report a run that cannot be read (corrupt log or record). */
  warn: (line: string) => void;
}

/** A run directory exists but its record or log cannot be read. The run is not "absent": it is unreadable. */
export class UnreadableRunError extends Error {
  override readonly name = "UnreadableRunError";
  constructor(
    readonly runId: string,
    readonly detail: string,
  ) {
    super(`run ${runId} cannot be read: ${detail}`);
  }
}

/**
 * One run as stored now, settling it when orphaned; null when unknown or not established. A run
 * whose stored state cannot be read is skipped with a warning, or thrown as `UnreadableRunError`
 * with `strict` (a caller asking for that one run must not be told it does not exist).
 */
export function readRun(options: ScanOptions, runId: string, strict = false): Run | null {
  if (!isRunId(runId)) return null;
  const dir = runDir(options.stateDir, runId);
  if (!existsSync(dir)) return null;
  try {
    return showRunAt(dir, { controllable: options.controllable(runId), settle: true })?.run ?? null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (strict) throw new UnreadableRunError(runId, detail);
    options.warn(`culture-agents core: run ${runId} cannot be read: ${detail}`);
    return null;
  }
}

/**
 * An unreadable run that may still be working in `repo`: its worker is alive, and its record names
 * this repository or cannot be read either. Such a run keeps the repository busy; treating it as
 * absent would let a second worker into the same repository.
 */
export function unreadableRunHolding(options: ScanOptions, repo: string): string | null {
  for (const id of listRunIds(options.stateDir)) {
    const dir = runDir(options.stateDir, id);
    try {
      showRunAt(dir, { controllable: false, settle: false });
      continue;
    } catch {
      // unreadable: decided below
    }
    let alive = true;
    try {
      alive = checkLiveness(dir).alive;
    } catch {
      // liveness unknown counts as alive
    }
    if (!alive) continue;
    let recorded: unknown;
    try {
      recorded = (JSON.parse(readFileSync(runFile(dir, "record"), "utf8")) as { repo?: unknown }).repo;
    } catch {
      return id;
    }
    if (typeof recorded !== "string" || recorded === repo) return id;
  }
  return null;
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

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The commits the worker recorded for a run's branch, oldest first; empty when none were recorded or the file is unusable. */
function collectedCommits(dir: string, branch: string | null): string[] {
  if (branch === null) return [];
  try {
    const value = JSON.parse(readFileSync(runFile(dir, "collected"), "utf8")) as { branch?: unknown; commits?: unknown };
    if (value.branch !== branch || !Array.isArray(value.commits)) return [];
    return value.commits.every((c) => typeof c === "string" && SHA.test(c)) ? (value.commits as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * The outcome of a terminal run, from its log. `summary` is the concatenation of the harness's
 * `text` output deltas (null when there were none); `error` is the last fatal `run.error`, and a
 * `failed` run without one reports its state reason as `internal`. `branch` and `commits` are what
 * the worker recorded when it collected the run's commits; a run that collected none has neither.
 */
export function resultOf(options: ScanOptions, run: Run): RunResult {
  const dir = runDir(options.stateDir, run.id);
  const log = readLog(dir, run.id);
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
    commits: collectedCommits(dir, run.branch),
    ended_at: run.ended_at ?? run.updated_at,
    error,
  } as RunResult; // `state` is a union value here; TS cannot correlate it with the `error` variants
}
