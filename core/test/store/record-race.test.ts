/**
 * Finding 19 (pr-15 review): a run read at the moment its worker completes it. The worker writes
 * the record with the run's branch and then appends the terminal event (run-loop
 * `recordCollected`). A reader that took the record before that write and the log after that
 * append must not report `succeeded` without the branch, and must not cache such a run.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { Run, RunId } from "../../src/contract/index.js";
import { EventLogWriter } from "../../src/store/event-log.js";
import { runFile } from "../../src/store/files.js";
import { createRun, readRecord, showRunAt, writeRecord } from "../../src/store/run-store.js";

const ID = "thor-culture-agents.run.01M8CMHYHM3NW9NCT0KA000100" as RunId;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");

function runningRun(t: TestContext): string {
  const state = mkdtempSync(join(tmpdir(), "ca-race-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const created = new Date(T0).toISOString();
  const dir = createRun(state, {
    id: ID, agent_id: "thor-culture-agents", session_id: "thor-culture-agents.ses.01M8CMHYHM466FE0YF6MS2Q9WW", harness: "stub", repo: "/tmp/r",
    task: "t", owner: { kind: "operator", id: "thor-operator" }, idempotency_key: null, deadline: null, state: "queued", state_reason: null, terminal: false,
    created_at: created, updated_at: created, started_at: null, ended_at: null, cursor: 1, live_control: false, worker_pid: null, branch: null,
  } as Run);
  const w = EventLogWriter.open(dir, ID, () => T0 + 1);
  w.transition("queued", null);
  w.transition("running", null);
  w.close();
  return dir;
}

/** What the worker does when a run completes with collected commits: the record with its branch, then the terminal event. */
function completeLikeTheWorker(dir: string): void {
  writeRecord(dir, { ...readRecord(dir), branch: `runs/${ID}` }, true);
  const w = EventLogWriter.open(dir, ID, () => T0 + 2);
  w.transition("succeeded", null, true);
  w.close();
}

test("a run read while its worker completes it reports succeeded only with its branch, and caches no run without it", (t) => {
  const dir = runningRun(t);
  let injected = false;
  // The reader has read the record when it reads the log; the worker completes the run in between.
  const readFile = (path: string): Buffer => {
    if (!injected && path.endsWith("events.jsonl")) {
      injected = true;
      completeLikeTheWorker(dir);
    }
    return readFileSync(path);
  };
  const first = showRunAt(dir, { readFile, controllable: false })?.run;
  assert.equal(injected, true, "the worker's completion ran between the reader's record and log reads");
  assert.equal(first?.state, "succeeded");
  assert.equal(first?.branch, `runs/${ID}`, "a succeeded run read in that gap still reports its branch");
  // A later read (served from the summary cache when one was written) reports the branch too.
  const later = showRunAt(dir, { controllable: false })?.run;
  assert.equal(later?.state, "succeeded");
  assert.equal(later?.branch, `runs/${ID}`, "the summary cache does not keep a branchless succeeded run");
});

test("a branchless summary written before the fix is not served: the run is derived again and reports its branch", (t) => {
  const dir = runningRun(t);
  completeLikeTheWorker(dir);
  const run = showRunAt(dir, { controllable: false })?.run;
  assert.equal(run?.branch, `runs/${ID}`);
  // What a core with the race wrote: summary version 1, the current log size, and branch null.
  const summary = JSON.parse(readFileSync(runFile(dir, "summary"), "utf8")) as { log_bytes: number };
  writeFileSync(runFile(dir, "summary"), JSON.stringify({ summary_version: 1, log_bytes: summary.log_bytes, run: { ...run, branch: null } }));
  assert.equal(showRunAt(dir, { controllable: false })?.run.branch, `runs/${ID}`);
});
