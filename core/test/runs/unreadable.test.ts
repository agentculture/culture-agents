// t32: the run directories the core cannot read, listed with their reason and left untouched.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { validate, type UnreadableRunList } from "../../src/contract/index.js";
import { startDaemon } from "../../src/daemon/daemon.js";
import { listUnreadableRuns } from "../../src/runs/unreadable.js";
import { EventLogWriter } from "../../src/store/event-log.js";
import { runFile } from "../../src/store/files.js";
import { createRun } from "../../src/store/run-store.js";
import { FakeRunService } from "../daemon/fake-service.js";
import { call, makeEnv } from "../daemon/harness.js";

const id = (n: string): string => `thor-culture-agents.run.01M8CMHYHM3NW9NCT0KAW4${n}00`;

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ca-unreadable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function record(runId: string): Parameters<typeof createRun>[1] {
  return {
    id: runId, agent_id: "thor-culture-agents", session_id: "thor-culture-agents.ses.01M8CMHYHM466FE0YF6MS2Q9WW", harness: "fake", repo: "/tmp/r",
    task: "t", owner: { kind: "operator", id: "thor-operator" }, idempotency_key: null, deadline: null, state: "queued", state_reason: null, terminal: false,
    created_at: "2026-11-26T10:00:00.000Z", updated_at: "2026-11-26T10:00:00.000Z", started_at: null, ended_at: null, cursor: 1, live_control: false, worker_pid: null, branch: null,
  } as Parameters<typeof createRun>[1];
}

function established(state: string, runId: string): string {
  const dir = createRun(state, record(runId));
  const writer = EventLogWriter.open(dir, runId as never);
  writer.transition("queued", null);
  writer.close();
  return dir;
}

/** Every file under the store with its size and times, and its bytes: what "nothing was modified" compares. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = statSync(path, { bigint: true });
      if (st.isDirectory()) {
        out.push(`${path} dir ${st.mtimeNs}`);
        walk(path);
      } else out.push(`${path} ${st.size} ${st.mtimeNs} ${st.ctimeNs} ${readFileSync(path).toString("base64")}`);
    }
  };
  walk(root);
  return out;
}

test("a corrupt record, a corrupt log and a newer version are listed with their reasons, and a readable run is not", (t) => {
  const state = tmp(t);
  established(state, id("1A"));
  const corruptRecord = established(state, id("2B"));
  writeFileSync(runFile(corruptRecord, "record"), "nope");
  const corruptLog = established(state, id("3C"));
  appendFileSync(runFile(corruptLog, "events"), "{not json}\n");
  const newer = established(state, id("4D"));
  writeFileSync(runFile(newer, "version"), '{"schema":99}\n');
  const list = listUnreadableRuns(state);
  assert.deepEqual(list.runs.map((r) => [r.run_id, r.reason]), [
    [id("4D"), "newer_version"],
    [id("3C"), "unreadable_log"],
    [id("2B"), "corrupt_record"],
  ]);
  assert.equal(list.count, 3);
  assert.ok(list.runs.every((r) => r.detail.length > 0 && r.detail.length <= 500));
  assert.ok(validate("unreadable", list).ok, "the list is a valid unreadable.json");
});

test("a version file that is not a version is `other`, and a store with no unreadable run lists none", (t) => {
  const state = tmp(t);
  assert.deepEqual(listUnreadableRuns(state), { count: 0, runs: [] });
  const dir = established(state, id("1A"));
  assert.deepEqual(listUnreadableRuns(state), { count: 0, runs: [] });
  writeFileSync(runFile(dir, "version"), "garbage");
  assert.deepEqual(listUnreadableRuns(state).runs.map((r) => r.reason), ["other"]);
});

test("listing unreadable runs modifies nothing in their directories (a newer one holds a summary a reader might trust)", (t) => {
  const state = tmp(t);
  established(state, id("1A"));
  const corruptLog = established(state, id("3C"));
  appendFileSync(runFile(corruptLog, "events"), "{not json}\n");
  const corruptRecord = established(state, id("2B"));
  writeFileSync(runFile(corruptRecord, "record"), "nope");
  const newer = established(state, id("4D"));
  writeFileSync(runFile(newer, "version"), '{"schema":99}\n');
  writeFileSync(runFile(newer, "summary"), "{}");
  for (const dir of [corruptLog, corruptRecord, newer]) {
    const before = snapshot(dir);
    assert.equal(listUnreadableRuns(state).count, 3);
    listUnreadableRuns(state);
    assert.deepEqual(snapshot(dir), before, `${dir} is unchanged`);
  }
});

test("GET /v1/runs/unreadable answers with the list, before the `runs/{run_id}` route could take the path", async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const body: UnreadableRunList = { count: 1, runs: [{ run_id: id("4D") as never, reason: "newer_version", detail: "the run directory uses store schema 99" }] };
  const service = new FakeRunService();
  service.listUnreadable = () => Promise.resolve(body);
  const daemon = await startDaemon({ service, node: "thor", env: env.vars });
  try {
    const reply = await call(env.socket, "GET", "/v1/runs/unreadable");
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(reply.json, body);
    assert.equal((await call(env.socket, "GET", "/v1/runs/unreadable", { version: "2.0" })).status, 412);
    assert.equal((await call(env.socket, "POST", "/v1/runs/unreadable", { body: {} })).status, 400);
  } finally {
    await daemon.stop();
  }
});
