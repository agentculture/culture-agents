/**
 * Review of pull request 15, the run store: the version check comes before any read, start-up
 * cleanup leaves a newer-version directory alone, the summary cache cannot change a listing or a
 * retention decision, one reader of `retained.json`, and the temp sweep stays inside the store.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { RunState } from "../../src/contract/index.js";
import { listRunEntries } from "../../src/store/entries.js";
import { EventLogWriter } from "../../src/store/event-log.js";
import { runDir, runFile, runsDir } from "../../src/store/files.js";
import { DAY_MS, pruneFinishedRuns } from "../../src/store/retention.js";
import { createRun, listRuns } from "../../src/store/run-store.js";
import { cleanupStore } from "../../src/store/startup.js";
import { readRetained } from "../../src/worker/retained.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const runId = (n: number): string => `thor-culture-agents.run.01M8CMHYHM3NW9NCT0KB00${ALPHABET[(n >> 5) & 31]}${ALPHABET[n & 31]}00`;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const PERIOD = { retentionMs: 10 * DAY_MS };

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ca-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A run on disk whose log walks `path` (after queued), its events stamped from `endMs`. */
function runWith(state: string, n: number, path: RunState[], endMs = T0): string {
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
  for (const to of path) w.transition(to, null, true);
  w.close();
  return dir;
}

const finished = (state: string, n: number, final: RunState = "succeeded", endMs = T0): string => runWith(state, n, ["running", final], endMs);
const newerVersion = (dir: string): void => writeFileSync(runFile(dir, "version"), JSON.stringify({ schema: 99 }));
const kinds = (state: string): string[] => listRunEntries(state).map((e) => (e.kind === "run" ? `${e.run.id}:${e.run.state}` : `unreadable:${e.id}`));

// Finding 1
test("a newer-version directory with a summary is unreadable, and retention keeps it", (t) => {
  const state = tmp(t);
  const dir = finished(state, 1);
  listRuns(state); // writes the summary
  assert.ok(existsSync(runFile(dir, "summary")));
  newerVersion(dir);
  assert.deepEqual(kinds(state), [`unreadable:${runId(1)}`]);
  assert.deepEqual(pruneFinishedRuns(state, { ...PERIOD, now: () => T0 + 999 * DAY_MS }), []);
  assert.ok(existsSync(dir), "a directory this core cannot read is never deleted");
});

// Finding 2
test("start-up cleanup modifies nothing inside a newer-version directory", (t) => {
  const state = tmp(t);
  const empty = runWith(state, 1, []);
  rmSync(runFile(empty, "events"));
  newerVersion(empty);
  const full = finished(state, 2);
  newerVersion(full);
  const temp = join(full, "run.json.tmp-1-1");
  writeFileSync(temp, "x");
  const report = cleanupStore(state);
  assert.deepEqual(report.removedRuns, []);
  assert.ok(existsSync(empty), "a newer-version directory without events.jsonl is kept");
  assert.ok(existsSync(temp), "a temp-named file inside a newer-version directory is kept");
});

// Finding 3
test("a summary naming another run is not believed", (t) => {
  const state = tmp(t);
  finished(state, 1);
  const other = finished(state, 2, "failed");
  const before = kinds(state);
  const sum = runFile(other, "summary");
  const doc = JSON.parse(readFileSync(sum, "utf8")) as { run: { id: string } };
  doc.run.id = runId(1);
  writeFileSync(sum, JSON.stringify(doc));
  assert.deepEqual(kinds(state), before);
});

test("an edited summary changes neither the listing nor what retention removes", (t) => {
  const state = tmp(t);
  const dir = finished(state, 1, "failed", T0 + 8 * DAY_MS);
  const before = kinds(state);
  const sum = runFile(dir, "summary");
  const doc = JSON.parse(readFileSync(sum, "utf8")) as { run: { state: string; ended_at: string; updated_at: string } };
  doc.run.state = "cancelled";
  doc.run.ended_at = new Date(T0).toISOString();
  doc.run.updated_at = doc.run.ended_at;
  writeFileSync(sum, JSON.stringify(doc));
  assert.deepEqual(kinds(state), before, "the listing says what the log says");
  assert.deepEqual(pruneFinishedRuns(state, { ...PERIOD, now: () => T0 + 11 * DAY_MS }), []);
  assert.ok(existsSync(dir), "the run ended 3 days before, by its log");
});

test("retention re-derives a run from its log before deleting it, even with a current summary", (t) => {
  const state = tmp(t);
  const dir = finished(state, 1);
  listRuns(state);
  assert.ok(existsSync(runFile(dir, "summary")));
  const read: string[] = [];
  const readFile = (p: string): Buffer => (read.push(p), readFileSync(p));
  assert.deepEqual(pruneFinishedRuns(state, { ...PERIOD, now: () => T0 + 11 * DAY_MS, readFile }), [runId(1)]);
  assert.ok(read.includes(runFile(dir, "events")), "the log was read before the delete");
});

test("a log corrupted at the same size is not listed from the summary", async (t) => {
  const state = tmp(t);
  const tailDir = finished(state, 1);
  const midDir = finished(state, 2);
  listRuns(state);
  await new Promise((r) => setTimeout(r, 30)); // a later clock tick than the summary
  for (const [dir, pick] of [
    [tailDir, (lines: string[]) => lines.length - 2],
    [midDir, () => 1],
  ] as const) {
    const log = readFileSync(runFile(dir, "events"), "utf8");
    const lines = log.split("\n");
    const i = pick(lines);
    lines[i] = `X${(lines[i] ?? "").slice(1)}`;
    const broken = lines.join("\n");
    assert.equal(broken.length, log.length);
    writeFileSync(runFile(dir, "events"), broken);
  }
  assert.deepEqual(kinds(state), [`unreadable:${runId(2)}`, `unreadable:${runId(1)}`]);
});

// Finding 4
test("retention removes every known finished state, and the documents name each one", (t) => {
  const state = tmp(t);
  finished(state, 1, "succeeded");
  finished(state, 2, "failed");
  runWith(state, 3, ["running", "cancelling", "cancelled"]);
  runWith(state, 4, ["running", "cancelling", "timed_out"]);
  runWith(state, 5, ["running", "cancelling", "unanswered"]);
  const kept = runWith(state, 6, ["running", "unknown"]);
  const removed = pruneFinishedRuns(state, { ...PERIOD, now: () => T0 + 11 * DAY_MS }).sort();
  assert.deepEqual(removed, [1, 2, 3, 4, 5].map(runId).sort());
  assert.ok(existsSync(kept), "unknown is never removed");
  const readme = readFileSync(join(ROOT, "contract/README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Retention of finished runs"));
  const rule = section.slice(0, section.indexOf("\n## ", 5));
  const header = readFileSync(join(ROOT, "core/src/store/retention.ts"), "utf8").split("*/")[0] ?? "";
  for (const s of ["succeeded", "failed", "cancelled", "timed_out", "unanswered"]) {
    assert.ok(rule.includes(`\`${s}\``), `contract/README.md retention rule names ${s}`);
    assert.ok(header.includes(`\`${s}\``), `retention.ts header names ${s}`);
  }
});

// Finding 5
test("a damaged retained.json keeps the run, as readRetained reads it", (t) => {
  const state = tmp(t);
  const zero = finished(state, 1);
  const noSandbox = finished(state, 2);
  writeFileSync(runFile(zero, "retained"), JSON.stringify({ until: 0 }));
  writeFileSync(runFile(noSandbox, "retained"), JSON.stringify({ until: new Date(T0).toISOString() }));
  for (const dir of [zero, noSandbox]) {
    const written = (T0 + 5 * DAY_MS) / 1000;
    utimesSync(runFile(dir, "retained"), written, written);
    assert.equal(readRetained(dir)?.until, T0 + 12 * DAY_MS, "damaged: kept 7 days from the file time");
  }
  assert.deepEqual(pruneFinishedRuns(state, { ...PERIOD, now: () => T0 + 21 * DAY_MS }), []);
  assert.ok(existsSync(zero) && existsSync(noSandbox));
  assert.equal(pruneFinishedRuns(state, { ...PERIOD, now: () => T0 + 23 * DAY_MS }).length, 2);
});

// Finding 6
test("start-up cleanup never follows a symlinked run directory out of the store", (t) => {
  const state = tmp(t);
  const outside = tmp(t);
  writeFileSync(join(outside, "events.jsonl"), "{}\n");
  const temp = join(outside, "precious.tmp-1-1");
  writeFileSync(temp, "x");
  mkdirSync(runsDir(state), { recursive: true });
  symlinkSync(outside, runDir(state, runId(1)));
  cleanupStore(state);
  assert.ok(existsSync(temp), "a file outside the state directory is never deleted");
  assert.ok(existsSync(join(outside, "events.jsonl")));
});

test("a temp-named directory does not stop the sweep", (t) => {
  const state = tmp(t);
  const dir = finished(state, 1);
  mkdirSync(join(runsDir(state), "odd.tmp-1-2"));
  mkdirSync(join(dir, "odd.tmp-1-3"));
  const temp = join(dir, "run.json.tmp-1-4");
  writeFileSync(temp, "x");
  const warnings: string[] = [];
  const report = cleanupStore(state, (line) => warnings.push(line));
  assert.ok(!existsSync(temp), "the temp file after the bad entry is still swept");
  assert.deepEqual(report.removedTemps, [temp]);
  assert.ok(warnings.length >= 1, "the bad entries are reported");
});
