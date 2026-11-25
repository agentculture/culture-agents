/**
 * Run driver sequencing with a scripted workspace and backend: the outcome events, steer and
 * cancel delivery, and cleanup (harness closed, workspace destroyed exactly once) on every exit
 * path: success, failure at each stage, cancel before and during the turn, dispose.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { RunDriver } from "../../src/harness/common/run-driver.js";
import type { DriverEvent } from "../../src/worker/driver.js";
import { FakeBackend, FakeFactory, type FailAt } from "./fakes.js";
import { drive, lastEvent } from "./helpers.js";

function setup(failAt: FailAt = null) {
  const factory = new FakeFactory(failAt);
  const backend = new FakeBackend(failAt);
  const driver = new RunDriver(factory, backend, { task: "t", commitMessage: "m", processSettleMs: 0, stopSettleMs: 200 });
  return { factory, backend, driver };
}

test("success: started, output, collect, destroy, then completed with the summary", async () => {
  const { factory, backend, driver } = setup();
  const done = drive(driver.start());
  await backend.turnStarted;
  backend.turn.emit("hello");
  backend.turn.end({ kind: "completed", summary: "all done" });
  const events = await done;
  assert.equal(events[0]?.type, "started");
  assert.deepEqual(lastEvent(events), { type: "completed", summary: "all done", collected: { branch: "runs/x", commits: ["abc"] } });
  const ws = factory.workspace;
  assert.ok(ws);
  assert.deepEqual(ws.calls.slice(-3), ["commit", "collect", "destroy"]);
  assert.equal(backend.closed, 1, "the harness is closed before collect");
  assert.equal(ws.destroyed, 1);
  assert.deepEqual(driver.collected, { branch: "runs/x", commit: "abc", commits: 1, shas: ["abc"] });
  await driver.dispose();
  assert.equal(ws.destroyed, 1, "dispose after the end does not destroy twice");
});

for (const failAt of ["open", "processes", "backend", "turn", "commit", "collect"] as const) {
  test(`failure while trying to ${failAt}: one failed outcome and the workspace is released`, async () => {
    const { factory, backend, driver } = setup(failAt);
    const done = drive(driver.start());
    if (failAt === "commit" || failAt === "collect") {
      await backend.turnStarted;
      backend.turn.end({ kind: "completed" });
    }
    const events: DriverEvent[] = await done;
    const outcome = lastEvent(events);
    assert.equal(outcome?.type, "failed", JSON.stringify(outcome));
    assert.equal(events.filter((e) => e.type === "failed" || e.type === "completed" || e.type === "stopped").length, 1);
    if (outcome?.type === "failed") {
      assert.equal(outcome.error.code, failAt === "open" ? "unavailable" : "internal");
      assert.equal(outcome.error.retryable, failAt === "open");
    }
    if (failAt === "open") assert.equal(factory.workspace, null);
    else assert.equal(factory.workspace?.destroyed, 1, "the workspace is destroyed");
    if (backend.opened) assert.ok(backend.closed >= 1, "the harness is closed");
    await driver.dispose();
    assert.ok((factory.workspace?.destroyed ?? 0) <= 1);
  });
}

test("a failed turn outcome passes the harness's error through", async () => {
  const { factory, backend, driver } = setup();
  const done = drive(driver.start());
  await backend.turnStarted;
  backend.turn.end({ kind: "failed", error: { code: "internal", message: "model refused", retryable: false } });
  const events = await done;
  assert.deepEqual(lastEvent(events), { type: "failed", error: { code: "internal", message: "model refused", retryable: false } });
  assert.equal(factory.workspace?.destroyed, 1);
  assert.ok(!factory.workspace?.calls.includes("collect"), "nothing is collected from a failed turn");
});

test("an interrupted outcome without a cancel is a failure, not a stop", async () => {
  const { backend, driver } = setup();
  const done = drive(driver.start());
  await backend.turnStarted;
  backend.turn.end({ kind: "interrupted" });
  const outcome = lastEvent(await done);
  assert.equal(outcome?.type, "failed");
});

test("a destroy failure after a completed turn is reported as a non-fatal error", async () => {
  const { backend, driver } = setup("destroy");
  const done = drive(driver.start());
  await backend.turnStarted;
  backend.turn.end({ kind: "completed" });
  const events = await done;
  assert.equal(lastEvent(events)?.type, "completed");
  assert.ok(events.some((e) => e.type === "error" && e.error.code === "unavailable"));
});

test("steer is forwarded to the running turn; before the turn and after cancel it is rejected", async () => {
  const { backend, driver } = setup();
  await assert.rejects(driver.steer("too early"), /no running turn/);
  const done = drive(driver.start());
  await backend.turnStarted;
  await new Promise((resolve) => setImmediate(resolve));
  await driver.steer("go left");
  assert.deepEqual(backend.turn.steers, ["go left"]);
  await driver.cancel();
  await assert.rejects(driver.steer("too late"), /no running turn/);
  assert.equal(lastEvent(await done)?.type, "stopped");
});

test("cancel during the turn: interrupt, process checks, kill leftovers, destroy, then stopped", async () => {
  const { factory, backend, driver } = setup();
  const done = drive(driver.start());
  await backend.turnStarted;
  const ws = factory.workspace;
  assert.ok(ws);
  const init = { pid: 1, ppid: 0, args: "init" };
  const server = { pid: 50, ppid: 1, args: "opencode serve" };
  const sleeper = { pid: 60, ppid: 50, args: "sleep 120" };
  ws.procLists = [[init, server, sleeper], [init, sleeper], [init, sleeper]];
  await driver.cancel();
  const events = await done;
  assert.equal(lastEvent(events)?.type, "stopped");
  assert.equal(backend.turn.interrupts, 1);
  assert.equal(backend.closed, 1);
  const report = driver.stopReport;
  assert.ok(report);
  assert.deepEqual(report.afterInterrupt.map((p) => p.pid), [50, 60]);
  assert.deepEqual(report.afterClose.map((p) => p.pid), [60]);
  assert.deepEqual(report.killed, [60]);
  assert.deepEqual(report.remaining, []);
  assert.equal(report.destroyed, true);
  assert.equal(ws.destroyed, 1);
  assert.ok(!ws.calls.includes("collect"), "a cancelled run is not collected");
  assert.ok(events.some((e) => e.type === "output" && e.data.channel === "diagnostic" && e.data.text.startsWith("stop:")));
});

test("cancel when the harness ignores the interrupt: the driver stops waiting after the settle time", async () => {
  const { factory, backend, driver } = setup();
  backend.turn.interruptEnds = false;
  const done = drive(driver.start());
  await backend.turnStarted;
  await driver.cancel();
  const events = await done;
  assert.equal(lastEvent(events)?.type, "stopped");
  assert.equal(factory.workspace?.destroyed, 1);
});

test("cancel before the turn starts aborts the opening stages and reports stopped", async () => {
  const { factory, backend, driver } = setup();
  const stream = driver.start();
  await driver.cancel();
  const events = await drive(stream);
  assert.deepEqual(events.map((e) => e.type).filter((t) => t !== "output"), ["stopped"]);
  assert.equal(backend.opened, false);
  assert.ok((factory.workspace?.destroyed ?? 1) === 1);
});

test("dispose mid-turn ends the stream, closes the harness and destroys the workspace once", async () => {
  const { factory, backend, driver } = setup();
  const done = drive(driver.start());
  await backend.turnStarted;
  await driver.dispose();
  await driver.dispose();
  const events = await done;
  assert.ok(!events.some((e) => e.type === "completed"), "no outcome after dispose");
  assert.equal(backend.closed >= 1, true);
  assert.equal(factory.workspace?.destroyed, 1);
});

test("start() is called once", async () => {
  const { driver, backend } = setup();
  const done = drive(driver.start());
  assert.throws(() => driver.start(), /once/);
  await backend.turnStarted;
  backend.turn.end({ kind: "completed" });
  await done;
});
