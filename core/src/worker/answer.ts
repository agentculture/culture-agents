/**
 * Delivering an operator's answer inside the worker, like a steer: the answer goes into the turn
 * first, and `run.answer` is appended only once the driver took it, so `run.answer` means delivered.
 * The question is held while it is delivered (worker/questions.ts), so a second answer is refused
 * with `conflict` and a question gets exactly one. A failed delivery leaves the question pending and
 * is logged as a non-fatal `run.error`; a driver without an ask path answers `unsupported`.
 */
import type { ActionRecord, AnswerRequest, ErrorBody, RunEvent, RunId, RunState } from "../contract/index.js";
import type { EventInput } from "../store/event-log.js";
import { answerFields } from "../store/questions.js";
import type { ControlReply } from "./control.js";
import type { Driver } from "./driver.js";
import type { QuestionDesk } from "./questions.js";

/** What delivery needs from the worker. */
export interface AnswerHost {
  runId: RunId;
  desk: QuestionDesk;
  driver: Driver | null;
  clock: () => number;
  state: () => RunState | null;
  /** Append to the run's log; null when the run is already terminal. */
  append: (input: EventInput, durable?: boolean) => RunEvent | null;
}

const clip = (text: string) => (text.length > 2000 ? `${text.slice(0, 1997)}...` : text);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const UNSUPPORTED_ANSWER: ErrorBody = {
  code: "unsupported",
  message: "This run's harness driver cannot ask its operator, so it takes no answer.",
  retryable: false,
  capability: "answer",
};

/** Deliver and record one answer. Null when it was recorded; otherwise the refusal to reply with. */
export async function deliverAnswer(host: AnswerHost, action: ActionRecord, request: AnswerRequest): Promise<ControlReply | null> {
  const qid = request.question_id;
  const fields = answerFields(request);
  const refusal = host.desk.check(qid, fields, host.clock(), host.runId);
  if (refusal !== null) return { ok: false, error: refusal };
  const driver = host.driver;
  if (!driver?.answer) return { ok: false, error: UNSUPPORTED_ANSWER };
  const ref = host.desk.begin(qid);
  try {
    await driver.answer(ref, fields);
  } catch (err) {
    host.desk.abort(qid);
    const body = (err as { body?: ErrorBody }).body;
    if (body?.code === "unsupported") return { ok: false, error: body };
    const error: ErrorBody = { code: "unavailable", message: clip(`The answer ${action.id} could not be delivered to the harness: ${messageOf(err)}`), retryable: true };
    host.append({ kind: "run.error", data: { error, fatal: false } });
    return { ok: false, error };
  }
  const recorded = host.append({ kind: "run.answer", data: { question_id: qid, action, ...fields } }, true);
  host.desk.close(qid, host.clock());
  if (recorded !== null) return null;
  const state = String(host.state());
  return { ok: false, error: { code: "conflict", message: `The run ended (${state}) while the answer was being delivered; it was not recorded.`, retryable: false, run_id: host.runId, question_id: qid } };
}
