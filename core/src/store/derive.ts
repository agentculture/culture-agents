/**
 * The reported state of a run, derived only from its on-disk event log and its worker's
 * liveness (README: "The state of a run is derived only from its on-disk event log or its live
 * worker"). The rule:
 *
 * - a terminal `run.state` is in the log: that state;
 * - no terminal event and the worker is alive: the last recorded state;
 * - no terminal event and no live worker: `unknown` (never `succeeded`). The log does not yet
 *   say so; `orphaned` tells the caller (the core, now the log's only writer) to append it.
 *
 * Pure: no I/O, the clock is a parameter.
 */
import { assertValid, isTerminal, type Run, type RunEvent, type RunState, type StateData } from "../contract/index.js";

export interface DeriveInput {
  /** The run record as stored (identity, task, owner, deadline, ...). Its state fields are ignored. */
  record: Run;
  /** The complete, validated event log. */
  events: readonly RunEvent[];
  /** Whether the run's recorded worker is alive now. */
  alive: boolean;
  /** Whether the caller can deliver steer and cancel to that worker right now. */
  controllable: boolean;
  /** Timestamp used for `ended_at`/`updated_at` of an orphaned run. */
  now: string;
  /** Why the worker is considered gone (used in the orphaned reason). */
  goneReason?: string;
}

export interface DerivedRun {
  run: Run;
  /** True when the run reads `unknown` but the log has no `unknown` event yet. */
  orphaned: boolean;
}

/** The reason recorded when a run without a terminal event has no live worker. */
export const ORPHANED_REASON = "worker exited without a terminal event";

/**
 * Derive the reported run. Returns null for a run whose log has no event at all: its worker
 * never wrote event 1, so the submit was never acknowledged and the run is not established.
 */
export function deriveRun(input: DeriveInput): DerivedRun | null {
  const { record, events } = input;
  const last = events[events.length - 1];
  if (last === undefined) return null;
  let state: RunState | null = null;
  let reason: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  for (const event of events) {
    if (event.kind !== "run.state") continue;
    const data = event.data as StateData;
    state = data.to;
    reason = data.reason;
    if (data.to === "running" && startedAt === null) startedAt = event.time;
    if (isTerminal(data.to)) endedAt = event.time;
  }
  if (state === null) return null;
  let updatedAt = last.time;
  let orphaned = false;
  if (!isTerminal(state) && !input.alive) {
    orphaned = true;
    state = "unknown";
    reason = input.goneReason ? `${ORPHANED_REASON} (${input.goneReason})` : ORPHANED_REASON;
    endedAt = input.now;
    updatedAt = input.now;
  }
  const terminal = isTerminal(state);
  const run: Run = {
    ...record,
    state,
    state_reason: reason,
    terminal,
    updated_at: updatedAt,
    started_at: startedAt,
    ended_at: terminal ? endedAt : null,
    cursor: last.cursor,
    live_control: !terminal && input.alive && input.controllable,
  };
  return { run: assertValid("run", run), orphaned };
}
