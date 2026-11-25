import assert from "node:assert/strict";
import { test } from "node:test";

import type { Capabilities, RunEvent, StateData } from "../../src/contract/index.js";
import {
  CALLER,
  HANG,
  TIMED,
  events,
  getRun,
  killDaemon,
  makeEnv,
  ok,
  processExists,
  refused,
  startDaemon,
  submit,
  submitBody,
  waitFor,
  waitRun,
} from "./support.js";

const lastState = (log: RunEvent[]) => [...log].reverse().find((e) => e.kind === "run.state")?.data as StateData;

test("a worker survives a daemon SIGKILL: reported from disk, no live control, busy held, terminal state reached", async (t) => {
  const env = makeEnv(t, [TIMED]);
  const first = await startDaemon(t, env);
  const run = await submit(env, "fake-timed", env.repoA);
  await waitRun(env, run.id, (r) => r.state === "running", "running");
  const pid = run.worker_pid as number;
  await killDaemon(first);
  assert.ok(processExists(pid), "the worker outlived the daemon");

  await startDaemon(t, env);
  const listed = await ok<{ runs: { id: string }[] }>(env, "GET", "/v1/runs", 200, "run#run_list");
  assert.deepEqual(listed.runs.map((r) => r.id), [run.id]);
  const shown = await getRun(env, run.id);
  assert.equal(shown.state, "running", "state comes from the on-disk log");
  assert.equal(shown.live_control, false);
  assert.equal(shown.worker_pid, pid);
  assert.equal(lastState(await events(env, run.id)).to, "running");

  const steer = await refused(env, "POST", `/v1/runs/${run.id}/steer`, "unsupported", { caller: CALLER, message: "hello?" });
  assert.equal(steer.capability, "reconnect");
  const cancel = await refused(env, "POST", `/v1/runs/${run.id}/cancel`, "unsupported", { caller: CALLER });
  assert.equal(cancel.capability, "reconnect");
  // A deferred action is still refused at step 4, naming itself; without live control it is not recorded.
  assert.equal((await refused(env, "POST", `/v1/runs/${run.id}/pause`, "unsupported", { caller: CALLER })).capability, "pause");
  const busy = await refused(env, "POST", "/v1/runs", "busy", submitBody("fake-timed", env.repoA));
  assert.equal(busy.active_run_id, run.id);
  assert.ok(processExists(pid), "the restart never signalled the worker");
  assert.ok(!(await events(env, run.id)).some((e) => e.kind === "run.refused"), "refusals without live control are not written");

  const ended = await waitRun(env, run.id, (r) => r.terminal, "terminal after restart", 10_000);
  assert.equal(ended.state, "succeeded");
  const result = await ok<{ state: string; summary: string | null }>(env, "GET", `/v1/runs/${run.id}/result`, 200, "run#run_result");
  assert.equal(result.state, "succeeded");
  assert.equal(result.summary, "done");
  await waitFor(() => !processExists(pid), 5000, "worker exit");
  assert.equal((await submit(env, "fake-timed", env.repoA)).state, "queued", "the repository is free again");
});

test("a fatal error in the daemon stops it with exit 2 and never touches the worker", async (t) => {
  const env = makeEnv(t, [HANG]);
  const first = await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  await waitRun(env, run.id, (r) => r.state === "running", "running");
  const pid = run.worker_pid as number;
  first.proc.kill("SIGUSR2"); // the test child throws from a callback: an uncaught exception
  const exit = await first.exited;
  assert.equal(exit.code, 2, first.stderr());
  assert.match(first.stderr(), /fatal: uncaught exception: boom from a callback/);
  assert.ok(processExists(pid), "the worker outlived the daemon");

  await startDaemon(t, env); // the socket, the info file and both locks were released
  const shown = await getRun(env, run.id);
  assert.equal(shown.state, "running");
  assert.equal(shown.live_control, false);
  assert.ok(processExists(pid));
});

test("a worker killed with the daemon leaves its run unknown after restart, history kept", async (t) => {
  const env = makeEnv(t, [HANG]);
  const first = await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  await waitRun(env, run.id, (r) => r.state === "running" && r.cursor >= 3, "running");
  const before = await events(env, run.id);
  await killDaemon(first);
  process.kill(run.worker_pid as number, "SIGKILL");
  await waitFor(() => !processExists(run.worker_pid as number), 5000, "worker gone");

  await startDaemon(t, env);
  const shown = await getRun(env, run.id);
  assert.equal(shown.state, "unknown");
  assert.equal(shown.terminal, true);
  assert.equal(shown.live_control, false);
  const after = await events(env, run.id);
  assert.deepEqual(after.slice(0, before.length), before, "existing events are never rewritten");
  assert.equal(after.length, before.length + 1);
  const settled = after[after.length - 1]?.data as StateData;
  assert.equal(settled.from, "running");
  assert.equal(settled.to, "unknown");
  assert.ok(settled.reason !== null && settled.reason.length > 0);
  const result = await ok<{ state: string; summary: string | null }>(env, "GET", `/v1/runs/${run.id}/result`, 200, "run#run_result");
  assert.equal(result.state, "unknown");
  assert.equal((await submit(env, "fake", env.repoA)).state, "queued", "an unknown run does not hold the repository");
});

test("with the default empty catalog every submit is refused not_found and agents read unavailable", async (t) => {
  const env = makeEnv(t, null);
  await startDaemon(t, env);
  const error = await refused(env, "POST", "/v1/runs", "not_found", submitBody("fake", env.repoA));
  assert.match(error.message, /harness fake/);
  assert.deepEqual((await ok<{ harnesses: Capabilities[] }>(env, "GET", "/v1/harnesses", 200, "capabilities#capabilities_list")).harnesses, []);
  await refused(env, "GET", "/v1/harnesses/fake", "not_found");
  const agents = await ok<{ node: string; agents: { id: string; state: string; repos: string[] }[] }>(env, "GET", "/v1/agents", 200, "agent#agent_list");
  assert.equal(agents.node, "spark");
  assert.equal(agents.agents[0]?.state, "unavailable");
  assert.deepEqual(agents.agents[0]?.repos, [env.repoA, env.repoB]);
  await ok(env, "GET", `/v1/agents/${agents.agents[0]?.id ?? ""}`, 200, "agent");
  await refused(env, "GET", "/v1/agents/spark-nobody", "not_found");
});

test("submit refuses continue_session and delegate before the busy check", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  // continue_session is checked before busy, so the busy repository does not hide it.
  const cont = await refused(env, "POST", "/v1/runs", "unsupported", submitBody("fake", env.repoA, { session_id: run.session_id }));
  assert.equal(cont.capability, "continue_session");
  const del = await refused(env, "POST", "/v1/runs", "unsupported", submitBody("fake", env.repoA, { parent_run_id: run.id }));
  assert.equal(del.capability, "delegate");
  await ok(env, "POST", `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  await waitRun(env, run.id, (r) => r.terminal, "terminal");
});
