/** t9: reattach to surviving workers after a core restart, before answering control requests. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Capabilities, ControlData, OutputData, RunEvent } from "../../src/contract/index.js";
import { createRunService } from "../../src/runs/index.js";
import type { HarnessCatalog } from "../../src/runs/ports.js";
import { readLog } from "../../src/store/event-log.js";
import { runDir, runFile } from "../../src/store/files.js";
import { reconnectWorker } from "../../src/worker/spawn.js";
import { CALLER, HANG, TIMED, events, getRun, killDaemon, makeEnv, ok, processExists, startDaemon, submit, submitBody, waitFor, waitRun } from "./support.js";

const FAKE_DRIVER = fileURLToPath(new URL("../../src/worker/fake-driver.js", import.meta.url));
const yes = { supported: true, reason: null, caveats: [] };
const no = { supported: false as const, reason: "deferred", caveats: [] };
const capabilitiesOf = (h: { id: string }): Capabilities => ({
  harness: h.id,
  available: true,
  version: "0.0.0-test",
  transport: "scripted fake driver",
  capabilities: { submit: yes, stream: yes, steer: yes, cancel: yes, pause: no, resume: no, answer: no, continue_session: no, delegate: no, placement: no, reconnect: yes, worktree_isolation: no },
});
const echoes = (log: RunEvent[]) => log.filter((e) => e.kind === "run.output" && (e.data as OutputData).text.startsWith("steer: ")).map((e) => (e.data as OutputData).text);
const actions = (log: RunEvent[]) => log.filter((e) => e.kind === "run.control").map((e) => (e.data as ControlData).action.kind);

test("after a restart with 2 live workers, steer, cancel and attach each reach the right run", async (t) => {
  const env = makeEnv(t, [HANG]);
  const first = await startDaemon(t, env);
  const a = await submit(env, "fake", env.repoA);
  const b = await submit(env, "fake", env.repoB);
  for (const r of [a, b]) await waitRun(env, r.id, (x) => x.state === "running", "running");
  await killDaemon(first);

  await startDaemon(t, env);
  const caps = await ok<Capabilities>(env, "GET", "/v1/harnesses/fake", 200, "capabilities");
  assert.equal(caps.capabilities.reconnect.supported, true);
  const post = (id: string, verb: string, body: object) => ok(env, "POST", `/v1/runs/${id}/${verb}`, 202, "control-action#accepted_response", { caller: CALLER, ...body });
  // The very first control request after the restart may arrive before the reattach finished.
  await post(a.id, "steer", { message: "for-a" });
  await post(b.id, "steer", { message: "for-b" });
  assert.equal((await getRun(env, a.id)).live_control, true);
  assert.deepEqual(echoes(await events(env, a.id)), ["steer: for-a"]);
  assert.deepEqual(echoes(await events(env, b.id)), ["steer: for-b"]);

  const watch = await (await import("./support.js")).attach(env, b.id, 0);
  await post(b.id, "cancel", {});
  await waitRun(env, b.id, (x) => x.terminal, "b ends");
  assert.equal((await getRun(env, b.id)).state, "cancelled");
  assert.equal((await getRun(env, a.id)).state, "running", "the other run is untouched");
  assert.deepEqual(actions(await events(env, a.id)), ["steer"]);
  await watch.closed;
  assert.ok(watch.events.some((e) => e.kind === "run.state" && (e.data as { to: string }).to === "cancelled"));
  await post(a.id, "cancel", {});
  await waitRun(env, a.id, (x) => x.terminal, "a ends");
});

test("a control request before the reattach attempt finished waits, then retry-shortly; never live control unavailable", async (t) => {
  const env = makeEnv(t, [HANG]);
  const first = await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  await waitRun(env, run.id, (x) => x.state === "running", "running");
  await killDaemon(first);

  const entry = { id: "fake", capabilities: () => Promise.resolve(capabilitiesOf(HANG)), driver: { module: FAKE_DRIVER, options: { steps: HANG.steps } } };
  const catalog: HarnessCatalog = { list: () => [entry], get: () => entry };
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const service = createRunService({
    stateDir: env.stateDir,
    node: "thor",
    catalog,
    allowlist: () => ({ status: "ok", entries: [] }) as never,
    reattachWaitMs: 150,
    reconnect: async (dir, id) => {
      await held;
      return reconnectWorker(dir, id);
    },
    warn: () => undefined,
  });
  service.reconcile();
  assert.equal((await service.getRun(run.id))?.live_control, false, "not reattached yet");
  const early = await service.steer(run.id, { caller: CALLER, message: "early" }).then(
    () => null,
    (e: { body: { code: string; retry_after_ms?: number; run_id?: string } }) => e.body,
  );
  assert.equal(early?.code, "unavailable");
  assert.equal(early?.run_id, run.id);
  assert.ok((early?.retry_after_ms ?? 0) > 0);

  const waiting = service.steer(run.id, { caller: CALLER, message: "late" }); // would time out at 150 ms...
  release();
  const accepted = await waiting; // ...but the attempt finishes first
  assert.equal(accepted.kind, "steer");
  assert.deepEqual(echoes(readLog(runDir(env.stateDir, run.id), run.id).events), ["steer: late"]);
  await service.cancel(run.id, { caller: CALLER });
});

test("a worker whose control socket does not answer is reported unknown and is never signalled; terminal runs are not rebuilt", async (t) => {
  const env = makeEnv(t, [HANG, TIMED]);
  const first = await startDaemon(t, env);
  const mute = await submit(env, "fake", env.repoA);
  const done = await submit(env, "fake", env.repoB);
  await waitRun(env, mute.id, (x) => x.state === "running", "running");
  await ok(env, "POST", `/v1/runs/${done.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  await waitRun(env, done.id, (x) => x.terminal, "terminal");
  await killDaemon(first);
  rmSync(runFile(runDir(env.stateDir, mute.id), "socket"), { force: true }); // the worker lives, its socket is gone

  const calls: string[] = [];
  const entry = { id: "fake", capabilities: () => Promise.resolve(capabilitiesOf(HANG)), driver: { module: FAKE_DRIVER, options: {} } };
  const service = createRunService({
    stateDir: env.stateDir,
    node: "thor",
    catalog: { list: () => [entry], get: () => entry },
    allowlist: () => ({ status: "ok", entries: [] }) as never,
    reconnect: (dir, id) => (calls.push(id), reconnectWorker(dir, id, 300)),
    warn: () => undefined,
  });
  service.reconcile();
  const refusal = await service.steer(mute.id, { caller: CALLER, message: "x" }).catch((e: { body: { code: string } }) => e.body);
  assert.equal((refusal as { code: string }).code, "conflict", "unknown is terminal");
  const shown = await service.getRun(mute.id);
  assert.equal(shown?.state, "unknown");
  assert.equal(shown?.live_control, false);
  assert.match(shown?.state_reason ?? "", /did not answer/);
  assert.ok(processExists(mute.worker_pid as number), "no signal was sent");
  assert.deepEqual(calls, [mute.id], "the terminal run was not reattached");
  const late = await service.cancel(done.id, { caller: CALLER }).catch((e: { body: { code: string } }) => e.body);
  assert.equal((late as { code: string }).code, "conflict");
  assert.deepEqual(calls, [mute.id]);
});

test("SIGKILL of the core signals no worker; the worker alone enforces its deadline and writes its terminal event", async (t) => {
  const env = makeEnv(t, [HANG]);
  const first = await startDaemon(t, env);
  const body = submitBody("fake", env.repoA, { deadline: new Date(Date.now() + 3500).toISOString() });
  const run = (await ok<{ run: { id: string; worker_pid: number } }>(env, "POST", "/v1/runs", 201, "control-action#submit_response", body)).run;
  await waitRun(env, run.id, (x) => x.state === "running", "running");
  await killDaemon(first);
  assert.ok(processExists(run.worker_pid), "the worker survived SIGKILL of the core");
  const dir = runDir(env.stateDir, run.id);
  await waitFor(() => readLog(dir, run.id).events.some((e) => e.kind === "run.state" && (e.data as { to: string }).to === "timed_out"), 10_000, "timed_out written with no core");
  const states = readLog(dir, run.id).events.filter((e) => e.kind === "run.state").map((e) => (e.data as { to: string }).to);
  assert.deepEqual(states, ["queued", "running", "cancelling", "timed_out"]);
});
