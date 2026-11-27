/**
 * A run whose turn completed but whose work could not be brought to the host keeps its sandbox:
 * the run fails naming the sandbox, how long it is kept and how to get the work out, the worker
 * records the retention, and the daemon's reclaim leaves that sandbox alone until it expires.
 * A cancelled run and a run whose turn failed keep nothing.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";

import { RunDriver, RETAIN_FAILED_SANDBOX_DAYS } from "../../src/harness/common/run-driver.js";
import { SandboxWorkspace, type SandboxSettings } from "../../src/harness/common/sandbox-workspace.js";
import { emptyCatalog } from "../../src/runs/ports.js";
import { createRunService } from "../../src/runs/index.js";
import type { PreparedTree, RunSandbox, RunSandboxes } from "../../src/sandbox/index.js";
import { runDir, runFile } from "../../src/store/files.js";
import { followEvents, readRecord } from "../../src/store/run-store.js";
import type { FakeStep } from "../../src/worker/fake-driver.js";
import { readRetained } from "../../src/worker/retained.js";
import { spawnWorker } from "../../src/worker/spawn.js";
import { fakeDriver, killAfter, newRun, stateDir } from "../worker/helpers.js";
import { FakeBackend, FakeFactory, type FailAt } from "./fakes.js";
import { drive, lastEvent } from "./helpers.js";

const NOW = Date.parse("2026-11-25T10:00:00.000Z");
const DAY = 86_400_000;

function setup(failAt: FailAt, options: { retainable?: boolean; days?: number } = {}) {
  const factory = new FakeFactory(failAt, options.retainable ?? true);
  const backend = new FakeBackend(failAt);
  const driver = new RunDriver(factory, backend, {
    task: "t",
    commitMessage: "m",
    processSettleMs: 0,
    stopSettleMs: 200,
    now: () => NOW,
    ...(options.days === undefined ? {} : { retainFailedDays: options.days }),
  });
  return { factory, backend, driver };
}

test("the retention period is 7 days unless configured", () => {
  assert.equal(RETAIN_FAILED_SANDBOX_DAYS, 7);
});

for (const failAt of ["commit", "collect"] as const) {
  test(`a completed turn whose ${failAt} fails keeps the sandbox for 7 days and says how to get the work out`, async () => {
    const { factory, backend, driver } = setup(failAt);
    const done = drive(driver.start());
    await backend.turnStarted;
    const ws = factory.workspace;
    assert.ok(ws);
    const init = { pid: 1, ppid: 0, args: "init" };
    ws.procLists = [[init, { pid: 70, ppid: 1, args: "sleep 600" }], [init]]; // the baseline was taken when the workspace opened
    backend.turn.end({ kind: "completed", summary: "done" });
    const events = await done;
    const outcome = lastEvent(events);
    const until = new Date(NOW + 7 * DAY).toISOString();
    assert.ok(outcome?.type === "failed", JSON.stringify(outcome));
    assert.deepEqual(outcome.retained, { sandbox: "t-abc123", until });
    assert.equal(outcome.error.code, "internal");
    assert.match(outcome.error.message, failAt === "commit" ? /Could not commit the run's changes: commit failed/ : /Could not collect the run's commits: fetch failed/);
    assert.match(outcome.error.message, /sandbox t-abc123 is kept until 2026-12-02T10:00:00\.000Z/);
    assert.match(outcome.error.message, /openshell sandbox ssh-config t-abc123, then git fetch runs\/x/);
    assert.ok(outcome.error.message.length <= 2000);
    assert.equal(ws.destroyed, 0, "the sandbox holding the only copy of the work is not deleted");
    assert.equal(ws.kept, 1, "the local handles are let go");
    assert.equal(backend.closed, 1, "the harness session is closed");
    assert.deepEqual(ws.killed, [70], "processes the harness left are killed; the sandbox stays");
    assert.equal(events.filter((e) => e.type === "failed" || e.type === "completed" || e.type === "stopped").length, 1);
    await driver.dispose();
    assert.equal(ws.destroyed, 0, "dispose after a retention does not delete the sandbox either");
  });
}

test("a long failure message still leaves room for the sandbox, the date and the instructions", async () => {
  const { factory, backend, driver } = setup(null);
  const done = drive(driver.start());
  await backend.turnStarted;
  const ws = factory.workspace;
  assert.ok(ws);
  ws.collect = async () => {
    throw new Error("x".repeat(5000));
  };
  backend.turn.end({ kind: "completed" });
  const outcome = lastEvent(await done);
  assert.ok(outcome?.type === "failed" && outcome.retained);
  assert.ok(outcome.error.message.length <= 2000);
  assert.match(outcome.error.message, /sandbox t-abc123 is kept until .*ssh-config t-abc123/);
});

test("a long failure reason gives way to the recovery instructions, which are never clipped", async () => {
  const { factory, backend, driver } = setup("commit");
  const done = drive(driver.start());
  await backend.turnStarted;
  const ws = factory.workspace;
  assert.ok(ws);
  ws.failureText = "x".repeat(3000);
  ws.recoverText = `git fetch ${"/long/path".repeat(120)} END-OF-INSTRUCTIONS`;
  backend.turn.end({ kind: "completed", summary: "done" });
  const outcome = lastEvent(await done);
  assert.ok(outcome?.type === "failed", JSON.stringify(outcome));
  assert.ok(outcome.error.message.length <= 2000);
  assert.ok(outcome.error.message.endsWith("END-OF-INSTRUCTIONS"), "the instructions are whole");
  assert.match(outcome.error.message, /^Could not commit the run's changes: x+\.\.\.\. The turn had completed/);
});

test("a turn that committed work whose collect brings back nothing fails and keeps the sandbox, never succeeds without its branch", async () => {
  const { factory, backend, driver } = setup(null);
  const done = drive(driver.start());
  await backend.turnStarted;
  const ws = factory.workspace;
  assert.ok(ws);
  ws.collect = async () => null; // commitAll counted 1 commit; collect says there is nothing
  backend.turn.end({ kind: "completed", summary: "done" });
  const outcome = lastEvent(await done);
  assert.ok(outcome?.type === "failed", JSON.stringify(outcome));
  assert.match(outcome.error.message, /^Could not collect the run's commits: .*1 commit/);
  assert.deepEqual(outcome.retained, { sandbox: "t-abc123", until: new Date(NOW + 7 * DAY).toISOString() });
  assert.equal(ws.destroyed, 0, "the sandbox holding the only copy of the work is not deleted");
});

test("retention set to 0 days, or a workspace that cannot be kept, deletes as before", async () => {
  for (const options of [{ days: 0 }, { retainable: false }]) {
    const { factory, backend, driver } = setup("collect", options);
    const done = drive(driver.start());
    await backend.turnStarted;
    backend.turn.end({ kind: "completed" });
    const outcome = lastEvent(await done);
    assert.ok(outcome?.type === "failed");
    assert.equal(outcome.retained, undefined);
    assert.ok(!/is kept until/.test(outcome.error.message));
    assert.equal(factory.workspace?.destroyed, 1);
    assert.equal(factory.workspace?.kept, 0);
  }
});

test("a cancelled run keeps nothing, even when the cancel lands while the commit is failing", async () => {
  const during = setup(null);
  const duringDone = drive(during.driver.start());
  await during.backend.turnStarted;
  await during.driver.cancel();
  assert.deepEqual(lastEvent(await duringDone), { type: "stopped" });
  assert.equal(during.factory.workspace?.destroyed, 1);
  assert.equal(during.factory.workspace?.kept, 0);

  const late = setup("commit");
  const lateDone = drive(late.driver.start());
  await late.backend.turnStarted;
  const ws = late.factory.workspace;
  assert.ok(ws);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const commit = ws.commitAll.bind(ws);
  ws.commitAll = async () => (await held, commit());
  late.backend.turn.end({ kind: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await late.driver.cancel();
  release();
  assert.deepEqual(lastEvent(await lateDone), { type: "stopped" });
  assert.equal(ws.destroyed, 1);
  assert.equal(ws.kept, 0);
});

test("a run whose turn itself failed keeps nothing", async () => {
  const { factory, backend, driver } = setup(null);
  const done = drive(driver.start());
  await backend.turnStarted;
  backend.turn.end({ kind: "failed", error: { code: "internal", message: "model refused", retryable: false } });
  const outcome = lastEvent(await done);
  assert.deepEqual(outcome, { type: "failed", error: { code: "internal", message: "model refused", retryable: false } });
  assert.equal(factory.workspace?.destroyed, 1);
  assert.equal(factory.workspace?.kept, 0);
});

test("the sandbox workspace names its sandbox and the commands; keeping it stops local handles and never deletes", async () => {
  const log: string[] = [];
  const sandbox = { name: "t11-abc", home: "/sandbox", stop: async () => void log.push("stop"), destroy: async () => void log.push("destroy") } as unknown as RunSandbox;
  const sandboxes = { destroy: async () => void log.push("destroy-by-id") } as unknown as RunSandboxes;
  const settings: SandboxSettings = { gateway: { endpoint: "https://x", tlsDir: "/tls", name: "gw1" }, openshellBin: "openshell", image: "i", providers: [], sandboxPrefix: "t11-", ref: "HEAD", identity: { name: "n", email: "e@x" } };
  const never = () => new Promise<never>(() => undefined);
  const prepared: PreparedTree = { branch: "runs/thor-a.run.01ABC", baseCommit: "a".repeat(40), path: "/sandbox/work" };
  const ws = new SandboxWorkspace(sandboxes, sandbox, prepared, "thor-a.run.01ABC", "/host/repo", settings, { openRunSandboxes: never, prepare: never, collect: never });
  const retention = ws.retention();
  assert.equal(retention.sandbox, "t11-abc");
  assert.match(retention.recover, /openshell -g gw1 sandbox ssh-config t11-abc/);
  assert.match(retention.recover, /git fetch .*\/sandbox\/work runs\/thor-a\.run\.01ABC:runs\/thor-a\.run\.01ABC/);
  await ws.keep();
  assert.deepEqual(log, ["stop"]);
});

async function finish(t: TestContext, dir: string, steps: FakeStep[]) {
  const run = newRun();
  const worker = await spawnWorker({ stateDir: dir, run, driver: fakeDriver({ steps }), heartbeatMs: 50 });
  killAfter(t, worker.pid, worker.runDir);
  for await (const e of followEvents(worker.runDir, run.id, 0, { pollMs: 5, orphanCheckMs: 0, signal: AbortSignal.timeout(5000) })) void e;
  return { run, dir: worker.runDir };
}

const failure = { code: "internal", message: "Could not collect the run's commits: fetch failed. sandbox t-abc123 is kept", retryable: false } as const;

test("the worker records a retention in retained.json (owner-only) and the run ends failed", async (t) => {
  const until = new Date(Date.now() + 7 * DAY).toISOString();
  const kept = await finish(t, stateDir(t), [{ op: "started" }, { op: "failed", error: failure, retained: { sandbox: "t-abc123", until } }]);
  assert.equal(readRecord(kept.dir).state, "failed");
  const file = runFile(kept.dir, "retained");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { sandbox: "t-abc123", until });
  assert.deepEqual(readRetained(kept.dir), { sandbox: "t-abc123", until: Date.parse(until) });
  const plain = await finish(t, stateDir(t), [{ op: "started" }, { op: "failed", error: failure }]);
  assert.equal(existsSync(runFile(plain.dir, "retained")), false, "an ordinary failure records no retention");
  assert.equal(readRetained(plain.dir), null);
});

test("reclaim leaves a retained sandbox alone until it expires, then deletes it", async (t) => {
  const dir = stateDir(t);
  const until = new Date(NOW + 7 * DAY).toISOString();
  const kept = await finish(t, dir, [{ op: "started" }, { op: "failed", error: failure, retained: { sandbox: "t-abc123", until } }]);
  const plain = await finish(t, dir, [{ op: "started" }, { op: "failed", error: failure }]);
  const asked: string[][] = [];
  const catalog = { ...emptyCatalog(), reclaim: async (ids: string[]) => (asked.push([...ids].sort()), ids) };
  const service = (now: number) => createRunService({ stateDir: dir, node: "thor", catalog, allowlist: () => ({ path: "", status: "missing", entries: [], detail: null }), now: () => new Date(now) });
  await service(NOW).reclaim();
  await service(NOW + 7 * DAY - 1000).reclaim();
  assert.deepEqual(asked, [[plain.run.id], [plain.run.id]], "before the 7 days are over only the ordinary run is reclaimed");
  await service(NOW + 7 * DAY + 1000).reclaim();
  assert.deepEqual(asked[2], [kept.run.id, plain.run.id].sort(), "afterwards the retained sandbox is reclaimed too");
});

test("a retention record that cannot be read keeps the sandbox for the default period from when it was written", async (t) => {
  const dir = stateDir(t);
  const run = await finish(t, dir, [{ op: "started" }, { op: "failed", error: failure }]);
  const file = runFile(runDir(dir, run.run.id), "retained");
  writeFileSync(file, "{not json", { mode: 0o600 });
  utimesSync(file, new Date(NOW), new Date(NOW));
  assert.deepEqual(readRetained(run.dir), { sandbox: null, until: NOW + 7 * DAY });
  const asked: string[][] = [];
  const catalog = { ...emptyCatalog(), reclaim: async (ids: string[]) => (asked.push(ids), ids) };
  const service = (now: number) => createRunService({ stateDir: dir, node: "thor", catalog, allowlist: () => ({ path: "", status: "missing", entries: [], detail: null }), now: () => new Date(now) });
  assert.deepEqual(await service(NOW + DAY).reclaim(), [], "not lost because the record is damaged");
  assert.deepEqual(await service(NOW + 8 * DAY).reclaim(), [run.run.id], "and not kept forever");
});
