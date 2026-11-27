/**
 * The registry's driver selection runs unchanged inside a real worker process: the stub entry's
 * `driver` (module path + JSON options) goes into `driver.json`, the worker loads it, and the
 * run reaches `succeeded` with a valid event log and its commit on `runs/<id>`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validate, type RunEvent, type StateData } from "../../src/contract/index.js";
import { getHarness, loadHarnessConfig } from "../../src/harness/index.js";
import { followEvents } from "../../src/store/run-store.js";
import { spawnWorker } from "../../src/worker/spawn.js";
import { branchFiles, hostRepo, newRun } from "./helpers.js";

test("a worker process runs the stub harness from its registry entry to succeeded", { timeout: 30_000 }, async (t) => {
  const { dir: repo, git } = hostRepo(t);
  const stateDir = mkdtempSync(join(tmpdir(), "ca-harness-state-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const entry = getHarness({ ...loadHarnessConfig({ HOME: "/nonexistent" }), stub: true }, "stub");
  assert.ok(entry);
  const run = newRun(repo, "files: from-worker.txt", "stub");
  const worker = await spawnWorker({ stateDir, run, driver: entry.driver, heartbeatMs: 50 });
  t.after(() => {
    try {
      process.kill(worker.pid, "SIGKILL");
    } catch {
      // already exited
    }
  });
  const events: RunEvent[] = [];
  for await (const e of followEvents(worker.runDir, run.id, 0, { pollMs: 10, orphanCheckMs: 0, signal: AbortSignal.timeout(20_000) })) events.push(e);
  const states = events.filter((e) => e.kind === "run.state").map((e) => (e.data as StateData).to);
  assert.deepEqual(states, ["queued", "running", "succeeded"]);
  for (const e of events) assert.ok(validate("event", e).ok, `event ${e.cursor} validates`);
  assert.ok(events.some((e) => e.kind === "run.output"), "output was logged");
  // Each text output is one whole line, so a result summary (the texts joined) reads as lines.
  const texts = events.filter((e) => e.kind === "run.output" && (e.data as { channel: string }).channel === "text").map((e) => (e.data as { text: string }).text);
  assert.ok(texts.length >= 2, "a start line and an end line");
  assert.ok(texts.every((line) => line.endsWith("\n")), "every stub text line ends with a newline");
  assert.deepEqual(branchFiles(git, run.id), ["README", "from-worker.txt"]);
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "main");
});
