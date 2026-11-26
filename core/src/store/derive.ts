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
import { pendingQuestions } from "./questions.js";

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

/** What the `run.state` events of a log say: the last state and its reason, when the run first ran, when it last ended. */
interface Lifecycle {
  state: RunState | null;
  reason: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

function recordedLifecycle(events: readonly RunEvent[]): Lifecycle {
  const seen: Lifecycle = { state: null, reason: null, startedAt: null, endedAt: null };
  for (const event of events) {
    if (event.kind !== "run.state") continue;
    const data = event.data as StateData;
    seen.state = data.to;
    seen.reason = data.reason;
    if (data.to === "running" && seen.startedAt === null) seen.startedAt = event.time;
    if (isTerminal(data.to)) seen.endedAt = event.time;
  }
  return seen;
}

/**
 * Derive the reported run. Returns null for a run whose log has no event at all: its worker
 * never wrote event 1, so the submit was never acknowledged and the run is not established.
 */
export function deriveRun(input: DeriveInput): DerivedRun | null {
  const { record, events } = input;
  const last = events.at(-1);
  if (last === undefined) return null;
  const recorded = recordedLifecycle(events);
  const startedAt = recorded.startedAt;
  let { state, reason, endedAt } = recorded;
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
    // Read from the log, so a question is still pending after a core restart; none on a terminal run.
    pending_questions: terminal ? [] : pendingQuestions(events),
    live_control: !terminal && input.alive && input.controllable,
  };
  return { run: assertValid("run", run), orphaned };
}
