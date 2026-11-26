/** Store schema version, reading 2.0 run directories, unreadable runs, and startup cleanup. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { cleanupStore } from "../../src/store/startup.js";
import { activeRuns, listRunEntries } from "../../src/store/entries.js";
import { EventLogWriter, readLog } from "../../src/store/event-log.js";
import { runDir, runFile } from "../../src/store/files.js";
import { createRun } from "../../src/store/run-store.js";
import { identityOf, writeWorkerIdentity } from "../../src/store/liveness.js";
import { STORE_SCHEMA_VERSION, readStoreVersion } from "../../src/store/version.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../../../test/store/fixtures/state-2.0");
const ID_2_0 = "thor-culture-agents.run.01M8CMHYHM3NW9NCT0KAW4J1H4";

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ca-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function record(id: string, state = "queued"): Parameters<typeof createRun>[1] {
  return {
    id, agent_id: "thor-culture-agents", session_id: "thor-culture-agents.ses.01M8CMHYHM466FE0YF6MS2Q9WW", harness: "fake", repo: "/tmp/r",
    task: "t", owner: { kind: "operator", id: "thor-operator" }, idempotency_key: null, deadline: null, state, state_reason: null, terminal: false,
    created_at: "2026-11-26T10:00:00.000Z", updated_at: "2026-11-26T10:00:00.000Z", started_at: null, ended_at: null, cursor: 1, live_control: false, worker_pid: null, branch: null,
  } as Parameters<typeof createRun>[1];
}

const id = (n: string): string => `thor-culture-agents.run.01M8CMHYHM3NW9NCT0KAW4${n}00`;

test("a directory written by 3.0 carries the store schema version", (t) => {
  const state = tmp(t);
  const dir = createRun(state, record(id("1A") as never));
  assert.equal(readStoreVersion(dir), STORE_SCHEMA_VERSION);
  assert.deepEqual(JSON.parse(readFileSync(runFile(dir, "version"), "utf8")), { schema: STORE_SCHEMA_VERSION });
});

test("a run directory written by the 2.0 core is listed with its true state", (t) => {
  const state = tmp(t);
  cpSync(FIXTURE, state, { recursive: true });
  assert.equal(existsSync(runFile(runDir(state, ID_2_0), "version")), false, "the fixture has no version, as 2.0 wrote it");
  assert.equal(readStoreVersion(runDir(state, ID_2_0)), 0);
  const entries = listRunEntries(state);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  if (entry === undefined || entry.kind !== "run") return assert.fail("one run entry");
  assert.equal(entry.run.id, ID_2_0);
  assert.equal(entry.run.state, "succeeded");
  assert.equal(entry.run.terminal, true);
  assert.equal(entry.run.cursor, 4);
});

test("an unreadable run is listed with its id, is not active, and its worker is not signalled", async (t) => {
  const state = tmp(t);
  cpSync(FIXTURE, state, { recursive: true });
  // A live process stands in for a worker; its identity is recorded as a worker's would be.
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const badId = id("2B") as never;
  const bad = createRun(state, record(badId));
  const writer = EventLogWriter.open(bad, badId);
  writer.transition("queued", null);
  writer.close();
  writeWorkerIdentity(bad, identityOf(child.pid as number));
  const okId = id("2C") as never;
  const good = createRun(state, record(okId));
  const w2 = EventLogWriter.open(good, okId);
  w2.transition("queued", null);
  w2.close();
  writeWorkerIdentity(good, identityOf(child.pid as number));
  assert.deepEqual(activeRuns(listRunEntries(state)).map((r) => r.id).sort(), [badId, okId], "baseline: both readable live runs are active");
  // Make the first run unreadable in three different ways, one at a time.
  const breakers: Array<[string, () => void]> = [
    ["corrupt log", () => appendFileSync(runFile(bad, "events"), "{not json}\n")],
    ["newer schema", () => writeFileSync(runFile(bad, "version"), '{"schema":99}\n')],
    ["corrupt record", () => writeFileSync(runFile(bad, "record"), "nope")],
  ];
  for (const [name, breakIt] of breakers) {
    breakIt();
    const entries = listRunEntries(state, { settle: true });
    const found = entries.find((e) => e.kind === "unreadable");
    assert.ok(found && found.kind === "unreadable" && found.id === badId, `${name}: listed as unreadable with its id`);
    assert.ok(found.detail.length > 0);
    assert.ok(entries.some((e) => e.kind === "run" && e.run.id === ID_2_0), `${name}: the readable runs are still listed`);
    assert.deepEqual(activeRuns(entries).map((r) => r.id), [okId], `${name}: not counted as active`);
    assert.equal(child.exitCode, null, `${name}: its worker was not signalled`);
    assert.equal(child.signalCode, null);
    rmSync(bad, { recursive: true });
    createRun(state, record(badId));
    const rewriter = EventLogWriter.open(bad, badId);
    rewriter.transition("queued", null);
    rewriter.close();
    writeWorkerIdentity(bad, identityOf(child.pid as number));
  }
});

test("startup removes run directories without a first event and temporary files, and keeps one with an event", (t) => {
  const state = tmp(t);
  cpSync(FIXTURE, state, { recursive: true });
  const empty = createRun(state, record(id("3D") as never)); // record only: never established
  const kept = createRun(state, record(id("3E") as never));
  const writer = EventLogWriter.open(kept, id("3E") as never);
  writer.transition("queued", null); // exactly one event
  writer.close();
  const torn = createRun(state, record(id("3F") as never));
  writeFileSync(runFile(torn, "events"), '{"partial'); // a first line that never completed
  writeFileSync(join(kept, "run.json.tmp-123-4"), "x");
  writeFileSync(join(state, "runs", "x.tmp-1-1"), "x");
  mkdirSync(join(state, "runs", "not-a-run-dir"));

  const report = cleanupStore(state);
  assert.deepEqual(report.removedRuns.sort(), [id("3D"), id("3F")]);
  assert.equal(existsSync(empty), false);
  assert.equal(existsSync(torn), false);
  assert.equal(existsSync(kept), true, "a directory with one event is kept");
  assert.equal(readLog(kept, id("3E") as never).events.length, 1);
  assert.equal(existsSync(join(kept, "run.json.tmp-123-4")), false);
  assert.equal(existsSync(join(state, "runs", "x.tmp-1-1")), false);
  assert.equal(existsSync(runDir(state, ID_2_0)), true, "the 2.0 run is kept");
  assert.equal(existsSync(join(state, "runs", "not-a-run-dir")), true, "only run directories are touched");
  assert.deepEqual(cleanupStore(state), { removedRuns: [], removedTemps: [] }, "a second pass finds nothing");
});
