/** A run whose stored state cannot be read is reported as such; it is never treated as absent. */
import assert from "node:assert/strict";
import { appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { StateData } from "../../src/contract/index.js";
import { CALLER, HANG, attach, events, getRun, makeEnv, ok, processExists, refused, startDaemon, submit, submitBody, waitFor, waitRun } from "./support.js";

test("an active run with a corrupt log keeps its repository busy and is not reported as missing", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  await waitRun(env, run.id, (r) => r.state === "running", "running");
  appendFileSync(join(env.stateDir, "runs", run.id, "events.jsonl"), "{not json}\n");

  const shown = await refused(env, "GET", `/v1/runs/${run.id}`, "internal");
  assert.match(shown.message, /cannot be read/);
  // Every route that names the run says the same thing; none reports it as missing.
  await refused(env, "GET", `/v1/runs/${run.id}/events`, "internal");
  await refused(env, "GET", `/v1/runs/${run.id}/result`, "internal");
  await refused(env, "GET", `/v1/runs/${run.id}/attach`, "internal");
  assert.ok(processExists(run.worker_pid as number), "its worker is still running");
  const second = await refused(env, "POST", "/v1/runs", "internal", submitBody("fake", env.repoA));
  assert.match(second.message, /may be in use/);
  // Another repository is unaffected: the unreadable run's record names its own repository.
  assert.equal((await submit(env, "fake", env.repoB)).state, "queued");
});

test("a live worker whose liveness evidence cannot be read is never settled as unknown", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  await waitRun(env, run.id, (r) => r.state === "running" && r.cursor >= 3, "running");
  const stream = await attach(env, run.id, 0);
  // The stream must be past its replay before the fault: on a slow runner the core otherwise
  // handles the attach after it, refuses it as unreadable, and the stream never carries an event.
  await waitFor(() => stream.events.length >= 3, 5000, "the attach stream to replay");
  // The identity file exists but reading it fails (EACCES): that is not "no worker". The mode
  // change is one step, so no reader ever sees the file missing (replacing it with a directory
  // left a moment without it, in which the attach follower rightly settled the run as unknown).
  const identity = join(env.stateDir, "runs", run.id, "worker.json");
  chmodSync(identity, 0o000);

  const shown = await refused(env, "GET", `/v1/runs/${run.id}`, "internal");
  assert.match(shown.message, /liveness cannot be established/);
  await refused(env, "POST", `/v1/runs/${run.id}/cancel`, "internal", { caller: CALLER });
  await refused(env, "POST", "/v1/runs", "internal", submitBody("fake", env.repoA));
  await new Promise((resolve) => setTimeout(resolve, 600)); // several orphan checks of the attach follower
  assert.ok(processExists(run.worker_pid as number), "the worker is still running");

  chmodSync(identity, 0o600);
  assert.equal((await getRun(env, run.id)).state, "running");
  assert.deepEqual((await events(env, run.id)).filter((e) => e.kind === "run.state").map((e) => (e.data as StateData).to), ["queued", "running"]);
  // The stream stayed open through the failed checks and still ends with the real outcome.
  await ok(env, "POST", `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  await stream.closed;
  assert.equal((stream.events.at(-1)?.data as StateData).to, "cancelled");
  assert.deepEqual(stream.events, await events(env, run.id));
});
