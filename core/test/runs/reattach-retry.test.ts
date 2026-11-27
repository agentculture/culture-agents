/**
 * Reattach after a core restart when a live worker misses its first ping (pr-15 review, must-fix 3
 * and should-fix 1): a live worker is never reported `unknown`, control calls get `unavailable` with
 * `retry_after_ms`, and the reattach is retried until the worker answers.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { validate, type Capabilities, type Run } from "../../src/contract/index.js";
import { createRunService } from "../../src/runs/index.js";
import type { HarnessCatalog } from "../../src/runs/ports.js";
import { runDir, runFile } from "../../src/store/files.js";
import { reconnectWorker } from "../../src/worker/spawn.js";
import { CALLER, HANG, killDaemon, makeEnv, processExists, startDaemon, submit, submitBody, ok, waitFor, waitRun, type FakeHarness } from "./support.js";

const FAKE_DRIVER = fileURLToPath(new URL("../../src/worker/fake-driver.js", import.meta.url));
const yes = { supported: true, reason: null, caveats: [] };
const no = { supported: false as const, reason: "deferred", caveats: [] };
const capabilities: Capabilities = {
  harness: "fake",
  available: true,
  version: "0.0.0-test",
  transport: "scripted fake driver",
  capabilities: { submit: yes, stream: yes, steer: yes, cancel: yes, pause: no, resume: no, answer: no, continue_session: no, delegate: no, placement: no, reconnect: yes, worktree_isolation: no },
};
const STUB: FakeHarness = { id: "stub-ask", steps: [], stub: true, ask: true };
const TASK = "ask: Which colour should the banner use?\nchoices: red, green\nfiles: banner.txt";

function serviceFor(stateDir: string, calls: string[] = []) {
  const entry = { id: "fake", capabilities: () => Promise.resolve(capabilities), driver: { module: FAKE_DRIVER, options: { steps: HANG.steps } } };
  const catalog: HarnessCatalog = { list: () => [entry], get: () => entry };
  return createRunService({
    stateDir,
    node: "thor",
    catalog,
    allowlist: () => ({ status: "ok", entries: [] }) as never,
    reattachWaitMs: 2000,
    reconnect: (dir, id) => (calls.push(id), reconnectWorker(dir, id, 300)),
    warn: () => undefined,
  });
}

/** Let a stopped worker run again so its cleanup can kill it; it may already be gone. */
function resume(pid: number): void {
  try {
    process.kill(pid, "SIGCONT");
  } catch {
    // already exited
  }
}

const codeOf = (p: Promise<unknown>) => p.then(
  () => null,
  (e: { body: { code: string; retry_after_ms?: number; run_id?: string } }) => e.body,
);

test("a live worker that misses its first ping is never reported unknown, is refused unavailable, and is reattached once it answers", async (t) => {
  const env = makeEnv(t, [HANG]);
  const first = await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  await waitRun(env, run.id, (x) => x.state === "running", "running");
  await killDaemon(first);
  const pid = run.worker_pid as number;
  process.kill(pid, "SIGSTOP");
  t.after(() => resume(pid));

  const calls: string[] = [];
  const service = serviceFor(env.stateDir, calls);
  service.reconcile();
  await waitFor(() => calls.length >= 1, 2000, "first attempt started");
  await new Promise((resolve) => setTimeout(resolve, 600)); // the 300 ms ping has timed out
  const silent = (await service.getRun(run.id)) as Run;
  assert.equal(silent.state, "running", "a live worker is reported in its logged state");
  assert.equal(silent.terminal, false);
  assert.equal(silent.live_control, false);
  assert.ok(validate("run", silent).ok);
  const cancel = await codeOf(service.cancel(run.id, { caller: CALLER }));
  assert.equal(cancel?.code, "unavailable");
  assert.equal(cancel?.run_id, run.id);
  assert.ok((cancel?.retry_after_ms ?? 0) > 0);
  const result = await codeOf(service.getResult(run.id));
  assert.equal(result?.code, "conflict", "no result for a run that is still working");
  assert.ok(calls.length >= 2, "the control call retried the reattach");

  process.kill(pid, "SIGCONT");
  // The bounded backoff reattaches with no control call.
  await waitFor(async () => (await service.getRun(run.id))?.live_control === true, 10_000, "reattached by backoff");
  const accepted = await service.cancel(run.id, { caller: CALLER });
  assert.equal(accepted.action.kind, "cancel");
  await waitFor(async () => (await service.getRun(run.id))?.state === "cancelled", 10_000, "cancelled");
});

test("a stopped worker is reattached by the next control call after it resumes", async (t) => {
  const env = makeEnv(t, [HANG]);
  const first = await startDaemon(t, env);
  const run = await submit(env, "fake", env.repoA);
  await waitRun(env, run.id, (x) => x.state === "running", "running");
  await killDaemon(first);
  const pid = run.worker_pid as number;
  process.kill(pid, "SIGSTOP");
  t.after(() => resume(pid));
  const calls: string[] = [];
  const service = serviceFor(env.stateDir, calls);
  service.reconcile();
  await waitFor(() => calls.length >= 1, 2000, "first attempt started");
  await new Promise((resolve) => setTimeout(resolve, 600));
  process.kill(pid, "SIGCONT");
  const accepted = await service.steer(run.id, { caller: CALLER, message: "after" });
  assert.equal(accepted.action.kind, "steer");
  await service.cancel(run.id, { caller: CALLER });
});

test("every run read while its live worker's control socket is silent validates against the run schema", async (t) => {
  const env = makeEnv(t, [STUB]);
  const first = await startDaemon(t, env);
  const run = (await ok<{ run: Run }>(env, "POST", "/v1/runs", 201, "control-action#submit_response", submitBody("stub-ask", env.repoA, { task: TASK }))).run;
  await waitRun(env, run.id, (r) => (r.pending_questions ?? []).length === 1, "a pending question");
  await killDaemon(first);
  rmSync(runFile(runDir(env.stateDir, run.id), "socket"), { force: true }); // alive, silent

  const calls: string[] = [];
  const service = serviceFor(env.stateDir, calls);
  service.reconcile();
  await waitFor(() => calls.length >= 1, 2000, "first attempt started");
  await new Promise((resolve) => setTimeout(resolve, 600));
  const shown = [(await service.getRun(run.id)) as Run, ...(await service.listRuns({} as never))];
  for (const r of shown) {
    const verdict = validate("run", r);
    assert.ok(verdict.ok, `run ${r.id} (${r.state}) validates: ${JSON.stringify(verdict)}`);
    if (r.terminal) assert.deepEqual(r.pending_questions ?? [], []);
  }
  assert.equal(shown[0]?.state, "running");
  assert.ok(processExists(run.worker_pid as number), "no signal was sent");
});
