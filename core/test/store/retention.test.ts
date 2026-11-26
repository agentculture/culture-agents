/** t5: finished runs are not re-read (summary cache), the summary is rebuilt from the log, and retention removes only what the rule allows. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { Capabilities } from "../../src/contract/index.js";
import { createRunService } from "../../src/runs/index.js";
import { EventLogWriter } from "../../src/store/event-log.js";
import { runDir, runFile } from "../../src/store/files.js";
import { DAY_MS, pruneFinishedRuns, retentionFromEnv } from "../../src/store/retention.js";
import { createRun, listRuns } from "../../src/store/run-store.js";
import { listRunEntries } from "../../src/store/entries.js";
import { HANG, CALLER } from "../runs/support.js";

const FAKE_DRIVER = fileURLToPath(new URL("../../src/worker/fake-driver.js", import.meta.url));
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const runId = (n: number): string => `thor-culture-agents.run.01M8CMHYHM3NW9NCT0KA${ALPHABET[(n >> 15) & 31]}${ALPHABET[(n >> 10) & 31]}${ALPHABET[(n >> 5) & 31]}${ALPHABET[n & 31]}00`;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ca-retain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A run on disk that ended in `final`, its events stamped from `endMs`. */
function finishedRun(state: string, n: number, final: "succeeded" | "failed" | "cancelled" | null = "succeeded", endMs = T0): string {
  const id = runId(n);
  const created = new Date(endMs - 1000).toISOString();
  const dir = createRun(state, {
    id, agent_id: "thor-culture-agents", session_id: "thor-culture-agents.ses.01M8CMHYHM466FE0YF6MS2Q9WW", harness: "fake", repo: "/tmp/r",
    task: "t", owner: { kind: "operator", id: "thor-operator" }, idempotency_key: null, deadline: null, state: "queued", state_reason: null, terminal: false,
    created_at: created, updated_at: created, started_at: null, ended_at: null, cursor: 1, live_control: false, worker_pid: null, branch: null,
  } as Parameters<typeof createRun>[1]);
  let clock = endMs - 500;
  const w = EventLogWriter.open(dir, id as never, () => clock++);
  w.transition("queued", null);
  w.transition("running", null);
  if (final !== null) w.transition(final, null, true);
  w.close();
  return dir;
}

function counting(): { read: (p: string) => Buffer; logs: () => number } {
  let logs = 0;
  return { read: (p) => ((logs += p.endsWith("events.jsonl") ? 1 : 0), readFileSync(p)), logs: () => logs };
}

const capabilities = (): Capabilities => {
  const yes = { supported: true, reason: null, caveats: [] };
  const no = { supported: false as const, reason: "deferred", caveats: [] };
  return { harness: "fake", available: true, version: "0", transport: "fake", capabilities: { submit: yes, stream: yes, steer: yes, cancel: yes, pause: no, resume: no, answer: no, continue_session: no, delegate: no, placement: no, reconnect: yes, worktree_isolation: no } };
};

test("with 500 finished runs on disk, submit, list and attach for a new run read none of their event logs", async (t) => {
  const state = tmp(t);
  for (let i = 0; i < 500; i++) finishedRun(state, i);
  listRuns(state, { limit: 1000 }); // the first read of each finished run writes its summary
  const reader = counting();
  const entry = { id: "fake", capabilities: () => Promise.resolve(capabilities()), driver: { module: FAKE_DRIVER, options: { steps: HANG.steps } } };
  const service = createRunService({ stateDir: state, node: "thor", catalog: { list: () => [entry], get: () => entry }, allowlist: () => ({ status: "ok", entries: [] }) as never, readFile: reader.read, warn: () => undefined });
  const repo = tmp(t);
  const run = await service.submit({ agent_id: "thor-culture-agents", harness: "fake", repo, task: "x", caller: CALLER } as never);
  const logsAfterSubmit = reader.logs();
  const listed = await service.listRuns({ limit: 1000 } as never);
  assert.equal(listed.length, 501);
  const page = await service.readEvents(run.id, 0, 10);
  assert.ok(page && page.events.length >= 1);
  const only = reader.logs() - logsAfterSubmit;
  // Only the new run's own log is read: once per call (submit, list, attach), never one of the 500.
  assert.ok(logsAfterSubmit <= 3, `submit read ${logsAfterSubmit} logs`);
  assert.ok(only <= 4, `list and attach read ${only} logs`);
  await service.cancel(run.id, { caller: CALLER });
  for (let i = 0; i < 100 && !(await service.getRun(run.id))?.terminal; i++) await new Promise((r) => setTimeout(r, 50));
});

test("a deleted summary gives the same listing, and a stale one is ignored", (t) => {
  const state = tmp(t);
  for (let i = 0; i < 5; i++) finishedRun(state, i, i % 2 ? "failed" : "succeeded", T0 + i * 1000);
  const before = listRuns(state);
  const sum = runFile(runDir(state, runId(2)), "summary");
  assert.ok(existsSync(sum), "a finished run's summary is written when it is first read");
  rmSync(sum);
  const reader = counting();
  assert.deepEqual(listRuns(state, { readFile: reader.read } as never), before);
  assert.equal(listRunEntries(state, { readFile: reader.read }).length, 5);
  assert.equal(reader.logs(), 1, "only the run without a summary was rebuilt from its log");
  assert.ok(existsSync(sum), "rebuilt");
  // Stale: a summary that claims another log size is not believed.
  const doc = JSON.parse(readFileSync(sum, "utf8")) as { log_bytes: number; run: { state: string } };
  doc.log_bytes += 1;
  doc.run.state = "cancelled";
  writeFileSync(sum, JSON.stringify(doc));
  assert.deepEqual(listRuns(state), before);
  writeFileSync(sum, "{not json");
  assert.deepEqual(listRuns(state), before);
});

const options = (now: number, extra: object = {}) => ({ retentionMs: 10 * DAY_MS, now: () => now, ...extra });

test("retention removes a finished run only after the period, and keeps what the rule protects", (t) => {
  const state = tmp(t);
  const old = finishedRun(state, 1);
  const young = finishedRun(state, 2, "failed", T0 + 8 * DAY_MS);
  const unknownState = finishedRun(state, 3, null); // no terminal event and no worker: reads unknown
  const retained = finishedRun(state, 4);
  writeFileSync(runFile(retained, "retained"), JSON.stringify({ sandbox: "sb", until: new Date(T0 + 7 * DAY_MS).toISOString() }));
  const damaged = finishedRun(state, 5);
  writeFileSync(runFile(damaged, "events"), "{broken\n");
  const now = T0 + 11 * DAY_MS;
  const removed = pruneFinishedRuns(state, options(now));
  assert.deepEqual(removed, [runId(1)], "only the old finished run");
  assert.ok(!existsSync(old));
  for (const keep of [young, unknownState, retained, damaged]) assert.ok(existsSync(keep), keep);
  // The sandbox retention ended at day 7; the period then runs from there.
  assert.deepEqual(pruneFinishedRuns(state, options(T0 + 16 * DAY_MS)), [], "the retained run waits from the end of its sandbox retention");
  assert.deepEqual(pruneFinishedRuns(state, options(T0 + 18 * DAY_MS)).sort(), [runId(2), runId(4)].sort());
  assert.ok(existsSync(unknownState) && existsSync(damaged), "unknown and unreadable runs are never removed");
});

test("retention is off without a period and the period comes from the environment", (t) => {
  const state = tmp(t);
  const dir = finishedRun(state, 1);
  assert.deepEqual(pruneFinishedRuns(state, { retentionMs: null, now: () => T0 + 999 * DAY_MS }), []);
  assert.ok(existsSync(dir));
  assert.equal(retentionFromEnv({}), 30 * DAY_MS);
  assert.equal(retentionFromEnv({ CULTURE_AGENTS_RUN_RETENTION_DAYS: "2" }), 2 * DAY_MS);
  for (const off of ["0", "off", "-1"]) assert.equal(retentionFromEnv({ CULTURE_AGENTS_RUN_RETENTION_DAYS: off }), null);
});
