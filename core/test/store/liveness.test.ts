import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

import { createRun } from "../../src/store/run-store.js";
import { checkLiveness, identityOf, readProcStat, writeWorkerIdentity } from "../../src/store/liveness.js";
import { newRun, stateDir } from "../worker/helpers.js";

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
