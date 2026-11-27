import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { test } from "node:test";

import type { ActionRecord, AgentList, ControlData, OutputData, RefusedData, RunEvent, StateData } from "../../src/contract/index.js";
import { runDir, runFile } from "../../src/store/files.js";
import {
  AGENT,
  CALLER,
  HANG,
  NO_STEER,
  attach,
  events,
  getRun,
  makeEnv,
  ok,
  processExists,
  refused,
  startDaemon,
  submit,
  waitFor,
  waitRun,
} from "./support.js";

type ResultView = { state: string; summary: string | null };
const states = (log: RunEvent[]) => log.filter((e) => e.kind === "run.state").map((e) => (e.data as StateData).to);
const steerEchoes = (log: RunEvent[]) => log.filter((e) => e.kind === "run.output" && (e.data as OutputData).text.startsWith("steer: "));
const controls = (log: RunEvent[]) => log.filter((e) => e.kind === "run.control").map((e) => (e.data as ControlData).action);

test("submit acknowledges a durable queued run; a second run in the same repository is accepted alongside it", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const first = await submit(env, "fake", env.repoA);
  assert.equal(first.state, "queued");
  assert.equal(first.cursor, 1);
  assert.equal(first.live_control, true);
  assert.equal(first.repo, env.repoA);
  assert.ok(first.id.startsWith(`${AGENT}.run.`) && first.session_id.startsWith(`${AGENT}.ses.`));
  const dir = runDir(env.stateDir, first.id);
  for (const file of ["record", "events", "cursor", "worker"] as const) {
    assert.ok(existsSync(runFile(dir, file)), `${file} on disk`);
    assert.equal(statSync(runFile(dir, file)).mode & 0o777, 0o600);
  }
  assert.ok(first.worker_pid !== null && processExists(first.worker_pid));

  // No limit is configured, so the repository with an active run takes a second one (t8: busy is gone).
  const sameRepo = await submit(env, "fake", env.repoA);
  assert.equal(sameRepo.state, "queued");
  assert.notEqual(sameRepo.id, first.id);

  const other = await submit(env, "fake", env.repoB);
  assert.equal(other.state, "queued");

  await waitRun(env, first.id, (r) => r.state === "running", "first run running");
  const agents = await ok<AgentList>(env, "GET", "/v1/agents", 200, "agent#agent_list");
  const agent = agents.agents.find((a) => a.id === AGENT);
  assert.equal(agent?.state, "running");
  assert.deepEqual(new Set(agent?.active_run_ids), new Set([first.id, sameRepo.id, other.id]));
  assert.equal(agents.harnesses.length, 1);

  await ok(env, "POST", `/v1/runs/${first.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  await waitRun(env, first.id, (r) => r.terminal, "first run terminal");
  const again = await submit(env, "fake", env.repoA);
  assert.equal(again.state, "queued");
  const list = await ok<{ runs: { id: string }[] }>(env, "GET", "/v1/runs", 200, "run#run_list");
  assert.deepEqual(list.runs.map((r) => r.id), [again.id, other.id, sameRepo.id, first.id]);
});

test("steer and cancel reach the running driver, and the run ends cancelled", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  await refused(env, "GET", `/v1/runs/${run.id}/result`, "conflict");
  await waitRun(env, run.id, (r) => r.state === "running", "running");

  const steer = await ok<{ action: ActionRecord }>(env, "POST", `/v1/runs/${run.id}/steer`, 202, "control-action#accepted_response", {
    caller: CALLER,
    message: "Use the other approach.",
    idempotency_key: "steer-1",
  });
  assert.equal(steer.action.kind, "steer");
  assert.equal(steer.action.idempotency_key, "steer-1");
  let log: RunEvent[] = [];
  await waitFor(async () => steerEchoes((log = await events(env, run.id))).length > 0, 5000, "the driver to record the steer");
  assert.equal(steerEchoes(log).length, 1, "the driver received the steer once");
  assert.equal((steerEchoes(log)[0]?.data as OutputData).text, "steer: Use the other approach.");
  assert.equal(controls(log)[0]?.id, steer.action.id);

  const cancel = await ok<{ action: ActionRecord }>(env, "POST", `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER, reason: "enough" });
  const ended = await waitRun(env, run.id, (r) => r.terminal, "terminal");
  assert.equal(ended.state, "cancelled");
  assert.equal(ended.live_control, false);
  log = await events(env, run.id);
  assert.deepEqual(states(log), ["queued", "running", "cancelling", "cancelled"]);
  assert.deepEqual(controls(log).map((a) => a.id), [steer.action.id, cancel.action.id]);

  const result = await ok<ResultView>(env, "GET", `/v1/runs/${run.id}/result`, 200, "run#run_result");
  assert.equal(result.state, "cancelled");
  assert.equal(result.summary, "Working");
  // A terminal run: the state check refuses, and nothing more is written.
  const conflict = await refused(env, "POST", `/v1/runs/${run.id}/steer`, "conflict", { caller: CALLER, message: "late" });
  assert.equal(conflict.retryable, false);
  await refused(env, "POST", `/v1/runs/${run.id}/cancel`, "conflict", { caller: CALLER });
  assert.equal((await events(env, run.id)).length, log.length);
});

test("steer on a harness that declares it unsupported is refused, recorded, and never reaches the driver", async (t) => {
  const env = makeEnv(t, [NO_STEER]);
  await startDaemon(t, env);
  const run = await submit(env, "fake-nosteer", env.repoA);
  await waitRun(env, run.id, (r) => r.state === "running", "running");
  const error = await refused(env, "POST", `/v1/runs/${run.id}/steer`, "unsupported", { caller: CALLER, message: "Turn left." });
  assert.equal(error.capability, "steer");
  const log = await events(env, run.id);
  assert.equal(steerEchoes(log).length, 0, "the driver never received it");
  assert.equal(controls(log).length, 0);
  const refusals = log.filter((e) => e.kind === "run.refused").map((e) => (e.data as RefusedData).action);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]?.kind, "steer");
  assert.equal(refusals[0]?.error?.capability, "steer");
  await ok(env, "POST", `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  assert.equal((await waitRun(env, run.id, (r) => r.terminal, "terminal")).state, "cancelled");
});

test("pause and resume are refused whatever the harness says, answer when the harness cannot ask (t13), all recorded on a run this core controls", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  await waitRun(env, run.id, (r) => r.state === "running" && r.cursor >= 3, "running");
  const bodies = {
    pause: { caller: CALLER, idempotency_key: "pause-1" },
    resume: { caller: CALLER },
    answer: { caller: CALLER, question_id: "thor-culture-agents.qst.01JDQ5X0000000000000000001", answer: "yes" },
  } as const;
  const before = await events(env, run.id);
  for (const [verb, body] of Object.entries(bodies)) {
    assert.equal((await refused(env, "POST", `/v1/runs/${run.id}/${verb}`, "unsupported", body)).capability, verb);
  }
  // A refusal before step 4 (here: the body) is returned to the caller only.
  await refused(env, "POST", `/v1/runs/${run.id}/pause`, "invalid", { nope: true });
  const log = await events(env, run.id);
  const recorded = log.slice(before.length);
  assert.deepEqual(recorded.map((e) => e.kind), ["run.refused", "run.refused", "run.refused"]);
  const actions = recorded.map((e) => (e.data as RefusedData).action);
  assert.deepEqual(actions.map((a) => [a.kind, a.outcome, a.error?.code, a.error?.capability]), [
    ["pause", "refused", "unsupported", "pause"],
    ["resume", "refused", "unsupported", "resume"],
    ["answer", "refused", "unsupported", "answer"],
  ]);
  assert.equal(actions[0]?.idempotency_key, "pause-1");
  assert.deepEqual(actions[0]?.caller, CALLER);
  assert.ok(actions.every((a) => a.run_id === run.id && a.id.startsWith(`${AGENT}.act.`)));
  assert.equal((await getRun(env, run.id)).state, "running", "a refusal changes nothing about the run");

  // A terminal run: still refused, and nothing more is written.
  await ok(env, "POST", `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  await waitRun(env, run.id, (r) => r.terminal, "terminal");
  const ended = await events(env, run.id);
  for (const [verb, body] of Object.entries(bodies)) {
    assert.equal((await refused(env, "POST", `/v1/runs/${run.id}/${verb}`, "unsupported", body)).capability, verb);
  }
  assert.equal((await events(env, run.id)).length, ended.length);
});

test("attach replays from a cursor, follows live events, and closes after the terminal state", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  const running = await waitRun(env, run.id, (r) => r.state === "running" && r.cursor >= 3, "running with output");
  const stream = await attach(env, run.id, 1);
  await ok(env, "POST", `/v1/runs/${run.id}/steer`, 202, "control-action#accepted_response", { caller: CALLER, message: "live" });
  await ok(env, "POST", `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  await stream.closed;
  const cursors = stream.events.map((e) => e.cursor);
  assert.deepEqual(cursors, cursors.map((_, i) => i + 2), "replay then live: no gap, no duplicate, from cursor 2");
  assert.ok(cursors.length > running.cursor - 1, "live events followed the replay");
  const last = stream.events[stream.events.length - 1];
  assert.equal((last?.data as StateData).to, "cancelled");
  assert.deepEqual(stream.events, (await events(env, run.id)).slice(1), "stream equals the stored log");

  const final = await getRun(env, run.id);
  const empty = await attach(env, run.id, final.cursor);
  await empty.closed;
  assert.equal(empty.events.length, 0);
  const beyond = await refused(env, "GET", `/v1/runs/${run.id}/attach?after=${final.cursor + 1}`, "invalid");
  assert.equal(beyond.field, "after");
});
