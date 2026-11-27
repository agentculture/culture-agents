/** t13: the pure question rules (limit, fit, pending), the paused deadline, and the limit's configuration. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Question, RunEvent } from "../../src/contract/index.js";
import { LimitsConfigError, loadQuestionLimit } from "../../src/daemon/limits.js";
import { answerFitError, pendingQuestions, QUESTION_LIMIT_MS, questionLimitMs } from "../../src/store/questions.js";
import { PausableDeadline, QuestionDesk } from "../../src/worker/questions.js";

const STREAMS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contract", "fixtures", "streams", "valid");
const stream = (name: string): RunEvent[] =>
  readFileSync(join(STREAMS, name), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RunEvent);

const QUESTION: Question = {
  id: "thor-culture-agents.qst.01JDQ5X0000000000000000001",
  kind: "question",
  text: "Which colour?",
  choices: [
    { id: "red", label: "Red" },
    { id: "green", label: "Green" },
  ],
  free_text: false,
  multiple: false,
  answer_by: "2026-11-25T22:00:04Z",
};

test("the question limit defaults to 12 hours, may be lower, and is never higher", () => {
  assert.equal(QUESTION_LIMIT_MS, 12 * 3600 * 1000);
  assert.equal(questionLimitMs(), QUESTION_LIMIT_MS);
  assert.equal(questionLimitMs(null), QUESTION_LIMIT_MS);
  assert.equal(questionLimitMs(60_000), 60_000);
  assert.equal(questionLimitMs(24 * 3600 * 1000), QUESTION_LIMIT_MS);
  assert.throws(() => questionLimitMs(0), RangeError);
  assert.throws(() => questionLimitMs(Number.NaN), RangeError);
});

test("the core's config file sets the limit in seconds, from 1 to 43200, and refuses more", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ca-qlimit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "harness.json");
  const env = { CULTURE_AGENTS_HARNESS_CONFIG: file };
  const write = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  write({});
  assert.equal(loadQuestionLimit(env), QUESTION_LIMIT_MS);
  write({ questions: { limitSeconds: 3600 } });
  assert.equal(loadQuestionLimit(env), 3600_000);
  write({ questions: { limitSeconds: null } });
  assert.equal(loadQuestionLimit(env), QUESTION_LIMIT_MS);
  write({ questions: { limitSeconds: 43_200 } });
  assert.equal(loadQuestionLimit(env), QUESTION_LIMIT_MS);
  for (const bad of [43_201, 0, 1.5, "3600"]) {
    write({ questions: { limitSeconds: bad } });
    assert.throws(() => loadQuestionLimit(env), LimitsConfigError, String(bad));
  }
  write({ questions: { limitHours: 1 } });
  assert.throws(() => loadQuestionLimit(env), /not a known setting/);
});

test("pending questions are read from the log: answered ones drop out, and a terminal run has none", () => {
  const answered = stream("question-answered.jsonl");
  assert.deepEqual(pendingQuestions(answered), []);
  const asked = answered.findIndex((e) => e.kind === "run.question");
  assert.equal(pendingQuestions(answered.slice(0, asked + 1)).length, 1, "pending right after it was asked");
  const unanswered = stream("question-unanswered.jsonl");
  assert.equal(pendingQuestions(unanswered.slice(0, -2)).length, 1);
  assert.deepEqual(pendingQuestions(unanswered), [], "none once the run is terminal");
});

test("an answer must fit its question", () => {
  assert.equal(answerFitError(QUESTION, { choice_ids: ["red"] }), null);
  assert.match(answerFitError(QUESTION, { answer: "blue" }) ?? "", /free text/);
  assert.match(answerFitError(QUESTION, { choice_ids: ["red", "green"] }) ?? "", /one choice/);
  assert.match(answerFitError(QUESTION, { choice_ids: ["blue"] }) ?? "", /no choice/);
  assert.match(answerFitError(QUESTION, {}) ?? "", /needs/);
  assert.match(answerFitError(QUESTION, { decision: "approve" }) ?? "", /not a decision/);
  const open = { ...QUESTION, free_text: true, multiple: true };
  assert.equal(answerFitError(open, { answer: "blue", choice_ids: ["red", "green"] }), null);
  assert.match(answerFitError(open, { choice_ids: ["red", "red"] }) ?? "", /more than once/);
  const approval: Question = { ...QUESTION, kind: "approval", choices: [], tool: "write" };
  assert.equal(answerFitError(approval, { decision: "deny", answer: "not now" }), null);
  assert.match(answerFitError(approval, { answer: "yes" }) ?? "", /decision/);
});

test("the deadline pauses while paused and keeps the time spent waiting", () => {
  const d = new PausableDeadline(10_000);
  assert.equal(d.dueAt(), 10_000);
  d.pause(4000);
  assert.equal(d.dueAt(), null, "no due time while a question is pending");
  assert.equal(d.movedAt(7000), 13_000);
  d.resume(9000);
  assert.equal(d.dueAt(), 15_000);
  assert.equal(new PausableDeadline(null).movedAt(5), null);
});

test("the desk pauses on the first question, resumes after the last answer, and says what is due", () => {
  const desk = new QuestionDesk({ agentId: "thor-culture-agents", deadline: 10_000, limitMs: 60_000 });
  const asked = { ref: "r", kind: "question" as const, text: "?", choices: [], free_text: true, multiple: false };
  const first = desk.ask(asked, 1000);
  const second = desk.ask({ ...asked, ref: "s" }, 2000);
  assert.equal(desk.due(50_000), null, "the deadline does not pass while waiting");
  assert.equal(desk.nextDueAt(), 61_000);
  desk.begin(first.id);
  desk.close(first.id, 3000);
  assert.equal(desk.deadline.paused, true, "still waiting for the second question");
  desk.begin(second.id);
  desk.close(second.id, 5000);
  assert.equal(desk.deadline.dueAt(), 14_000, "4 s of waiting added");
  assert.equal(desk.check(first.id, { answer: "x" }, 5000, "run")?.code, "conflict");
  const third = desk.ask(asked, 20_000);
  assert.equal(desk.due(80_000), "question_limit");
  assert.equal(desk.check(third.id, { answer: "x" }, 80_000, "run")?.code, "conflict", "past its limit");
});
