/** A run whose stored state cannot be read is reported as such; it is never treated as absent. */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { HANG, makeEnv, processExists, refused, startDaemon, submit, submitBody, waitRun } from "./support.js";

test("an active run with a corrupt log keeps its repository busy and is not reported as missing", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  await waitRun(env, run.id, (r) => r.state === "running", "running");
  appendFileSync(join(env.stateDir, "runs", run.id, "events.jsonl"), "{not json}\n");

  const shown = await refused(env, "GET", `/v1/runs/${run.id}`, "internal");
  assert.match(shown.message, /cannot be read/);
  assert.ok(processExists(run.worker_pid as number), "its worker is still running");
  const second = await refused(env, "POST", "/v1/runs", "internal", submitBody("fake", env.repoA));
  assert.match(second.message, /may be in use/);
  // Another repository is unaffected: the unreadable run's record names its own repository.
  assert.equal((await submit(env, "fake", env.repoB)).state, "queued");
});
