/**
 * The worker's side of operator questions, and its clock rule (contract README, "Deadlines" and
 * "Operator questions"). The worker enforces its own deadline, so it also owns the rule that the
 * deadline pauses while a question is pending:
 *
 * - The run's deadline does not advance while at least one question is pending. The time spent
 *   waiting is added to it once the last pending question is answered; until then it has no due time.
 * - Each question has its own limit (`answer_by`): 12 hours after it was asked, or less when the
 *   operator configured less. When it passes with no answer, the run stops and ends `unanswered`.
 * - An answer is taken once: a question that has its answer, or one being delivered, refuses a second.
 *
 * Pure apart from the clock it is given; the worker turns what `due` says into a stop.
 */
import { buildQuestionId, newUlid, type ErrorBody, type Question, type QuestionId } from "../contract/index.js";
import { answerFitError, questionExpired, type AnswerFields } from "../store/questions.js";
import type { AskedQuestion } from "./driver.js";

const TEXT_MAX = 100_000;
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** The run's deadline with the time spent waiting for answers added. */
export class PausableDeadline {
  private pausedTotal = 0;
  private pausedSince: number | null = null;

  constructor(private readonly deadline: number | null) {}

  get paused(): boolean {
    return this.pausedSince !== null;
  }

  pause(now: number): void {
    this.pausedSince ??= now;
  }

  resume(now: number): void {
    if (this.pausedSince === null) return;
    this.pausedTotal += Math.max(0, now - this.pausedSince);
    this.pausedSince = null;
  }

  /** When the deadline passes, or null while paused or when the run has none. */
  dueAt(): number | null {
    return this.deadline === null || this.paused ? null : this.deadline + this.pausedTotal;
  }

  /** The deadline as the run reports it: moved by the time spent waiting so far (null with none). */
  movedAt(now: number): number | null {
    if (this.deadline === null) return null;
    return this.deadline + this.pausedTotal + (this.pausedSince === null ? 0 : Math.max(0, now - this.pausedSince));
  }
}

interface Pending {
  question: Question;
  ref: string;
}

export interface QuestionDeskOptions {
  agentId: string;
  /** The run's deadline in ms, or null. */
  deadline: number | null;
  /** This run's question limit in ms (already capped at 12 hours). */
  limitMs: number;
}

/** What has to happen now, by the worker's clock. */
export type Due = "question_limit" | "deadline" | null;

export class QuestionDesk {
  readonly deadline: PausableDeadline;
  private readonly pending = new Map<QuestionId, Pending>();
  private readonly answered = new Set<QuestionId>();
  private readonly delivering = new Set<QuestionId>();

  constructor(private readonly options: QuestionDeskOptions) {
    this.deadline = new PausableDeadline(options.deadline);
  }

  get waiting(): boolean {
    return this.pending.size > 0;
  }

  /** Give a raised request its id and time limit and start waiting: the deadline pauses. */
  ask(asked: AskedQuestion, now: number): Question {
    const question: Question = {
      id: buildQuestionId(this.options.agentId, newUlid(now)),
      kind: asked.kind,
      text: cut(asked.text === "" ? "(the harness gave no text)" : asked.text, TEXT_MAX),
      choices: asked.choices.slice(0, 50).map((c) => ({
        id: cut(c.id, 128),
        label: cut(c.label === "" ? c.id : c.label, 500),
        ...(c.description !== undefined && { description: cut(c.description, 2000) }),
      })),
      free_text: asked.free_text,
      multiple: asked.multiple,
      ...(asked.kind === "approval" && asked.tool && { tool: cut(asked.tool, 200) }),
      answer_by: new Date(now + this.options.limitMs).toISOString(),
    };
    this.pending.set(question.id, { question, ref: asked.ref });
    this.deadline.pause(now);
    return question;
  }

  /** Why this answer is refused now, or null when it may be delivered. */
  check(questionId: string, fields: AnswerFields, now: number, runId: string): ErrorBody | null {
    const base = { retryable: false, question_id: questionId, run_id: runId };
    if (this.answered.has(questionId)) return { code: "conflict", message: `Question ${questionId} already has its answer.`, ...base };
    if (this.delivering.has(questionId)) return { code: "conflict", message: `An answer to question ${questionId} is being delivered.`, ...base };
    const entry = this.pending.get(questionId);
    if (entry === undefined) return { code: "not_found", message: `Run ${runId} never asked question ${questionId}.`, ...base };
    if (questionExpired(entry.question, now)) return { code: "conflict", message: `Question ${questionId} passed its time limit at ${entry.question.answer_by}.`, ...base };
    const misfit = answerFitError(entry.question, fields);
    return misfit === null ? null : { code: "invalid", message: misfit, retryable: false, question_id: questionId };
  }

  /** Hold the question while its answer is delivered; returns the harness's handle for it. */
  begin(questionId: QuestionId): string {
    const entry = this.pending.get(questionId);
    if (entry === undefined) throw new Error(`question ${questionId} is not pending`);
    this.delivering.add(questionId);
    return entry.ref;
  }

  /** Delivery failed: the question is pending again and may be answered. */
  abort(questionId: QuestionId): void {
    this.delivering.delete(questionId);
  }

  /** The answer was delivered and recorded: the question closes; the deadline resumes when none is left. */
  close(questionId: QuestionId, now: number): void {
    this.delivering.delete(questionId);
    this.pending.delete(questionId);
    this.answered.add(questionId);
    if (this.pending.size === 0) this.deadline.resume(now);
  }

  /** What is due at `now`: a question past its limit comes first, then the deadline. */
  due(now: number): Due {
    for (const { question } of this.pending.values()) if (!this.delivering.has(question.id) && questionExpired(question, now)) return "question_limit";
    const at = this.deadline.dueAt();
    return at !== null && at <= now ? "deadline" : null;
  }

  /** The next time something may become due, or null when nothing will. */
  nextDueAt(): number | null {
    const times = [...this.pending.values()].map(({ question }) => Date.parse(question.answer_by));
    const at = this.deadline.dueAt();
    if (at !== null) times.push(at);
    return times.length === 0 ? null : Math.min(...times);
  }
}
