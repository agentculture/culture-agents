/**
 * Settling a control request that got no reply, from the run's event log (the authoritative
 * record), never by retrying the request.
 *
 * The worker appends `run.control` (steer, cancel), `run.answer` (answer) or `run.refused` (refuse) for an action it took,
 * and it answers every request it has read before it closes its control channel. So when no reply
 * arrives:
 * - the log records this action's id: the action took effect and the worker went away before the
 *   reply reached us. It is reported as accepted.
 * - the log ends in a terminal state without it: the request never reached a live worker, and the
 *   run had already ended. It is reported as the `conflict` the worker itself would have answered.
 * - otherwise: the outcome cannot be established from here, and the original
 *   `ControlUnavailableError` stands (the core answers `unavailable`).
 */
import { isTerminal, type ActionRecord } from "../contract/index.js";
import { readLog } from "../store/event-log.js";
import { readWorkerIdentity } from "../store/liveness.js";
import type { ControlReply, ControlUnavailableError } from "./control.js";

export function settleFromLog(dir: string, action: ActionRecord, recordedAs: "run.control" | "run.refused" | "run.answer", cause: ControlUnavailableError): ControlReply {
  let log;
  try {
    log = readLog(dir, action.run_id);
  } catch {
    throw cause;
  }
  const { state, cursor } = log.tail;
  const recorded = log.events.some((e) => e.kind === recordedAs && (e.data as { action: ActionRecord }).action.id === action.id);
  if (recorded) return { ok: true, pid: readWorkerIdentity(dir)?.pid ?? 0, state, cursor };
  if (state !== null && isTerminal(state)) {
    return {
      ok: false,
      error: {
        code: "conflict",
        message: `The run is already ${state}; the ${action.kind} did not reach its worker.`,
        retryable: false,
        run_id: action.run_id,
      },
    };
  }
  throw cause;
}
