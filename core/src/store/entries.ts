/**
 * The run listing with unreadable runs kept in it. A run directory whose record, log, version or
 * liveness evidence cannot be read is reported with its id and the reason; it is never dropped
 * from the listing. It has no state, so it is never active: `activeRuns` (what a limit counts)
 * sees only runs read successfully. Reading never signals a worker.
 */
import { isActive, type Run, type RunId, type RunState } from "../contract/index.js";
import { runDir } from "./files.js";
import { listRunIds, newestFirst, showRunAt, type ShowOptions } from "./run-store.js";

export type RunEntry = { kind: "run"; run: Run } | { kind: "unreadable"; id: RunId; detail: string };

export interface EntryOptions extends Omit<ShowOptions, "controllable"> {
  state?: RunState;
  agentId?: string;
  /** Limits the readable runs only; unreadable ones are always listed. */
  limit?: number;
  controllable?: (runId: RunId) => boolean;
}

/** Unreadable runs first (by id, descending), then readable runs newest first. Runs without a first event are not listed. */
export function listRunEntries(stateDir: string, options: EntryOptions = {}): RunEntry[] {
  const runs: Run[] = [];
  const unreadable: RunEntry[] = [];
  for (const id of listRunIds(stateDir)) {
    try {
      const shown = showRunAt(runDir(stateDir, id), { ...options, controllable: options.controllable?.(id) ?? false });
      if (shown === null) continue;
      if (options.state !== undefined && shown.run.state !== options.state) continue;
      if (options.agentId !== undefined && shown.run.agent_id !== options.agentId) continue;
      runs.push(shown.run);
    } catch (err) {
      unreadable.push({ kind: "unreadable", id, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  unreadable.sort((a, b) => (a.kind === "unreadable" && b.kind === "unreadable" && a.id < b.id ? 1 : -1));
  runs.sort(newestFirst);
  return [...unreadable, ...runs.slice(0, options.limit ?? 50).map((run): RunEntry => ({ kind: "run", run }))];
}

/** The runs a limit counts: readable and active. An unreadable run is never counted. */
export function activeRuns(entries: RunEntry[]): Run[] {
  return entries.flatMap((entry) => (entry.kind === "run" && isActive(entry.run.state) ? [entry.run] : []));
}

/** Every active run in the store, read once. The capability report and the tracing gauge both count through this. */
export function activeRunList(stateDir: string): Run[] {
  return activeRuns(listRunEntries(stateDir, { limit: Number.MAX_SAFE_INTEGER }));
}
