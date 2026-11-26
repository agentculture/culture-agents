/** t8: concurrent runs in one repository; no limit unless the operator configures one in the core's config file. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutputData, Run, RunEvent } from "../../src/contract/index.js";
import { listRunIds } from "../../src/store/run-store.js";
import { CALLER, HANG, events, makeEnv, ok, refused, startDaemon, submit, submitBody, waitFor, waitRun, writeLimits, type Env } from "./support.js";

const steerTexts = (log: RunEvent[]) => log.filter((e) => e.kind === "run.output" && (e.data as OutputData).text.startsWith("steer: ")).map((e) => (e.data as OutputData).text);

async function cancelAll(env: Env, runs: Run[]): Promise<void> {
  for (const run of runs) await ok(env, "POST", `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  for (const run of runs) await waitRun(env, run.id, (r) => r.terminal, `${run.id} terminal`);
}

test("with no limit configured, 3 submits to 1 repository are all accepted and each is steered independently", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const runs = [await submit(env, "fake", env.repoA), await submit(env, "fake", env.repoA), await submit(env, "fake", env.repoA)];
  assert.equal(new Set(runs.map((r) => r.id)).size, 3);
  for (const run of runs) {
    assert.equal(run.state, "queued");
    assert.equal(run.repo, env.repoA);
  }
  for (const run of runs) await waitRun(env, run.id, (r) => r.state === "running", `${run.id} running`);
  for (const [i, run] of runs.entries()) {
    await ok(env, "POST", `/v1/runs/${run.id}/steer`, 202, "control-action#accepted_response", { caller: CALLER, message: `for run ${i}` });
  }
  for (const [i, run] of runs.entries()) {
    await waitFor(async () => steerTexts(await events(env, run.id)).length > 0, 5000, `run ${i} to record its steer`);
    assert.deepEqual(steerTexts(await events(env, run.id)), [`steer: for run ${i}`], "each run received only its own steer");
  }
  // Cancelling one leaves the others running.
  await ok(env, "POST", `/v1/runs/${runs[0]?.id ?? ""}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  assert.equal((await waitRun(env, runs[0]?.id ?? "", (r) => r.terminal, "first terminal")).state, "cancelled");
  for (const run of runs.slice(1)) assert.equal((await waitRun(env, run.id, () => true, "shown")).state, "running");
  await cancelAll(env, runs.slice(1));
});

test("a per-repository limit refuses the submit past it with limit_reached naming the limit; nothing is queued", async (t) => {
  const env = makeEnv(t, [HANG]);
  writeLimits(env, { runsPerRepository: 2 });
  await startDaemon(t, env);
  const runs = [await submit(env, "fake", env.repoA), await submit(env, "fake", env.repoA)];
  const error = await refused(env, "POST", "/v1/runs", "limit_reached", submitBody("fake", env.repoA));
  assert.deepEqual(error.limit, { name: "runs_per_repository", value: 2, active: 2, repo: env.repoA });
  assert.equal(error.retryable, true);
  assert.match(error.message, /runs_per_repository/);
  assert.match(error.message, /\b2\b/);
  assert.equal(listRunIds(env.stateDir).length, 2, "nothing was queued or created for the refused submit");
  // The limit is per repository: another repository still has room.
  runs.push(await submit(env, "fake", env.repoB));
  // Room again once a run ends.
  await cancelAll(env, runs.slice(0, 1));
  runs.push(await submit(env, "fake", env.repoA));
  await cancelAll(env, runs.slice(1));
});

test("a per-host limit refuses the submit past it across repositories; nothing is queued", async (t) => {
  const env = makeEnv(t, [HANG]);
  writeLimits(env, { runsPerHost: 2 });
  await startDaemon(t, env);
  const runs = [await submit(env, "fake", env.repoA), await submit(env, "fake", env.repoB)];
  const error = await refused(env, "POST", "/v1/runs", "limit_reached", submitBody("fake", env.repoB));
  assert.deepEqual(error.limit, { name: "runs_per_host", value: 2, active: 2 });
  assert.match(error.message, /runs_per_host/);
  assert.equal(listRunIds(env.stateDir).length, 2);
  await cancelAll(env, runs);
});

test("a limit cannot come from a request: the submit body is closed", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  await refused(env, "POST", "/v1/runs", "invalid", submitBody("fake", env.repoA, { limits: { runs_per_repository: 5 } }));
  assert.equal(listRunIds(env.stateDir).length, 0);
});
