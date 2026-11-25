/**
 * Steer and cancel: steps 5 to 9 of the control order (contract/README.md). The server has already
 * checked the version header, the run id, that the run exists, the body, and the deferred actions.
 *
 * 5. the run's harness capability document supports the action, else `unsupported` naming it;
 * 6. the state allows it, else `conflict` (`steer` needs `running`; `cancel` needs an active state);
 * 7. live control (false after a core restart), else `unsupported`, capability `reconnect`;
 * 8. delivery over the worker's control channel, else `unavailable`;
 * 9. the accepted action record (the worker appends it to the log as `run.control`).
 *
 * Refusals at 5 and 6 against a non-terminal run whose worker this core controls are also written
 * to the run's log as `run.refused`, by the worker (the log's only writer while it lives). A refused
 * action is never forwarded to the harness.
 */
import {
  buildActionId,
  type AcceptedResponse,
  isActive,
  newUlid,
  type ActionRecord,
  type CancelRequest,
  type Capabilities,
  type ErrorBody,
  type Run,
  type SteerRequest,
} from "../contract/index.js";
import { ControlError, unavailable, unsupported } from "../daemon/errors.js";
import { ControlUnavailableError, type ControlReply } from "../worker/control.js";
import type { WorkerControl } from "../worker/spawn.js";

export type ControlKind = "steer" | "cancel";

export interface ControlTarget {
  run: Run;
  /** The run's harness capability document; null when the harness is no longer in the catalog. */
  capabilities: Capabilities | null;
  /** This core's live control of the run's worker; null after a restart or once the worker is gone. */
  worker: WorkerControl | null;
  now: () => Date;
}

function record(run: Run, kind: ControlKind, request: SteerRequest | CancelRequest, now: () => Date): ActionRecord {
  return {
    id: buildActionId(run.agent_id, newUlid(now().getTime())),
    run_id: run.id,
    kind,
    caller: request.caller,
    requested_at: now().toISOString(),
    idempotency_key: request.idempotency_key ?? null,
    outcome: "accepted",
    error: null,
  };
}

/** Step 5: the capability refusal, or null. An unverifiable capability counts as unsupported. */
function capabilityRefusal(kind: ControlKind, target: ControlTarget): ControlError | null {
  const capability = target.capabilities?.capabilities[kind];
  if (capability?.supported) return null;
  const why = target.capabilities === null ? `harness ${target.run.harness} is not known to this core` : (capability?.reason ?? "not supported");
  return unsupported(kind, `The ${target.run.harness} harness does not support ${kind}: ${why}.`);
}

/** Step 6: the state refusal, or null. */
function stateRefusal(kind: ControlKind, run: Run): ControlError | null {
  if (kind === "steer" && run.state !== "running") {
    return new ControlError("conflict", `A steer needs a running run; run ${run.id} is ${run.state}.`, { run_id: run.id, retryable: run.state === "queued" });
  }
  if (kind === "cancel" && !isActive(run.state)) {
    return new ControlError("conflict", `A cancel needs an active run; run ${run.id} is ${run.state}.`, { run_id: run.id, retryable: false });
  }
  return null;
}

/** Have the worker write `run.refused`; a failure to record never changes the refusal itself. */
async function recordRefusal(target: ControlTarget, action: ActionRecord, error: ControlError): Promise<void> {
  if (target.worker === null || target.run.terminal) return;
  try {
    await target.worker.refuse({ ...action, outcome: "refused", error: error.body });
  } catch {
    // The worker is unreachable or already done; the caller still gets the typed refusal.
  }
}

function replyError(run: Run, reply: ControlReply): ControlError | null {
  if (reply.ok) return null;
  const body: ErrorBody = reply.error;
  // The worker re-checks state; a race (the run moved on) comes back as its own `conflict`.
  if (body.code === "conflict") return new ControlError("conflict", body.message, { run_id: run.id, retryable: body.retryable });
  return unavailable(`The worker of run ${run.id} did not accept the action: ${body.message}`);
}

/** Run steps 5 to 9 for one action and return the accepted record, or throw the typed refusal. */
export async function control(kind: ControlKind, target: ControlTarget, request: SteerRequest | CancelRequest): Promise<AcceptedResponse["action"]> {
  const { run } = target;
  const action = record(run, kind, request, target.now);
  const refusal = capabilityRefusal(kind, target) ?? stateRefusal(kind, run);
  if (refusal !== null) {
    await recordRefusal(target, action, refusal);
    throw refusal;
  }
  if (!run.live_control || target.worker === null) {
    throw unsupported("reconnect", `Run ${run.id} survived a core restart; this core cannot reconnect to its worker, so live control is unavailable.`);
  }
  let reply: ControlReply;
  try {
    reply =
      kind === "steer"
        ? await target.worker.steer(action, (request as SteerRequest).message)
        : await target.worker.cancel(action, (request as CancelRequest).reason);
  } catch (err) {
    if (err instanceof ControlUnavailableError) throw unavailable(`The worker of run ${run.id} did not answer: ${err.message}. The ${kind} may still take effect; check the run's events before sending it again.`);
    throw err;
  }
  const failed = replyError(run, reply);
  if (failed !== null) throw failed;
  return { ...action, outcome: "accepted" };
}
