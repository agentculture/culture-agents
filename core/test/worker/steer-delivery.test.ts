/**
 * A `run.control` record means the action was accepted (contract/README.md: events; control
 * order step 9). For a steer, acceptance is the harness taking it, so the worker records it only
 * after `driver.steer()` returned. A steer the harness refused is never recorded as accepted: the
 * caller gets `unavailable` and the log gets a non-fatal `run.error` (the contract has no refusal
 * code for a failed delivery: `run.refused` carries only `unsupported` or `conflict`).
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { validate, type ActionRecord, type ErrorData, type RunEvent } from "../../src/contract/index.js";
import { readCursorFile, readLog } from "../../src/store/event-log.js";
import type { FakeDriverOptions, FakeStep } from "../../src/worker/fake-driver.js";
import { spawnWorker } from "../../src/worker/spawn.js";
import { action, fakeDriver, killAfter, newRun, stateDir, waitFor } from "./helpers.js";

const START: FakeStep[] = [{ op: "started" }, { op: "output", data: { channel: "text", text: "Working" } }];

async function running(t: TestContext, options: Omit<FakeDriverOptions, "steps"> & { steps?: FakeStep[] }) {
  const run = newRun();
  const w = await spawnWorker({ stateDir: stateDir(t), run, driver: fakeDriver({ steps: [...START, { op: "hang" }], ...options }), heartbeatMs: 50 });
  killAfter(t, w.pid, w.runDir);
  await waitFor(() => (readCursorFile(w.runDir) ?? 0) >= 3, 3000, "running");
  const events = () => readLog(w.runDir, run.id).events;
  return { ...w, run, events };
}

const controls = (events: RunEvent[], a: ActionRecord) =>
  events.filter((e) => e.kind === "run.control" && (e.data as { action: ActionRecord }).action.id === a.id);

test("a steer the harness refuses is not recorded as accepted; the caller gets unavailable", async (t) => {
  const w = await running(t, { steerError: "harness rejected the message" });
  const steer = action(w.run, "steer");
  const reply = await w.control.steer(steer, "hello");
  assert.ok(!reply.ok, "the steer is not accepted");
  assert.equal(!reply.ok && reply.error.code, "unavailable");
  assert.match(!reply.ok ? reply.error.message : "", /harness rejected the message/);
  const events = w.events();
  assert.equal(controls(events, steer).length, 0, "no run.control for a steer that was not delivered");
  const error = events.find((e) => e.kind === "run.error");
  assert.ok(error, "the failed delivery is recorded as a run.error");
  assert.equal((error.data as ErrorData).fatal, false);
  assert.match((error.data as ErrorData).error.message, /steer/);
  for (const e of events) assert.ok(validate("event", e).ok, `event ${e.cursor} validates`);
  assert.equal(readLog(w.runDir, w.run.id).tail.state, "running", "the run goes on");
});

test("a steer is recorded only once the harness took it", async (t) => {
  const w = await running(t, { steerDelayMs: 400 });
  const steer = action(w.run, "steer");
  const pending = w.control.steer(steer, "hello");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(controls(w.events(), steer).length, 0, "not recorded while delivery is in flight");
  const reply = await pending;
  assert.equal(reply.ok, true);
  assert.equal(controls(w.events(), steer).length, 1, "recorded after delivery");
});

test("a run that ends while a steer is being delivered does not record the steer as accepted", async (t) => {
  const w = await running(t, { steerDelayMs: 400, steps: [...START, { op: "sleep", ms: 150 }, { op: "completed" }] });
  const steer = action(w.run, "steer");
  const reply = await w.control.steer(steer, "hello");
  assert.ok(!reply.ok && reply.error.code === "conflict", JSON.stringify(reply));
  assert.equal(controls(readLog(w.runDir, w.run.id).events, steer).length, 0);
});
