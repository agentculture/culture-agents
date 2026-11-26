/**
 * Operator questions as the run's event log records them (contract README, "Operator questions").
 * Pure: no I/O, the clock is a parameter. Both the worker (which asks and takes answers) and the
 * core (which reports `pending_questions` and checks an answer before it forwards it) use these
 * rules, so the two sides cannot disagree about what is pending or what fits.
 *
 * - A question is pending from its `run.question` until its `run.answer`; a terminal run has none.
 * - An answer fits a `question` when it gives free text (only when `free_text`), choice ids from the
 *   question's `choices` (more than one only when `multiple`), or both, and no decision. It fits an
 *   `approval` when it gives a decision; free text is then the reason, and choice ids do not fit.
 * - The question's own time limit is 12 hours, or less when the operator configured less, never more.
 */
import { isTerminal, type AnswerData, type AnswerRequest, type Question, type QuestionData, type RunEvent, type StateData } from "../contract/index.js";

/** The longest and default time limit of one question: 12 hours. */
export const QUESTION_LIMIT_MS = 12 * 3600 * 1000;

/**
 * The time limit a run's questions get: the default when none is configured, the configured value
 * when it is lower, and never more than 12 hours. A value that is not a positive number is an error.
 */
export function questionLimitMs(configured?: number | null): number {
  if (configured === undefined || configured === null) return QUESTION_LIMIT_MS;
  if (!Number.isFinite(configured) || configured <= 0) throw new RangeError("a question limit must be a positive number of milliseconds");
  return Math.min(Math.floor(configured), QUESTION_LIMIT_MS);
}

/** What an answer carries besides its caller and question id. */
export type AnswerFields = Pick<AnswerRequest, "answer" | "choice_ids" | "decision">;

/** The answer fields of a request, without absent ones. */
export function answerFields(request: AnswerFields): AnswerFields {
  return {
    ...(request.answer !== undefined && { answer: request.answer }),
    ...(request.choice_ids !== undefined && { choice_ids: request.choice_ids }),
    ...(request.decision !== undefined && { decision: request.decision }),
  };
}

/** Every question a log asked, by id, and the ids that have their answer. */
export interface QuestionLedger {
  asked: Map<string, Question>;
  answered: Set<string>;
}

export function questionLedger(events: readonly RunEvent[]): QuestionLedger {
  const ledger: QuestionLedger = { asked: new Map(), answered: new Set() };
  for (const event of events) {
    if (event.kind === "run.question") {
      const question = (event.data as QuestionData).question;
      ledger.asked.set(question.id, question);
    } else if (event.kind === "run.answer") {
      ledger.answered.add((event.data as AnswerData).question_id);
    }
  }
  return ledger;
}

/** The questions with no answer yet, oldest first; empty once the run is terminal. */
export function pendingQuestions(events: readonly RunEvent[]): Question[] {
  for (const event of events) {
    if (event.kind === "run.state" && isTerminal((event.data as StateData).to)) return [];
  }
  const ledger = questionLedger(events);
  return [...ledger.asked.values()].filter((q) => !ledger.answered.has(q.id));
}

/** Why `fields` does not fit `question`, or null when it does. */
export function answerFitError(question: Question, fields: AnswerFields): string | null {
  const choices = fields.choice_ids ?? [];
  if (question.kind === "approval") {
    if (fields.decision === undefined) return "An approval is answered with a decision (approve or deny).";
    if (choices.length > 0) return "An approval takes a decision, not choice ids.";
    return null;
  }
  if (fields.decision !== undefined) return "A question is answered with free text or choice ids, not a decision.";
  if (fields.answer === undefined && choices.length === 0) return "A question needs an answer, choice ids, or both.";
  if (fields.answer !== undefined && !question.free_text) return "This question does not accept free text; pick from its choices.";
  if (choices.length > 1 && !question.multiple) return "This question accepts one choice only.";
  if (new Set(choices).size !== choices.length) return "A choice id is given more than once.";
  const known = new Set(question.choices.map((c) => c.id));
  const unknown = choices.find((id) => !known.has(id));
  return unknown === undefined ? null : `The question offers no choice ${JSON.stringify(unknown.slice(0, 128))}.`;
}

/** Whether the question's own time limit has passed at `nowMs`. */
export const questionExpired = (question: Question, nowMs: number): boolean => Date.parse(question.answer_by) <= nowMs;
