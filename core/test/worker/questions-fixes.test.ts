/**
 * Review fixes for t13 (pr 15): a hung delivery, a withdrawn question. Worker side: a question is on disk before the run waits, an answer is taken once, the
 * question's own limit (12 hours, configurable lower, never higher) ends the run `unanswered`, and
 * the run's deadline does not advance while a question is pending. The worker runs in this process
 * with an injected clock, so hours pass in milliseconds.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { AnswerRequest, ErrorBody, Question, RunEvent } from "../../src/contract/index.js";
import { readLog } from "../../src/store/event-log.js";
import { FILE_MODE, runFile } from "../../src/store/files.js";
import { createRun, showRunAt } from "../../src/store/run-store.js";
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

async function open(t: TestContext, clock: () => number, driver: FakeDriverOptions, extra: { deadline?: number; questionLimitMs?: number; answerTimeoutMs?: number } = {}): Promise<Opened> {
  const run = newRun(extra.deadline === undefined ? {} : { deadline: new Date(extra.deadline).toISOString() });
  // Registered before the state dir's own hook (hooks run in order): the run ends before its directory goes.
  let cleanup = async (): Promise<void> => undefined;
  t.after(() => cleanup());
  const state = stateDir(t);
  const dir = createRun(state, run);
  writeFileSync(runFile(dir, "driver"), JSON.stringify(fakeDriver(driver)), { mode: FILE_MODE });
  const worker = new RunWorker({ stateDir: state, runId: run.id, heartbeatMs: 10, cancelGraceMs: 300, clock, ...(extra.answerTimeoutMs !== undefined && { answerTimeoutMs: extra.answerTimeoutMs }), ...(extra.questionLimitMs !== undefined && { questionLimitMs: extra.questionLimitMs }) });
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


const errorOf = (reply: ControlReply): ErrorBody => {
  assert.equal(reply.ok, false, JSON.stringify(reply));
  return (reply as { error: ErrorBody }).error;
};

test("a hung delivery does not suspend the question limit: 100 hours on, the run ends unanswered", async (t) => {
  let now = Date.now();
  const w = await open(t, () => now, { steps: ASK_THEN_HANG, answerHangs: 1 }, { deadline: now + HOUR, answerTimeoutMs: 60_000 });
  const question = await w.question();
  const pending = w.answer({ question_id: question.id, answer: "blue" }).catch(() => null);
  await sleep(100);
  now += 100 * HOUR;
  await waitFor(() => w.worker.state === "unanswered", 3000, "unanswered");
  await pending;
  assert.equal(w.log().some((e) => e.kind === "run.answer"), false);
});

test("a delivery that does not settle in time fails: the question is pending again, a run.error is logged, no run.answer", async (t) => {
  const now = Date.now();
  const w = await open(t, () => now, { steps: ASK_THEN_HANG, answerHangs: 1 }, { answerTimeoutMs: 150 });
  const question = await w.question();
  const failed = errorOf(await w.answer({ question_id: question.id, answer: "blue" }));
  assert.equal(failed.code, "unavailable");
  assert.equal(failed.retryable, true);
  assert.equal(w.log().some((e) => e.kind === "run.answer"), false);
  assert.ok(w.log().some((e) => e.kind === "run.error" && (e.data as { fatal: boolean }).fatal === false && /deliver/.test(JSON.stringify(e.data))));
  assert.deepEqual(showRunAt(w.dir, { controllable: true })?.run.pending_questions?.map((q) => q.id), [question.id]);
  assert.equal((await w.answer({ question_id: question.id, answer: "blue" })).ok, true, "a retry is no longer refused as being delivered");
});

test("a question the harness withdraws leaves the pending set and the deadline resumes", async (t) => {
  let now = Date.now();
  const steps: FakeStep[] = [{ op: "started" }, { op: "ask", question: ASK, wait: false }, { op: "withdraw", ref: ASK.ref }, { op: "hang" }];
  const w = await open(t, () => now, { steps }, { deadline: now + HOUR });
  const question = await w.question();
  await waitFor(() => w.log().some((e) => e.kind === "run.output" && String((e.data as { text: string }).text).includes(question.id)), 3000, "withdrawal logged");
  assert.deepEqual(showRunAt(w.dir, { controllable: true })?.run.pending_questions, []);
  assert.equal(errorOf(await w.answer({ question_id: question.id, answer: "blue" })).code, "not_found");
  now += 2 * HOUR;
  await waitFor(() => w.worker.state === "timed_out", 3000, "timed_out, not unanswered");
});
