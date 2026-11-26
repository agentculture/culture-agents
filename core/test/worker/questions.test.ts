/**
 * t13, worker side: a question is on disk before the run waits, an answer is taken once, the
 * question's own limit (12 hours, configurable lower, never higher) ends the run `unanswered`, and
 * the run's deadline does not advance while a question is pending. The worker runs in this process
 * with an injected clock, so hours pass in milliseconds.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { AnswerRequest, ErrorBody, Question, RunEvent, StateData } from "../../src/contract/index.js";
import { readLog } from "../../src/store/event-log.js";
import { FILE_MODE, runFile } from "../../src/store/files.js";
import { createRun, readRecord, showRunAt } from "../../src/store/run-store.js";
import { QUESTION_LIMIT_MS } from "../../src/store/questions.js";
import { controlRequest, type ControlReply } from "../../src/worker/control.js";
import type { AskedQuestion } from "../../src/worker/driver.js";
import type { FakeDriverOptions, FakeStep } from "../../src/worker/fake-driver.js";
import { RunWorker } from "../../src/worker/run-loop.js";
import { action, fakeDriver, newRun, stateDir, waitFor } from "./helpers.js";

const HOUR = 3600_000;
const CALLER = { kind: "operator", id: "thor-operator" } as const;
const ASK: AskedQuestion = { ref: "tool-call-1", kind: "question", text: "Which colour?", choices: [{ id: "red", label: "Red" }], free_text: true, multiple: false };
const ASK_THEN_HANG: FakeStep[] = [{ op: "started" }, { op: "ask", question: ASK }, { op: "hang" }];

interface Opened {
  dir: string;
  runId: string;
  worker: RunWorker;
  log: () => RunEvent[];
  question: () => Promise<Question>;
  answer: (fields: Omit<AnswerRequest, "caller">) => Promise<ControlReply>;
}

async function open(t: TestContext, clock: () => number, driver: FakeDriverOptions, extra: { deadline?: number; questionLimitMs?: number } = {}): Promise<Opened> {
  const run = newRun(extra.deadline === undefined ? {} : { deadline: new Date(extra.deadline).toISOString() });
  // Registered before the state dir's own hook (hooks run in order): the run ends before its directory goes.
  let cleanup = async (): Promise<void> => undefined;
  t.after(() => cleanup());
  const state = stateDir(t);
  const dir = createRun(state, run);
  writeFileSync(runFile(dir, "driver"), JSON.stringify(fakeDriver(driver)), { mode: FILE_MODE });
  const worker = new RunWorker({ stateDir: state, runId: run.id, heartbeatMs: 10, cancelGraceMs: 300, clock, ...(extra.questionLimitMs !== undefined && { questionLimitMs: extra.questionLimitMs }) });
  await worker.open();
  const done = worker.run();
  cleanup = async () => {
    if (worker.state !== null && !["succeeded", "failed", "cancelled", "timed_out", "unanswered", "unknown"].includes(worker.state)) {
      await controlRequest(dir, { op: "cancel", action: action(run, "cancel") }).catch(() => undefined);
    }
    await done;
    await worker.close();
  };
  const log = () => readLog(dir, run.id).events;
  return {
    dir,
    runId: run.id,
    worker,
    log,
    question: async () => {
      await waitFor(() => log().some((e) => e.kind === "run.question"), 3000, "run.question");
      return (log().find((e) => e.kind === "run.question")?.data as { question: Question }).question;
    },
    answer: (fields) => controlRequest(dir, { op: "answer", action: action(run, "answer"), request: { caller: CALLER, ...fields } }, 3000),
  };
}

const transitions = (log: RunEvent[]) => log.filter((e) => e.kind === "run.state").map((e) => e.data as StateData);
const errorOf = (reply: ControlReply): ErrorBody => {
  assert.equal(reply.ok, false, JSON.stringify(reply));
  return (reply as { error: ErrorBody }).error;
};

test("the run's deadline does not advance while a question is pending, and moves by the time spent waiting", async (t) => {
  let now = Date.now();
  const deadline = now + 10_000;
  const w = await open(t, () => now, { steps: ASK_THEN_HANG }, { deadline });
  const question = await w.question();
  const asked = w.log().find((e) => e.kind === "run.question") as RunEvent;
  assert.equal(Date.parse(question.answer_by) - Date.parse(asked.time), QUESTION_LIMIT_MS, "the default limit is 12 hours");

  now += HOUR; // an hour past the original deadline, with the question pending
  await sleep(150); // many heartbeats, each re-reading the clock
  assert.equal(w.worker.state, "running", "the deadline did not pass while the question was pending");
  assert.deepEqual(showRunAt(w.dir, { controllable: true })?.run.pending_questions?.map((q) => q.id), [question.id]);

  assert.equal((await w.answer({ question_id: question.id, answer: "blue" })).ok, true);
  assert.equal(Date.parse(readRecord(w.dir).deadline ?? ""), deadline + HOUR, "the run reports its deadline moved by the hour it waited");
  assert.deepEqual(showRunAt(w.dir, { controllable: true })?.run.pending_questions, []);

  now += 9000; // 9 s of the 10 s budget used after the wait
  await sleep(100);
  assert.equal(w.worker.state, "running");
  now += 2000;
  await waitFor(() => w.worker.state === "timed_out", 3000, "timed_out");
  assert.deepEqual(transitions(w.log()).slice(-2).map((d) => [d.to, d.reason]), [["cancelling", "deadline"], ["timed_out", "deadline reached"]]);
});

test("when a question's limit passes the run ends unanswered, not timed_out, even with a deadline also passed", async (t) => {
  let now = Date.now();
  const w = await open(t, () => now, { steps: ASK_THEN_HANG }, { deadline: now + 5000, questionLimitMs: 60_000 });
  const question = await w.question();
  assert.equal(Date.parse(question.answer_by) - now, 60_000, "a configured lower limit is used");
  now += 59_000;
  await sleep(100);
  assert.equal(w.worker.state, "running", "neither the limit nor the paused deadline has passed");
  now += 2000;
  await waitFor(() => w.worker.state === "unanswered", 3000, "unanswered");
  assert.deepEqual(transitions(w.log()).slice(-2).map((d) => [d.from, d.to, d.reason]), [
    ["running", "cancelling", "question_limit"],
    ["cancelling", "unanswered", "question_limit"],
  ]);
  assert.equal(w.log().some((e) => e.kind === "run.state" && (e.data as StateData).to === "timed_out"), false);
  const late = errorOf(await w.answer({ question_id: question.id, answer: "too late" }));
  assert.equal(late.code, "conflict");
  assert.deepEqual(showRunAt(w.dir)?.run.pending_questions, [], "a terminal run lists no pending question");
});

test("a configured limit higher than 12 hours is capped at 12 hours", async (t) => {
  const now = Date.now();
  const w = await open(t, () => now, { steps: ASK_THEN_HANG }, { questionLimitMs: 48 * HOUR });
  const question = await w.question();
  assert.equal(Date.parse(question.answer_by) - now, 12 * HOUR);
});

test("an answer is delivered exactly once; a second one, an unknown question and a misfit are refused", async (t) => {
  const now = Date.now();
  const steps: FakeStep[] = [{ op: "started" }, { op: "ask", question: ASK }, { op: "hang" }];
  const w = await open(t, () => now, { steps });
  const question = await w.question();
  const unknown = errorOf(await w.answer({ question_id: "thor-culture-agents.qst.01JDQ5X0000000000000000009", answer: "x" }));
  assert.equal(unknown.code, "not_found");
  assert.equal(unknown.question_id, "thor-culture-agents.qst.01JDQ5X0000000000000000009");
  assert.equal(errorOf(await w.answer({ question_id: question.id, decision: "approve" })).code, "invalid");
  assert.equal(errorOf(await w.answer({ question_id: question.id, choice_ids: ["blue"] })).code, "invalid");

  // Two answers at once: one is delivered, the other is refused.
  const replies = await Promise.all([w.answer({ question_id: question.id, choice_ids: ["red"] }), w.answer({ question_id: question.id, answer: "green" })]);
  assert.equal(replies.filter((r) => r.ok).length, 1, JSON.stringify(replies));
  const second = errorOf(await w.answer({ question_id: question.id, answer: "again" }));
  assert.equal(second.code, "conflict");
  assert.equal(second.question_id, question.id);
  assert.equal(second.retryable, false);
  const log = w.log();
  assert.equal(log.filter((e) => e.kind === "run.answer").length, 1);
  assert.equal(log.filter((e) => e.kind === "run.output" && (e.data as { text: string }).text.startsWith("answer: ")).length, 1, "delivered into the turn once");
  const askedAt = log.findIndex((e) => e.kind === "run.question");
  const answeredAt = log.findIndex((e) => e.kind === "run.answer");
  assert.ok(askedAt >= 0 && askedAt < answeredAt, "the question is on the log before its answer");
});

test("a driver without an ask path refuses an answer as unsupported, naming answer", async (t) => {
  const now = Date.now();
  const w = await open(t, () => now, { steps: ASK_THEN_HANG, noAnswer: true });
  const question = await w.question();
  const refused = errorOf(await w.answer({ question_id: question.id, answer: "blue" }));
  assert.equal(refused.code, "unsupported");
  assert.equal(refused.capability, "answer");
  assert.equal(w.log().some((e) => e.kind === "run.answer"), false);
});

test("a delivery that fails leaves the question pending and is logged as a non-fatal error", async (t) => {
  const now = Date.now();
  const w = await open(t, () => now, { steps: ASK_THEN_HANG, answerError: "the bridge is gone" });
  const question = await w.question();
  const failed = errorOf(await w.answer({ question_id: question.id, answer: "blue" }));
  assert.equal(failed.code, "unavailable");
  assert.equal(w.log().some((e) => e.kind === "run.answer"), false);
  assert.deepEqual(showRunAt(w.dir, { controllable: true })?.run.pending_questions?.map((q) => q.id), [question.id]);
  assert.ok(w.log().some((e) => e.kind === "run.error" && /the bridge is gone/.test(JSON.stringify(e.data))));
});
