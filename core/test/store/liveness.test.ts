import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import type { RunEvent } from "../../src/contract/index.js";
import { EventLogWriter, readLog } from "../../src/store/event-log.js";
import { runFile } from "../../src/store/files.js";
import { createRun, followEvents, settleOrphan, showRunAt } from "../../src/store/run-store.js";
import { LivenessUnknownError, checkLiveness, identityOf, readProcStat, writeWorkerIdentity } from "../../src/store/liveness.js";
import { newRun, stateDir } from "../worker/helpers.js";
import { errno, stubFs } from "./fs-stub.js";

function runDirFor(t: Parameters<typeof stateDir>[0]): string {
  return createRun(stateDir(t), newRun());
}

test("a recorded process that is running with the same start time is alive", (t) => {
  const dir = runDirFor(t);
  writeWorkerIdentity(dir, identityOf(process.pid));
  const live = checkLiveness(dir);
  assert.equal(live.alive, true, live.reason);
  assert.equal(live.pid, process.pid);
});

test("a recycled pid (same pid, different process start time) is not mistaken for the worker", (t) => {
  const dir = runDirFor(t);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const pid = child.pid as number;
  const real = readProcStat(pid);
  assert.ok(real, "the helper process is visible in /proc");
  // The worker that recorded this pid started at a different time: the pid now belongs to someone else.
  writeWorkerIdentity(dir, { ...identityOf(pid), start_time: String(Number(real.startTime) - 1) });
  const live = checkLiveness(dir);
  assert.equal(live.alive, false);
  assert.match(live.reason, /pid reused/);
  // The same pid with the matching start time is the real process.
  writeWorkerIdentity(dir, identityOf(pid));
  assert.equal(checkLiveness(dir).alive, true);
});

test("an exited worker is dead, and so is a run with no worker recorded", async (t) => {
  const dir = runDirFor(t);
  assert.equal(checkLiveness(dir).alive, false);
  assert.equal(checkLiveness(dir).pid, null);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  writeWorkerIdentity(dir, identityOf(child.pid as number));
  assert.equal(checkLiveness(dir).alive, true);
  child.kill("SIGKILL");
  await once(child, "exit");
  const live = checkLiveness(dir);
  assert.equal(live.alive, false);
  assert.equal(live.pid, child.pid);
});

test("a host reboot since the worker started means the worker is gone", (t) => {
  const dir = runDirFor(t);
  writeWorkerIdentity(dir, { ...identityOf(process.pid), boot_id: "00000000-0000-0000-0000-000000000000" });
  const live = checkLiveness(dir);
  assert.equal(live.alive, false);
  assert.match(live.reason, /rebooted/);
});

/** Make every read of this process's `/proc` stat fail with `code`; other reads are untouched. */
function failProcStat(t: Parameters<typeof stateDir>[0], code: string): () => void {
  return stubFs(t, "readFileSync", (real) => ((path: unknown, ...rest: unknown[]) => {
    if (path === `/proc/${process.pid}/stat`) throw errno(code, "open");
    return (real as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof real);
}

test("a transient error reading /proc is not evidence that the worker is dead", (t) => {
  const dir = runDirFor(t);
  writeWorkerIdentity(dir, identityOf(process.pid));
  for (const code of ["EMFILE", "ENFILE", "ENOMEM", "EIO"]) {
    const restore = failProcStat(t, code);
    assert.throws(() => checkLiveness(dir), LivenessUnknownError, code);
    restore();
  }
  assert.equal(checkLiveness(dir).alive, true);
  // Only "does not exist" means dead; a /proc entry that vanishes mid-read reports ESRCH.
  for (const code of ["ENOENT", "ESRCH", "ENOTDIR"]) {
    const restore = failProcStat(t, code);
    assert.equal(checkLiveness(dir).alive, false, code);
    restore();
  }
});

test("a worker identity or heartbeat that exists but cannot be read is not a dead worker", (t) => {
  const unreadableIdentity = runDirFor(t);
  mkdirSync(runFile(unreadableIdentity, "worker")); // reading it fails with EISDIR, not ENOENT
  assert.throws(() => checkLiveness(unreadableIdentity), LivenessUnknownError);
  const unreadableHeartbeat = runDirFor(t);
  writeWorkerIdentity(unreadableHeartbeat, identityOf(process.pid));
  mkdirSync(runFile(unreadableHeartbeat, "heartbeat"));
  assert.throws(() => checkLiveness(unreadableHeartbeat), LivenessUnknownError);
});

test("a read that cannot establish liveness fails and never settles a live worker's run as unknown", async (t) => {
  const run = newRun();
  const dir = createRun(stateDir(t), run);
  const writer = EventLogWriter.open(dir, run.id);
  t.after(() => writer.close());
  writer.transition("queued", null, true);
  writer.transition("running", null);
  writeWorkerIdentity(dir, identityOf(process.pid)); // this process stands in for the live worker

  const restore = failProcStat(t, "EMFILE");
  assert.throws(() => showRunAt(dir, { controllable: true, settle: true }), LivenessUnknownError);
  assert.throws(() => settleOrphan(dir, run.id), LivenessUnknownError);
  // An attach follower neither ends nor settles: it checks again on its next tick.
  const seen: RunEvent[] = [];
  let failed: unknown = null;
  const follower = (async () => {
    for await (const event of followEvents(dir, run.id, 2, { pollMs: 2, orphanCheckMs: 4 })) seen.push(event);
  })().catch((err: unknown) => (failed = err));
  await delay(80);
  assert.equal(failed, null, "the follower survives the failed liveness reads");
  assert.equal(seen.length, 0);
  assert.deepEqual(readLog(dir, run.id).events.map((e) => e.cursor), [1, 2], "nothing was appended to the live worker's log");

  restore();
  assert.equal(showRunAt(dir, { controllable: true, settle: true })?.run.state, "running");
  writer.transition("succeeded", null);
  await follower;
  assert.equal(failed, null);
  assert.deepEqual(seen.map((e) => (e.data as { to: string }).to), ["succeeded"]);
});
