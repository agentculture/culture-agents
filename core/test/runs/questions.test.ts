/**
 * t13 through the real daemon, the real worker processes and the real stub harness driver: a run
 * asks, the core is killed and restarted, the question is still pending, and the answer route
 * delivers it into the same run exactly once. A harness that cannot ask gets the typed refusal, and
 * a question limit from the core's config file ends a run `unanswered`.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { AcceptedResponse, Capabilities, OutputData, RefusedData, Run, StateData } from "../../src/contract/index.js";
import { CALLER, HANG, events, getRun, killDaemon, makeEnv, ok, refused, startDaemon, submitBody, waitRun, type FakeHarness } from "./support.js";

const STUB: FakeHarness = { id: "stub-ask", steps: [], stub: true, ask: true };
const TASK = "ask: Which colour should the banner use?\nchoices: red, green\nfiles: banner.txt";

async function submitTask(env: Parameters<typeof ok>[0], harness: string, task: string): Promise<Run> {
  return (await ok<{ run: Run }>(env, "POST", "/v1/runs", 201, "control-action#submit_response", submitBody(harness, env.repoA, { task }))).run;
}

test("a question survives a core restart and its answer is delivered into the same run exactly once", async (t) => {
  const env = makeEnv(t, [STUB]);
  const first = await startDaemon(t, env);
  const caps = await ok<Capabilities>(env, "GET", "/v1/harnesses/stub-ask", 200, "capabilities");
  assert.equal(caps.capabilities.answer.supported, true);
  const run = await submitTask(env, "stub-ask", TASK);
  const waiting = await waitRun(env, run.id, (r) => (r.pending_questions ?? []).length === 1, "a pending question");
  const question = (waiting.pending_questions ?? [])[0];
  assert.ok(question !== undefined);
  assert.equal(question.kind, "question");
  assert.deepEqual(question.choices.map((c) => c.label), ["red", "green"]);
  const asked = (await events(env, run.id)).filter((e) => e.kind === "run.question");
  assert.equal(asked.length, 1, "the question is on the run's event log");

  await killDaemon(first);
  await startDaemon(t, env);
  const after = await getRun(env, run.id);
  assert.equal(after.state, "running");
  assert.deepEqual(after.pending_questions?.map((q) => q.id), [question.id], "still pending after the restart");

  const post = (body: object) => ({ caller: CALLER, question_id: question.id, ...body });
  const unknown = await refused(env, "POST", `/v1/runs/${run.id}/answer`, "not_found", post({ question_id: "thor-culture-agents.qst.01JDQ5X0000000000000000009", answer: "x" }));
  assert.equal(unknown.question_id, "thor-culture-agents.qst.01JDQ5X0000000000000000009");
  await refused(env, "POST", `/v1/runs/${run.id}/answer`, "invalid", post({ decision: "approve" }));
  const accepted = await ok<AcceptedResponse>(env, "POST", `/v1/runs/${run.id}/answer`, 202, "control-action#accepted_response", post({ answer: "ultraviolet" }));
  assert.equal(accepted.action.kind, "answer");
  const second = await refused(env, "POST", `/v1/runs/${run.id}/answer`, "conflict", post({ answer: "again" }));
  assert.equal(second.question_id, question.id);
  assert.equal(second.retryable, false);

  const done = await waitRun(env, run.id, (r) => r.terminal, "the run ends");
  assert.equal(done.state, "succeeded");
  assert.deepEqual(done.pending_questions, []);
  const log = await events(env, run.id);
  assert.equal(log.filter((e) => e.kind === "run.answer").length, 1, "exactly one answer recorded");
  assert.ok(log.some((e) => e.kind === "run.output" && (e.data as OutputData).text === "stub got the answer: ultraviolet"), "delivered into the same turn");
  assert.ok(log.findIndex((e) => e.kind === "run.question") < log.findIndex((e) => e.kind === "run.answer"));
});

test("an answer to a run whose harness cannot ask is refused unsupported, naming answer, and logged", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const caps = await ok<Capabilities>(env, "GET", "/v1/harnesses/fake", 200, "capabilities");
  assert.equal(caps.capabilities.answer.supported, false);
  const run = (await ok<{ run: Run }>(env, "POST", "/v1/runs", 201, "control-action#submit_response", submitBody("fake", env.repoA))).run;
  await waitRun(env, run.id, (r) => r.state === "running", "running");
  const error = await refused(env, "POST", `/v1/runs/${run.id}/answer`, "unsupported", { caller: CALLER, question_id: "thor-culture-agents.qst.01JDQ5X0000000000000000001", answer: "yes" });
  assert.equal(error.capability, "answer");
  const log = await events(env, run.id);
  const refusal = log.find((e) => e.kind === "run.refused")?.data as RefusedData | undefined;
  assert.equal(refusal?.action.kind, "answer");
  assert.equal(refusal?.action.error?.code, "unsupported");
  await ok(env, "POST", `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  await waitRun(env, run.id, (r) => r.terminal, "cancelled");
});

test("a question limit set lower in the core's config file ends the run unanswered", async (t) => {
  const env = makeEnv(t, [STUB]);
  writeFileSync(join(env.root, "config", "culture-agents", "harness.json"), JSON.stringify({ questions: { limitSeconds: 1 } }));
  await startDaemon(t, env);
  const run = await submitTask(env, "stub-ask", TASK);
  const waiting = await waitRun(env, run.id, (r) => (r.pending_questions ?? []).length === 1, "a pending question");
  const question = (waiting.pending_questions ?? [])[0];
  assert.ok(question !== undefined);
  const asked = (await events(env, run.id)).find((e) => e.kind === "run.question");
  // The event is stamped just after the question is given its limit, so allow that gap.
  const gap = Date.parse(question.answer_by) - Date.parse(asked?.time ?? "");
  assert.ok(gap <= 1000 && gap >= 900, `answer_by is ${gap} ms after the question event`);
  const done = await waitRun(env, run.id, (r) => r.terminal, "the run ends", 10_000);
  assert.equal(done.state, "unanswered");
  const states = (await events(env, run.id)).filter((e) => e.kind === "run.state").map((e) => (e.data as StateData).to);
  assert.deepEqual(states.slice(-2), ["cancelling", "unanswered"]);
  await refused(env, "POST", `/v1/runs/${run.id}/answer`, "conflict", { caller: CALLER, question_id: question.id, answer: "late" });
});
