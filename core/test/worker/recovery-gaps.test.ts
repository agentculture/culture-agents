/**
 * Two recovery gaps recorded after D1: a cancel whose grace period ends while the driver is still
 * in its retention cleanup must leave a retention record, and the worker's `conflict` replies on a
 * refused append are asserted.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import type { RunEvent, StateData } from "../../src/contract/index.js";
import { readCursorFile } from "../../src/store/event-log.js";
import { FILE_MODE, runFile } from "../../src/store/files.js";
import { createRun, followEvents } from "../../src/store/run-store.js";
import { controlRequest } from "../../src/worker/control.js";
import { readRetained } from "../../src/worker/retained.js";
import { RunWorker } from "../../src/worker/run-loop.js";
import type { FakeStep } from "../../src/worker/fake-driver.js";
import { spawnWorker } from "../../src/worker/spawn.js";
import { action, fakeDriver, killAfter, newRun, stateDir, waitFor } from "./helpers.js";

const START: FakeStep[] = [{ op: "started" }, { op: "hang" }];

async function drain(runDir: string, runId: string): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  const signal = AbortSignal.timeout(8000);
  for await (const e of followEvents(runDir, runId, 0, { pollMs: 5, orphanCheckMs: 0, signal })) out.push(e);
  return out;
}

test("a cancel whose grace period ends during retention cleanup leaves a retention record", async (t) => {
  const dir = stateDir(t);
  const run = newRun();
  const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
  // Cleanup (the stop) takes 3 s; the grace period is 150 ms, so the worker forces the run down first.
  const driver = fakeDriver({ steps: START, stopDelayMs: 3000, retainOnCancel: { sandbox: "sandbox-kept", until } });
  const w = await spawnWorker({ stateDir: dir, run, driver, cancelGraceMs: 150 });
  killAfter(t, w.pid, w.runDir);
  assert.equal(readRetained(w.runDir), null, "no retention before the cancel");
  assert.equal((await w.control.cancel(action(run, "cancel"))).ok, true);
  const events = await drain(w.runDir, run.id);
  const last = events.at(-1)?.data as StateData;
  assert.equal(last.to, "cancelled");
  assert.match(last.reason ?? "", /forced/, "the grace period ended before the cleanup did");
  const retained = readRetained(w.runDir);
  assert.deepEqual(retained && { sandbox: retained.sandbox, until: retained.until }, { sandbox: "sandbox-kept", until: Date.parse(until) });
});

test("a cancel forced down with nothing kept leaves no retention record", async (t) => {
  const dir = stateDir(t);
  const run = newRun();
  const w = await spawnWorker({ stateDir: dir, run, driver: fakeDriver({ steps: START, stopDelayMs: 3000 }), cancelGraceMs: 150 });
  killAfter(t, w.pid, w.runDir);
  assert.equal((await w.control.cancel(action(run, "cancel"))).ok, true);
  await drain(w.runDir, run.id);
  assert.equal(readRetained(w.runDir), null);
});

test("a refusal for a run that has ended is answered conflict, not retryable, naming the run", async (t) => {
  const run = newRun();
  const dir = createRun(stateDir(t), run);
  writeFileSync(runFile(dir, "driver"), JSON.stringify(fakeDriver({ steps: [{ op: "started" }, { op: "completed" }] })), { mode: FILE_MODE });
  const worker = new RunWorker({ stateDir: dir.replace(/\/runs\/[^/]+$/, ""), runId: run.id });
  await worker.open();
  t.after(() => worker.close());
  assert.equal(await worker.run(), "succeeded");
  const refused = { ...action(run, "steer", "refused"), error: { code: "conflict" as const, message: "Not running.", retryable: true, run_id: run.id } };
  const reply = await controlRequest(dir, { op: "refuse", action: refused });
  assert.equal(reply.ok, false);
  assert.ok(!reply.ok && reply.error.code === "conflict" && reply.error.retryable === false && reply.error.run_id === run.id);
  assert.match(!reply.ok ? reply.error.message : "", /already succeeded/);
});

test("a steer in delivery when the run ends is answered conflict and not recorded as accepted", async (t) => {
  const run = newRun();
  const steps: FakeStep[] = [{ op: "started" }, { op: "sleep", ms: 300 }, { op: "completed" }];
  const w = await spawnWorker({ stateDir: stateDir(t), run, driver: fakeDriver({ steps, steerDelayMs: 1500 }) });
  killAfter(t, w.pid, w.runDir);
  await waitFor(() => (readCursorFile(w.runDir) ?? 0) >= 2, 3000, "running");
  const reply = await w.control.steer(action(run, "steer"), "late");
  assert.equal(reply.ok, false);
  assert.ok(!reply.ok && reply.error.code === "conflict" && reply.error.retryable === false);
  const events = await drain(w.runDir, run.id);
  assert.equal(events.some((e) => e.kind === "run.control"), false);
});
