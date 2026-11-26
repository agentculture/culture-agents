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
  writeLimits,
} from "./support.js";

const lastState = (log: RunEvent[]) => [...log].reverse().find((e) => e.kind === "run.state")?.data as StateData;

test("a worker survives a daemon SIGKILL: reported from disk, control reattached, counted against a limit, terminal state reached", async (t) => {
  const env = makeEnv(t, [TIMED]);
  writeLimits(env, { runsPerRepository: 1 });
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
  assert.equal(shown.worker_pid, pid);
  assert.equal(lastState(await events(env, run.id)).to, "running");

  await waitRun(env, run.id, (r) => r.live_control, "live control after reattach");
  await ok(env, "POST", `/v1/runs/${run.id}/steer`, 202, "control-action#accepted_response", { caller: CALLER, message: "hello?" });
  // A deferred action is still refused at step 4, naming itself.
  assert.equal((await refused(env, "POST", `/v1/runs/${run.id}/pause`, "unsupported", { caller: CALLER })).capability, "pause");
  // The surviving run counts against the configured limit (written before the first start).
  const limited = await refused(env, "POST", "/v1/runs", "limit_reached", submitBody("fake-timed", env.repoA));
  assert.deepEqual(limited.limit, { name: "runs_per_repository", value: 1, active: 1, repo: env.repoA });
  assert.ok(processExists(pid), "the restart never signalled the worker");

  const ended = await waitRun(env, run.id, (r) => r.terminal, "terminal after restart", 10_000);
  assert.equal(ended.state, "succeeded");
  const result = await ok<{ state: string; summary: string | null }>(env, "GET", `/v1/runs/${run.id}/result`, 200, "run#run_result");
  assert.equal(result.state, "succeeded");
  assert.equal(result.summary, "done");
  await waitFor(() => !processExists(pid), 5000, "worker exit");
  assert.equal((await submit(env, "fake-timed", env.repoA)).state, "queued", "the repository has room again");
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
  await waitRun(env, run.id, (r) => r.live_control, "live control after reattach");
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
  assert.equal(agents.node, "thor");
  assert.equal(agents.agents[0]?.state, "unavailable");
  assert.deepEqual(agents.agents[0]?.repos, [env.repoA, env.repoB]);
  await ok(env, "GET", `/v1/agents/${agents.agents[0]?.id ?? ""}`, 200, "agent");
  await refused(env, "GET", "/v1/agents/thor-nobody", "not_found");
});

test("submit refuses continue_session and delegate before the limit check", async (t) => {
  const env = makeEnv(t, [HANG]);
  writeLimits(env, { runsPerRepository: 1 });
  await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  // continue_session is checked before the limit, so the full repository does not hide it.
  const cont = await refused(env, "POST", "/v1/runs", "unsupported", submitBody("fake", env.repoA, { session_id: run.session_id }));
  assert.equal(cont.capability, "continue_session");
  const del = await refused(env, "POST", "/v1/runs", "unsupported", submitBody("fake", env.repoA, { parent_run_id: run.id }));
  assert.equal(del.capability, "delegate");
  await ok(env, "POST", `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  await waitRun(env, run.id, (r) => r.terminal, "terminal");
});
