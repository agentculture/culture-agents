/**
 * `runs.answer`: steps 5 to 9 of the control order for an answer (contract README, "Order of
 * checks" and "Operator questions"). The server has already checked the version header, the run
 * id, that the run exists and the body.
 *
 * 5. the run's harness reports `answer` supported, else `unsupported` naming `answer`;
 * 6. the run is `running` (else `conflict`) and the question, read from the run's log: never asked
 *    → `not_found` with `question_id`; already answered, or past its own limit → `conflict` with
 *    `question_id`, not retryable; an answer that does not fit the question → `invalid`;
 * 7. live control, else `unavailable` with `retry_after_ms`;
 * 8. delivery to the worker, which checks the question again (it is the log's only writer, so two
 *    answers racing each other get one acceptance and one `conflict`), delivers it into the turn and
 *    appends `run.answer`;
 * 9. the accepted action record.
 *
 * Refusals at steps 5 and 6 that the contract's `run.refused` can carry (`unsupported`, `conflict`)
 * are also written to the log of a live run this core controls. Idempotency keys are recorded on the
 * action but not deduplicated for answers (README: idempotency keys); a repeated answer is refused
 * with `conflict` because the question already has its answer, so it still takes effect once.
 */
import { buildActionId, newUlid, type AcceptedResponse, type ActionRecord, type AnswerRequest, type ErrorBody } from "../contract/index.js";
import { ControlError, unavailable, unsupported } from "../daemon/errors.js";
import { readLog } from "../store/event-log.js";
import { answerFields, answerFitError, questionExpired, questionLedger } from "../store/questions.js";
import { ControlUnavailableError, type ControlReply } from "../worker/control.js";
import type { ControlTarget } from "./control.js";

const refusalOf = (code: "not_found" | "conflict" | "invalid", message: string, runId: string, questionId: string): ControlError =>
  new ControlError(code, message, { question_id: questionId, ...(code !== "invalid" && { run_id: runId }), ...(code === "conflict" && { retryable: false }) });

/** Steps 5 and 6: the refusal, or null. */
function check(target: ControlTarget, request: AnswerRequest, runDir: string): ControlError | null {
  const { run } = target;
  const capability = target.capabilities?.capabilities.answer;
  if (!capability?.supported) {
    const why = target.capabilities === null ? `harness ${run.harness} is not known to this core` : (capability?.reason ?? "not supported");
    return unsupported("answer", `The ${run.harness} harness does not support answer: ${why}`.slice(0, 2000));
  }
  if (run.state !== "running") return new ControlError("conflict", `An answer needs a running run; run ${run.id} is ${run.state}.`, { run_id: run.id, retryable: false });
  const qid = request.question_id;
  const ledger = questionLedger(readLog(runDir, run.id).events);
  const question = ledger.asked.get(qid);
  if (question === undefined) return refusalOf("not_found", `Run ${run.id} never asked question ${qid}.`, run.id, qid);
  if (ledger.withdrawn.has(qid)) return refusalOf("conflict", `Question ${qid} was withdrawn by the harness.`, run.id, qid);
  if (ledger.answered.has(qid)) return refusalOf("conflict", `Question ${qid} already has its answer; a question takes one.`, run.id, qid);
  if (questionExpired(question, target.now().getTime())) return refusalOf("conflict", `Question ${qid} passed its time limit at ${question.answer_by}.`, run.id, qid);
  const misfit = answerFitError(question, answerFields(request));
  return misfit === null ? null : refusalOf("invalid", misfit, run.id, qid);
}

function replyError(target: ControlTarget, reply: ControlReply): ControlError | null {
  if (reply.ok) return null;
  const body: ErrorBody = reply.error;
  const { code, message, ...rest } = body;
  // The worker's own refusals (the question moved on, the run ended, no ask path) keep their code.
  if (code === "conflict" || code === "not_found" || code === "invalid" || code === "unsupported") return new ControlError(code, message, rest);
  return unavailable(`The worker of run ${target.run.id} did not accept the answer: ${message}`);
}

/** Run steps 5 to 9 for one answer and return the accepted record, or throw the typed refusal. */
export async function answer(target: ControlTarget, request: AnswerRequest, runDir: string): Promise<AcceptedResponse["action"]> {
  const { run } = target;
  const action: ActionRecord = {
    id: buildActionId(run.agent_id, newUlid(target.now().getTime())),
    run_id: run.id,
    kind: "answer",
    caller: request.caller,
    requested_at: target.now().toISOString(),
    idempotency_key: request.idempotency_key ?? null,
    outcome: "accepted",
    error: null,
  };
  const refusal = check(target, request, runDir);
  if (refusal !== null) {
    const code = refusal.body.code;
    if ((code === "unsupported" || code === "conflict") && target.worker !== null && run.live_control && !run.terminal) {
      await target.worker.refuse({ ...action, outcome: "refused", error: refusal.body }).catch(() => undefined);
    }
    throw refusal;
  }
  if (!run.live_control || target.worker === null) {
    throw new ControlError("unavailable", `This core holds no control channel to the worker of run ${run.id} yet; retry shortly.`, { run_id: run.id, retry_after_ms: 500 });
  }
  let reply: ControlReply;
  try {
    reply = await target.worker.answer(action, request);
  } catch (err) {
    if (err instanceof ControlUnavailableError) throw unavailable(`The worker of run ${run.id} did not answer: ${err.message}. The answer may still take effect; check the run's events before sending it again.`);
    throw err;
  }
  const failed = replyError(target, reply);
  if (failed !== null) throw failed;
  return { ...action, outcome: "accepted" };
}
