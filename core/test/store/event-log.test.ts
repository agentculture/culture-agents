import assert from "node:assert/strict";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { validate, type RunEvent } from "../../src/contract/index.js";
import { EventLogCorruptError, EventLogWriter, readCursorFile, readLog } from "../../src/store/event-log.js";
import { runFile } from "../../src/store/files.js";
import { createRun, followEvents, readEvents, settleOrphan, showRunAt } from "../../src/store/run-store.js";
import { newRun, stateDir } from "../worker/helpers.js";

function seeded(t: Parameters<typeof stateDir>[0]) {
  const run = newRun();
  const dir = createRun(stateDir(t), run);
  const writer = EventLogWriter.open(dir, run.id);
  writer.transition("queued", null, true);
  writer.transition("running", null);
  writer.append({ kind: "run.output", data: { channel: "text", text: "Working" } });
  return { run, dir, writer };
}

test("appends are validated, numbered 1, 2, 3 and mirrored in an owner-only cursor file", (t) => {
  const { run, dir, writer } = seeded(t);
  writer.close();
  const log = readLog(dir, run.id);
  assert.deepEqual(log.events.map((e) => e.cursor), [1, 2, 3]);
  for (const event of log.events) assert.ok(validate("event", event).ok);
  assert.equal(readCursorFile(dir), 3);
  for (const file of ["events", "cursor", "record"] as const) {
    assert.equal(statSync(runFile(dir, file)).mode & 0o777, 0o600, `${file} is owner-only`);
  }
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("an illegal or invalid event is refused and nothing is written", (t) => {
  const { dir, writer } = seeded(t);
  assert.throws(() => writer.transition("cancelled", null), /illegal transition/);
  assert.throws(() => writer.append({ kind: "run.output", data: { channel: "nope", text: "" } as never }), /invalid/);
  writer.transition("succeeded", null);
  assert.throws(() => writer.append({ kind: "run.output", data: { channel: "text", text: "late" } }), /after the terminal/);
  writer.close();
  assert.equal(readCursorFile(dir), 4);
  assert.equal(readFileSync(runFile(dir, "events"), "utf8").trim().split("\n").length, 4);
});

test("a torn final line is ignored by readers, never invents a state, and is dropped by the next writer", (t) => {
  const { run, dir, writer } = seeded(t);
  writer.close();
  appendFileSync(runFile(dir, "events"), '{"run_id":"' + run.id + '","cursor":4,"time":"2026-11-25T10:00:0');
  const log = readLog(dir, run.id);
  assert.equal(log.torn, true);
  assert.deepEqual(log.events.map((e) => e.cursor), [1, 2, 3]);
  // No worker recorded: the run reads unknown, never succeeded.
  const shown = showRunAt(dir);
  assert.equal(shown?.run.state, "unknown");
  assert.equal(shown?.orphaned, true);
  // The core settles it: the torn bytes go, earlier events stay, `unknown` lands at cursor 4.
  const settled = settleOrphan(dir, run.id);
  assert.equal(settled?.cursor, 4);
  const after = readLog(dir, run.id);
  assert.equal(after.torn, false);
  assert.deepEqual(after.events.map((e) => [e.cursor, e.kind]), [
    [1, "run.state"],
    [2, "run.state"],
    [3, "run.output"],
    [4, "run.state"],
  ]);
  assert.equal((after.events[3]?.data as { to: string }).to, "unknown");
  assert.equal(settleOrphan(dir, run.id), null, "a terminal run is never settled twice");
});

test("a broken line before the end is corruption, not something to skip", (t) => {
  const { run, dir, writer } = seeded(t);
  writer.close();
  const lines = readFileSync(runFile(dir, "events"), "utf8").split("\n");
  lines[1] = "{not json";
  writeFileSync(runFile(dir, "events"), lines.join("\n"));
  assert.throws(() => readLog(dir, run.id), EventLogCorruptError);
});

test("readEvents returns exactly the events after the cursor", (t) => {
  const { run, dir, writer } = seeded(t);
  writer.close();
  assert.deepEqual(readEvents(dir, run.id, 0).events.map((e) => e.cursor), [1, 2, 3]);
  assert.deepEqual(readEvents(dir, run.id, 1).events.map((e) => e.cursor), [2, 3]);
  const page = readEvents(dir, run.id, 1, 1);
  assert.deepEqual(page.events.map((e) => e.cursor), [2]);
  assert.equal(page.more, true);
  assert.equal(page.lastCursor, 3);
  assert.deepEqual(readEvents(dir, run.id, 3).events, []);
  assert.throws(() => readEvents(dir, run.id, 4), RangeError);
});

test("followEvents replays after the cursor, then picks up new events and ends at the terminal one", async (t) => {
  const { run, dir, writer } = seeded(t);
  t.after(() => writer.close());
  const seen: RunEvent[] = [];
  const follower = (async () => {
    for await (const event of followEvents(dir, run.id, 1, { pollMs: 5, orphanCheckMs: 0 })) seen.push(event);
  })();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(seen.map((e) => e.cursor), [2, 3]);
  writer.append({ kind: "run.output", data: { channel: "text", text: " more" } });
  writer.transition("succeeded", null);
  await follower;
  assert.deepEqual(seen.map((e) => e.cursor), [2, 3, 4, 5]);
});

test("followEvents on a run with no live worker settles it as unknown and ends", async (t) => {
  const { run, dir, writer } = seeded(t);
  writer.close();
  const seen: RunEvent[] = [];
  for await (const event of followEvents(dir, run.id, 3, { pollMs: 5, orphanCheckMs: 10 })) seen.push(event);
  assert.equal(seen.length, 1);
  assert.equal((seen[0]?.data as { to: string }).to, "unknown");
});
