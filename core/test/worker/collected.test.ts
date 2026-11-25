/** A completed run records where its commits landed: the branch on the run record, the SHAs beside it. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test, type TestContext } from "node:test";

import { validate } from "../../src/contract/index.js";
import { runFile } from "../../src/store/files.js";
import { followEvents, readRecord, showRunAt } from "../../src/store/run-store.js";
import type { FakeStep } from "../../src/worker/fake-driver.js";
import { spawnWorker } from "../../src/worker/spawn.js";
import { fakeDriver, killAfter, newRun, stateDir } from "./helpers.js";

const SHAS = ["a".repeat(40), "b".repeat(40)];

async function finish(t: TestContext, steps: FakeStep[]) {
  const run = newRun();
  const worker = await spawnWorker({ stateDir: stateDir(t), run, driver: fakeDriver({ steps }), heartbeatMs: 50 });
  killAfter(t, worker.pid, worker.runDir);
  const signal = AbortSignal.timeout(5000);
  for await (const event of followEvents(worker.runDir, run.id, 0, { pollMs: 5, orphanCheckMs: 0, signal })) void event;
  return { run, dir: worker.runDir };
}

test("a completed run that collected commits has its branch on the record and the SHAs in collected.json", async (t) => {
  const branch = (id: string) => `runs/${id}`;
  const run = newRun();
  const worker = await spawnWorker({
    stateDir: stateDir(t),
    run,
    driver: fakeDriver({ steps: [{ op: "started" }, { op: "completed", summary: "done", collected: { branch: branch(run.id), commits: SHAS } }] }),
    heartbeatMs: 50,
  });
  killAfter(t, worker.pid, worker.runDir);
  for await (const event of followEvents(worker.runDir, run.id, 0, { pollMs: 5, orphanCheckMs: 0, signal: AbortSignal.timeout(5000) })) void event;

  const record = readRecord(worker.runDir);
  assert.equal(record.state, "succeeded");
  assert.equal(record.branch, branch(run.id));
  assert.ok(validate("run", record).ok, "the record validates with a branch");
  assert.equal(showRunAt(worker.runDir)?.run.branch, branch(run.id), "the derived run reports the branch");
  const file = runFile(worker.runDir, "collected");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { branch: branch(run.id), commits: SHAS });
});

test("a completed run that collected nothing has no branch and no collected.json", async (t) => {
  const { dir } = await finish(t, [{ op: "started" }, { op: "completed" }]);
  assert.equal(readRecord(dir).branch, null);
  assert.equal(existsSync(runFile(dir, "collected")), false);
});
