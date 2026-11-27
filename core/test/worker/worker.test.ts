import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { validate, type RunEvent, type RunState, type StateData } from "../../src/contract/index.js";
import { readCursorFile, readLog } from "../../src/store/event-log.js";
import { runFile } from "../../src/store/files.js";
import { checkLiveness, readWorkerIdentity } from "../../src/store/liveness.js";
import { followEvents, readRecord, showRunAt } from "../../src/store/run-store.js";
import type { FakeStep } from "../../src/worker/fake-driver.js";
import { reconnectWorker, spawnWorker, type SpawnWorkerOptions } from "../../src/worker/spawn.js";
import { DAEMON_HELPER, action, fakeDriver, killAfter, newRun, processExists, stateDir, waitFor } from "./helpers.js";

const START: FakeStep[] = [{ op: "started" }, { op: "output", data: { channel: "text", text: "Working" } }];

async function start(t: TestContext, steps: FakeStep[], extra: Partial<SpawnWorkerOptions> = {}) {
  const dir = stateDir(t);
  const run = extra.run ?? newRun();
  const worker = await spawnWorker({ stateDir: dir, run, driver: fakeDriver({ steps }), heartbeatMs: 50, ...extra });
  killAfter(t, worker.pid, worker.runDir);
  return { ...worker, run, stateDir: dir };
}

/**
 * Deadline for tests that expect the harness to start first: worker spawn plus driver import must
 * fit before it, which takes well over 300 ms on a loaded host (the full suite runs files in
 * parallel), so the run would correctly go queued -> cancelling and the test would misfire.
 */
const START_THEN_DEADLINE_MS = 1500;

const states = (events: RunEvent[]) => events.filter((e) => e.kind === "run.state").map((e) => (e.data as StateData).to);

/** Follow a run's log to its terminal event. */
async function drain(runDir: string, runId: string, timeoutMs = 5000): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  const signal = AbortSignal.timeout(timeoutMs);
  for await (const e of followEvents(runDir, runId, 0, { pollMs: 5, orphanCheckMs: 0, signal })) out.push(e);
  return out;
}

/** Every line on disk validates and the record validates. */
function assertAllValid(runDir: string, runId: string): void {
  const log = readLog(runDir, runId);
  for (const e of log.events) assert.ok(validate("event", e).ok, `event ${e.cursor} validates`);
  assert.equal(log.torn, false);
  assert.ok(validate("run", readRecord(runDir)).ok, "record validates");
}

test("when spawnWorker resolves, pid, event log and cursor are on disk and owner-only", async (t) => {
  const w = await start(t, [...START, { op: "hang" }]);
  for (const file of ["worker", "events", "cursor", "record", "driver"] as const) {
    assert.ok(existsSync(runFile(w.runDir, file)), `${file} exists`);
    assert.equal(statSync(runFile(w.runDir, file)).mode & 0o777, 0o600, `${file} is 0600`);
  }
  assert.equal(statSync(runFile(w.runDir, "socket")).mode & 0o777, 0o600, "control socket is 0600");
  assert.equal(statSync(w.runDir).mode & 0o777, 0o700);
  assert.equal(readWorkerIdentity(w.runDir)?.pid, w.pid);
  const first = readLog(w.runDir, w.run.id).events[0];
  assert.deepEqual(first?.data, { from: null, to: "queued", reason: null });
  assert.equal(first?.cursor, 1);
  assert.ok((readCursorFile(w.runDir) ?? 0) >= 1);
  assert.equal(checkLiveness(w.runDir).alive, true);
  const reply = await w.control.ping();
  assert.ok(reply.ok && reply.pid === w.pid);
});

test("a scripted run succeeds and every event and record written validates", async (t) => {
  const w = await start(t, [...START, { op: "sleep", ms: 20 }, { op: "completed", summary: "done" }]);
  const events = await drain(w.runDir, w.run.id);
  assert.deepEqual(states(events), ["queued", "running", "succeeded"]);
  assert.deepEqual(events.map((e) => e.cursor), events.map((_, i) => i + 1));
  await waitFor(() => !processExists(w.pid), 3000, "worker exit");
  assertAllValid(w.runDir, w.run.id);
  const shown = showRunAt(w.runDir);
  assert.equal(shown?.run.state, "succeeded");
  assert.equal(readRecord(w.runDir).state, "succeeded");
  assert.equal(existsSync(runFile(w.runDir, "socket")), false, "socket removed at exit");
});

test("with the daemon process SIGKILLed, the worker keeps appending and reaches its terminal event", async (t) => {
  const dir = stateDir(t);
  const run = newRun();
  const steps: FakeStep[] = [...START, { op: "sleep", ms: 300 }, { op: "output", data: { channel: "text", text: "after" } }, { op: "completed" }];
  const options: SpawnWorkerOptions = { stateDir: dir, run, driver: fakeDriver({ steps }), heartbeatMs: 50 };
  const daemon = spawn(process.execPath, [DAEMON_HELPER, JSON.stringify(options)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => daemon.kill("SIGKILL"));
  const [line] = (await once(daemon.stdout, "data")) as [Buffer];
  const info = JSON.parse(line.toString()) as { pid: number; runDir: string };
  killAfter(t, info.pid, info.runDir);
  const cursorAtKill = readCursorFile(info.runDir) ?? 0;
  daemon.kill("SIGKILL");
  await once(daemon, "exit");
  assert.equal(checkLiveness(info.runDir).alive, true, "worker survives the daemon");
  const events = await drain(info.runDir, run.id);
  assert.ok(events.length > cursorAtKill, "events were appended after the daemon died");
  assert.ok(events.some((e) => e.kind === "run.output" && (e.data as { text: string }).text === "after"));
  assert.equal(states(events).at(-1), "succeeded");
  assertAllValid(info.runDir, run.id);
});

test("a worker SIGKILLed mid-run reads unknown, never succeeded, and earlier events stay intact", async (t) => {
  const w = await start(t, [...START, { op: "hang" }]);
  await waitFor(() => (readCursorFile(w.runDir) ?? 0) >= 3, 3000, "running with output");
  const before = readLog(w.runDir, w.run.id).events;
  process.kill(w.pid, "SIGKILL");
  await waitFor(() => !checkLiveness(w.runDir).alive, 3000, "worker death");
  const shown = showRunAt(w.runDir);
  assert.equal(shown?.run.state, "unknown");
  assert.notEqual(shown?.run.state, "succeeded");
  assert.equal(shown?.orphaned, true);
  assert.deepEqual(readLog(w.runDir, w.run.id).events, before, "the reader did not write");
  const settled = showRunAt(w.runDir, { settle: true });
  assert.equal(settled?.run.state, "unknown");
  assert.equal(settled?.orphaned, false);
  const after = readLog(w.runDir, w.run.id).events;
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.length, before.length + 1);
  assert.equal((await reconnectWorker(w.stateDir, w.run.id)).live, false);
  assertAllValid(w.runDir, w.run.id);
});

test("deadline expiry moves the run through cancelling (reason deadline) to timed_out", async (t) => {
  const run = newRun({ deadline: new Date(Date.now() + START_THEN_DEADLINE_MS).toISOString() });
  const w = await start(t, [...START, { op: "hang" }], { run });
  const events = await drain(w.runDir, w.run.id);
  assert.deepEqual(states(events), ["queued", "running", "cancelling", "timed_out"]);
  const cancelling = events.find((e) => e.kind === "run.state" && (e.data as StateData).to === "cancelling");
  assert.equal((cancelling?.data as StateData).reason, "deadline");
  assertAllValid(w.runDir, w.run.id);
});

test("a harness that ignores the stop is forced down after the grace period and still ends timed_out", async (t) => {
  const run = newRun({ deadline: new Date(Date.now() + START_THEN_DEADLINE_MS).toISOString() });
  const dir = stateDir(t);
  const w = await spawnWorker({ stateDir: dir, run, driver: fakeDriver({ steps: [...START, { op: "hang" }], ignoreCancel: true }), cancelGraceMs: 150 });
  killAfter(t, w.pid, w.runDir);
  const events = await drain(w.runDir, run.id);
  assert.deepEqual(states(events), ["queued", "running", "cancelling", "timed_out"]);
  assert.match((events.at(-1)?.data as StateData).reason ?? "", /forced/);
});

test("cancel over the control socket is recorded and ends the run cancelled", async (t) => {
  const w = await start(t, [...START, { op: "hang" }]);
  await waitFor(() => (readCursorFile(w.runDir) ?? 0) >= 3, 3000, "running");
  const reply = await w.control.cancel(action(w.run, "cancel"), "not needed");
  assert.equal(reply.ok, true);
  const again = await w.control.cancel(action(w.run, "cancel"));
  assert.ok(again.ok || again.error.code === "conflict", "a second cancel is accepted while cancelling, or the run already ended");
  const events = await drain(w.runDir, w.run.id);
  assert.deepEqual(states(events), ["queued", "running", "cancelling", "cancelled"]);
  assert.ok(events.some((e) => e.kind === "run.control"));
  const cancelling = events.find((e) => e.kind === "run.state" && (e.data as StateData).to === "cancelling");
  assert.equal((cancelling?.data as StateData).reason, "cancel requested by thor-operator: not needed");
  assertAllValid(w.runDir, w.run.id);
});

test("steer reaches a running harness; a queued run refuses it with a retryable conflict", async (t) => {
  const queued = await start(t, [{ op: "sleep", ms: 5000 }]);
  const early = await queued.control.steer(action(queued.run, "steer"), "hello");
  assert.ok(!early.ok && early.error.code === "conflict" && early.error.retryable);
  const refused = { ...action(queued.run, "steer", "refused"), error: { code: "conflict" as const, message: "Not running.", retryable: true, run_id: queued.run.id } };
  assert.equal((await queued.control.refuse(refused)).ok, true);
  assert.ok(readLog(queued.runDir, queued.run.id).events.some((e) => e.kind === "run.refused"));

  const w = await start(t, [...START, { op: "sleep", ms: 300 }, { op: "completed" }]);
  await waitFor(() => (readCursorFile(w.runDir) ?? 0) >= 3, 3000, "running");
  assert.equal((await w.control.steer(action(w.run, "steer"), "hello")).ok, true);
  const events = await drain(w.runDir, w.run.id);
  assert.ok(events.some((e) => e.kind === "run.control"));
  assert.ok(events.some((e) => e.kind === "run.output" && (e.data as { text: string }).text === "steer: hello"));
  assert.equal(states(events).at(-1), "succeeded");
});

test("a harness failure or driver crash is recorded as a fatal error and the run fails", async (t) => {
  const failure: FakeStep = { op: "failed", error: { code: "unavailable", message: "Harness down.", retryable: true } };
  for (const steps of [[...START, failure], [...START, { op: "throw", message: "boom" } as FakeStep]]) {
    const w = await start(t, steps);
    const events = await drain(w.runDir, w.run.id);
    assert.equal(states(events).at(-1), "failed" satisfies RunState);
    const fatal = events.at(-2);
    assert.equal(fatal?.kind, "run.error");
    assert.equal((fatal?.data as { fatal: boolean }).fatal, true);
    assertAllValid(w.runDir, w.run.id);
  }
});

test("reconnectWorker reaches a surviving worker and never stops it", async (t) => {
  const w = await start(t, [...START, { op: "hang" }]);
  const again = await reconnectWorker(w.stateDir, w.run.id);
  assert.equal(again.live, true);
  assert.equal(checkLiveness(w.runDir).alive, true);
  const shown = showRunAt(w.runDir, { controllable: false });
  assert.equal(shown?.run.live_control, false, "a restarted core reports live control unavailable");
  assert.notEqual(shown?.run.state, "unknown", "a live worker is never unknown");
});

test("a run directory too long for a Unix socket path still gets a working control socket", async (t) => {
  const deep = join(stateDir(t), "x".repeat(60));
  const run = newRun();
  const w = await spawnWorker({ stateDir: deep, run, driver: fakeDriver({ steps: [...START, { op: "hang" }] }) });
  killAfter(t, w.pid, w.runDir);
  assert.ok(Buffer.byteLength(runFile(w.runDir, "socket")) > 108, "the plain socket path would not fit");
  const reply = await w.control.ping();
  assert.ok(reply.ok && reply.pid === w.pid);
  assert.equal((await reconnectWorker(deep, run.id)).live, true);
});
