/** t17: the capability report states limits, active runs and admission per signal. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Capabilities, SubmitResponse } from "../../src/contract/index.js";
import { heatFromPayload, heatStatePath, readHeat, submitWarnings, readAdmission } from "../../src/runs/admission.js";
import { activeRunList } from "../../src/store/entries.js";
import { HANG, makeEnv, ok, startDaemon, submit, submitBody, waitRun, writeLimits, CALLER } from "./support.js";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const nowS = NOW.getTime() / 1000;
const payload = (over: Record<string, unknown> = {}) => JSON.stringify({ host: "thor", at: nowS - 1, stale_after_s: 10, level: "normal", admit: true, concurrency_factor: 1.0, ...over });

test("heat is read as heat-governor writes it: admit, hold, and unknown for anything missing, stale or malformed", () => {
  assert.deepEqual(heatFromPayload(payload(), NOW), { state: "admit", consulted: true, reason: null, observed_at: new Date((nowS - 1) * 1000).toISOString() });
  const hold = heatFromPayload(payload({ admit: false, level: "hot", concurrency_factor: 0.0 }), NOW);
  assert.equal(hold.state, "hold");
  assert.match(hold.reason ?? "", /hot/);
  const stale = heatFromPayload(payload({ at: nowS - 11 }), NOW);
  assert.equal(stale.state, "unknown");
  assert.match(stale.reason ?? "", /stale/);
  for (const bad of ["not json", "[]", payload({ at: "2026-11-26T12:00:00Z" }), payload({ admit: "yes" }), payload({ stale_after_s: 0 }), payload({ at: nowS + 100 })]) {
    assert.equal(heatFromPayload(bad, NOW).state, "unknown", bad);
  }
});

test("the heat path follows the publisher: HEAT_GOVERNOR_STATE, else XDG_RUNTIME_DIR/heat-governor/state.json", () => {
  assert.equal(heatStatePath({ HEAT_GOVERNOR_STATE: "/x/s.json", XDG_RUNTIME_DIR: "/r" }), "/x/s.json");
  assert.equal(heatStatePath({ XDG_RUNTIME_DIR: "/r" }), "/r/heat-governor/state.json");
  assert.equal(heatStatePath({}), null);
  assert.equal(readHeat({}, NOW).state, "unknown");
  assert.equal(readHeat({ HEAT_GOVERNOR_STATE: "/x" }, NOW, () => { throw new Error("ENOENT"); }).state, "unknown");
});

test("the gateway is not consulted without a harness that uses it, and only a consulted unknown signal warns", async () => {
  const admission = await readAdmission({ HEAT_GOVERNOR_STATE: "/x" }, NOW, () => payload());
  assert.deepEqual([admission.gateway.consulted, admission.gateway.state], [false, "unknown"]);
  assert.deepEqual(submitWarnings(admission), []);
  const unknown = await readAdmission({}, NOW);
  assert.deepEqual(submitWarnings(unknown).map((w) => [w.code, w.signal]), [["signal_unknown", "heat"]]);
});

test("the report states limits (or none), the active count and each signal; a local submit under unknown heat carries a warning", async (t) => {
  const env = makeEnv(t, [HANG]);
  const heat = join(env.root, "heat.json");
  env.vars["HEAT_GOVERNOR_STATE"] = heat;
  await startDaemon(t, env);
  const report = () => ok<Capabilities>(env, "GET", "/v1/harnesses/fake", 200, "capabilities");
  // No file: unknown; no limit configured: null; no runs.
  let doc = await report();
  assert.deepEqual(doc.limits, { runs_per_repository: null, runs_per_host: null });
  assert.equal(doc.active_runs, 0);
  assert.equal(doc.admission?.heat.state, "unknown");
  assert.equal(doc.admission?.gateway.consulted, false);
  // A local submit under unknown is admitted, with the warning.
  const first = await ok<SubmitResponse>(env, "POST", "/v1/runs", 201, "control-action#submit_response", submitBody("fake", env.repoA));
  assert.deepEqual(first.warnings?.map((w) => [w.code, w.signal]), [["signal_unknown", "heat"]]);
  await waitRun(env, first.run.id, (r) => r.state === "running", "running");
  assert.equal((await report()).active_runs, 1);
  assert.equal(activeRunList(env.stateDir).length, 1, "the report and the tracing gauge count through one function");
  // A fresh heat reading: admit, no warning; then hold.
  writeFileSync(heat, payload({ at: Date.now() / 1000 }));
  doc = await report();
  assert.equal(doc.admission?.heat.state, "admit");
  const second = await ok<SubmitResponse>(env, "POST", "/v1/runs", 201, "control-action#submit_response", submitBody("fake", env.repoA));
  assert.equal(second.warnings, undefined);
  writeFileSync(heat, payload({ at: Date.now() / 1000, admit: false, level: "hot" }));
  assert.equal((await report()).admission?.heat.state, "hold");
  for (const run of [first.run, second.run]) await ok(env, "POST", `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
});

test("configured limits appear in the report", async (t) => {
  const env = makeEnv(t, [HANG]);
  writeLimits(env, { runsPerRepository: 2 });
  await startDaemon(t, env);
  const doc = await ok<Capabilities>(env, "GET", "/v1/harnesses/fake", 200, "capabilities");
  assert.deepEqual(doc.limits, { runs_per_repository: 2, runs_per_host: null });
  const run = await submit(env, "fake", env.repoA);
  await ok(env, "POST", `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
});
