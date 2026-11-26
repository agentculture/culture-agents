/**
 * The follower: it reads each run's log, publishes each event after its append, keeps on disk how
 * far it got, and after a broker outage or a core restart publishes what it missed with the same
 * ids. The transport here is a recording fake; broker.test.ts runs the same code on a real broker.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { POSITION_FILE, createPublisher, eventId, readPosition, type Publisher } from "../../src/publish/index.js";
import { readLog } from "../../src/store/event-log.js";
import { runFile } from "../../src/store/files.js";
import { FakeTransport, MARKERS, SOURCE, assertNoContent, contentRun, seedRun } from "./support.js";

function publisher(stateDir: string, transport: FakeTransport, warnings: string[] = []): Publisher {
  return createPublisher({ stateDir, source: SOURCE, transport, warn: (line) => void warnings.push(line) });
}

test("each event is published after its append, in cursor order, with the id and cursor of its log line", async (t) => {
  const { stateDir, run, dir, writer } = seedRun(t);
  const transport = new FakeTransport();
  const pub = publisher(stateDir, transport);

  assert.equal(await pub.pass(), 1);
  assert.deepEqual(transport.envelopes().map((e) => e.type), ["agents.run.queued"]);
  assert.equal(await pub.pass(), 0, "nothing new was appended");

  writer.transition("running", null);
  writer.append({ kind: "run.output", data: { channel: "text", text: "Working" } });
  assert.equal(await pub.pass(), 2);
  writer.transition("succeeded", null);
  writer.close();
  assert.equal(await pub.pass(), 1);
  assert.equal(await pub.pass(), 0);

  const log = readLog(dir, run.id).events;
  const sent = transport.envelopes();
  assert.deepEqual(sent.map((e) => e.data.cursor), [1, 2, 3, 4]);
  assert.deepEqual(sent.map((e) => e.id), log.map((e) => eventId(run.id, e.cursor)));
  assert.deepEqual(sent.map((e) => e.time), log.map((e) => e.time), "the time is the log line's time");
  assert.deepEqual(sent.map((e) => e.type), ["agents.run.queued", "agents.run.running", "agents.run.output", "agents.run.succeeded"]);
  assert.deepEqual(sent.map((e) => e.data.state), ["queued", "running", "running", "succeeded"]);
  assert.deepEqual(sent.map((e) => e.data.kind), log.map((e) => e.kind));
  assert.deepEqual(transport.sent.map((s) => s.topic), ["events/agents/run/queued", "events/agents/run/running", "events/agents/run/output", "events/agents/run/succeeded"]);
  for (const e of sent) {
    assert.equal(e.runId, run.id);
    assert.equal(e.data.run_id, run.id);
    assert.equal(e.source, SOURCE);
  }
});

test("a message holds run id, event type, state, cursor and time, and no content of the run", async (t) => {
  const { stateDir, run, dir } = contentRun(t);
  // The markers really are in the run: the record holds the prompt, the log the rest.
  const record = readFileSync(runFile(dir, "record"), "utf8");
  const logText = readFileSync(runFile(dir, "events"), "utf8");
  assert.ok(record.includes(MARKERS.prompt));
  for (const [name, marker] of Object.entries(MARKERS)) {
    if (name !== "prompt") assert.ok(logText.includes(marker), `${name} is in the log`);
  }

  const transport = new FakeTransport();
  const pub = publisher(stateDir, transport);
  while ((await pub.pass()) > 0);

  const log = readLog(dir, run.id).events;
  assert.equal(transport.sent.length, log.length, "every event of the log was published");
  assert.deepEqual([...new Set(log.map((e) => e.kind))].sort(), ["run.answer", "run.control", "run.error", "run.output", "run.question", "run.refused", "run.state"]);
  for (const sent of transport.sent) {
    assertNoContent(sent.payload);
    assertNoContent(sent.topic);
    const envelope = JSON.parse(sent.payload) as Record<string, unknown>;
    assert.deepEqual(Object.keys(envelope).sort(), ["data", "id", "runId", "schemaVersion", "source", "time", "type"]);
    assert.deepEqual(Object.keys(envelope["data"] as object).sort(), ["cursor", "kind", "run_id", "state"]);
  }
  assert.deepEqual(
    transport.envelopes().map((e) => e.type),
    ["queued", "running", "output", "output", "output", "output", "control", "refused", "question", "answer", "error", "failed"].map((s) => `agents.run.${s}`),
  );
});

test("how far each run is published is kept on disk, owner-only, and only moves after the broker took the event", async (t) => {
  const { stateDir, dir, writer } = seedRun(t);
  writer.transition("running", null);
  const transport = new FakeTransport();
  const pub = publisher(stateDir, transport);
  assert.equal(readPosition(dir).cursor, 0, "nothing is published yet");
  assert.ok(!existsSync(join(dir, POSITION_FILE)));

  transport.down = true;
  assert.equal(await pub.pass(), 0);
  assert.equal(readPosition(dir).cursor, 0, "a refused publish moves nothing");

  transport.down = false;
  const seen: number[] = [];
  transport.onPublish = () => void seen.push(readPosition(dir).cursor);
  assert.equal(await pub.pass(), 2);
  assert.deepEqual(seen, [0, 1], "the position moves after each publish, never before it");
  assert.equal(readPosition(dir).cursor, 2);
  assert.equal(statSync(join(dir, POSITION_FILE)).mode & 0o777, 0o600);
  writer.close();
});

test("with the broker down nothing is lost: after it returns every missed event is published once, in order, with its original id", async (t) => {
  const { stateDir, run, dir, writer } = seedRun(t);
  const transport = new FakeTransport();
  const warnings: string[] = [];
  const pub = publisher(stateDir, transport, warnings);
  await pub.pass();

  transport.down = true;
  writer.transition("running", null);
  writer.append({ kind: "run.output", data: { channel: "text", text: "one" } });
  for (let i = 0; i < 5; i++) assert.equal(await pub.pass(), 0);
  writer.append({ kind: "run.output", data: { channel: "text", text: "two" } });
  writer.transition("succeeded", null);
  writer.close();
  assert.equal(await pub.pass(), 0);
  assert.equal(warnings.filter((w) => /broker/.test(w)).length, 1, `an outage is reported once, not once per attempt: ${warnings.join(" | ")}`);
  assert.equal(readLog(dir, run.id).tail.state, "succeeded", "the run ended while the broker was down");

  transport.down = false;
  while ((await pub.pass()) > 0);
  assert.deepEqual(transport.envelopes().map((e) => e.id), [1, 2, 3, 4, 5].map((c) => eventId(run.id, c)));
  assert.ok(warnings.some((w) => /again/.test(w)), "the recovery is reported");
});

test("a broker that fails mid-run stops that pass at the failed event and resumes from it, skipping none", async (t) => {
  const { stateDir, run, writer } = seedRun(t);
  writer.transition("running", null);
  for (let i = 0; i < 6; i++) writer.append({ kind: "run.output", data: { channel: "text", text: `chunk ${i}` } });
  writer.close();
  const transport = new FakeTransport();
  const pub = publisher(stateDir, transport);
  transport.onPublish = () => {
    if (transport.sent.length === 3) {
      transport.down = true;
      throw new Error("connection lost");
    }
  };
  assert.equal(await pub.pass(), 3);
  transport.onPublish = null;
  transport.down = false;
  while ((await pub.pass()) > 0);
  assert.deepEqual(transport.envelopes().map((e) => e.data.cursor), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(transport.envelopes().map((e) => e.id), [1, 2, 3, 4, 5, 6, 7, 8].map((c) => eventId(run.id, c)));
});

test("a core restart publishes what the old core missed, with the same ids, and repeats nothing it had recorded", async (t) => {
  const { stateDir, run, dir, writer } = seedRun(t);
  writer.transition("running", null);
  const first = new FakeTransport();
  await publisher(stateDir, first).pass(); // the old core published 1 and 2, then died
  assert.equal(readPosition(dir).cursor, 2);

  writer.append({ kind: "run.output", data: { channel: "text", text: "appended while no core ran" } });
  writer.transition("succeeded", null);
  writer.close();

  const second = new FakeTransport();
  const restarted = publisher(stateDir, second);
  while ((await restarted.pass()) > 0);
  assert.deepEqual(second.envelopes().map((e) => e.id), [eventId(run.id, 3), eventId(run.id, 4)]);
  assert.deepEqual(second.envelopes().map((e) => e.data.state), ["running", "succeeded"], "the state is known after a restart");
  assert.equal(readPosition(dir).cursor, 4);

  const third = new FakeTransport();
  assert.equal(await publisher(stateDir, third).pass(), 0, "a finished, fully published run is not published again");
});

test("a core killed between an append and its publish publishes that event once after the restart", async (t) => {
  const { stateDir, run, dir, writer } = seedRun(t);
  const first = new FakeTransport();
  const old = publisher(stateDir, first);
  await old.pass();
  writer.transition("running", null); // appended; the old core dies before it publishes this
  writer.close();
  assert.equal(readPosition(dir).cursor, 1);

  const second = new FakeTransport();
  const restarted = publisher(stateDir, second);
  while ((await restarted.pass()) > 0);
  const all = [...first.envelopes(), ...second.envelopes()].filter((e) => e.data.cursor === 2);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.id, eventId(run.id, 2));
});

test("a core killed after a publish and before recording it republishes that event with the same id and bytes", async (t) => {
  const { stateDir, run, dir, writer } = seedRun(t);
  writer.transition("running", null);
  writer.close();
  const first = new FakeTransport();
  await publisher(stateDir, first).pass();
  // Put the position back by one event, as a crash between the broker's acknowledgement and the write would leave it.
  const before = JSON.parse(readFileSync(join(dir, POSITION_FILE), "utf8")) as Record<string, unknown>;
  assert.equal(before["cursor"], 2);
  const firstLineEnd = readFileSync(runFile(dir, "events")).indexOf(0x0a) + 1;
  writeFileSync(join(dir, POSITION_FILE), `${JSON.stringify({ cursor: 1, offset: firstLineEnd, state: "queued" })}\n`);

  const second = new FakeTransport();
  await publisher(stateDir, second).pass();
  assert.deepEqual(second.sent, [first.sent[1]], "the repeat is the same message: same topic, same bytes");
  assert.equal(second.envelopes()[0]?.id, eventId(run.id, 2));
});

test("a position file that cannot be trusted starts the run over rather than skipping an event", async (t) => {
  for (const bad of ["not json", '{"cursor":2,"offset":5,"state":"queued"}', '{"cursor":-1,"offset":0,"state":null}', '{"cursor":2,"offset":999999,"state":"running"}']) {
    const { stateDir, run, dir, writer } = seedRun(t);
    writer.transition("running", null);
    writer.transition("succeeded", null);
    writer.close();
    writeFileSync(join(dir, POSITION_FILE), `${bad}\n`);
    const transport = new FakeTransport();
    const pub = publisher(stateDir, transport);
    while ((await pub.pass()) > 0);
    const cursors = transport.envelopes().map((e) => e.data.cursor);
    assert.ok(cursors.includes(3), `${bad}: the last event is published`);
    assert.deepEqual(cursors, [...cursors].sort((a, b) => a - b));
    assert.deepEqual(cursors.at(-1), 3);
    assert.ok(cursors.length === 3 || cursors.length === 1, `${bad}: all three events or only the missing one, got ${cursors.join(",")}`);
    assert.deepEqual(transport.envelopes().map((e) => e.id), cursors.map((c) => eventId(run.id, c)));
  }
});

test("a torn final line is not an event: it is published only once its newline is in the file", async (t) => {
  const { stateDir, run, dir, writer } = seedRun(t);
  writer.close();
  const line = JSON.stringify({ run_id: run.id, cursor: 2, time: new Date().toISOString(), kind: "run.state", data: { from: "queued", to: "running", reason: null } });
  appendFileSync(runFile(dir, "events"), line.slice(0, 40));
  const transport = new FakeTransport();
  const pub = publisher(stateDir, transport);
  assert.equal(await pub.pass(), 1);
  assert.equal(await pub.pass(), 0, "half a line is not published");
  appendFileSync(runFile(dir, "events"), `${line.slice(40)}\n`);
  assert.equal(await pub.pass(), 1);
  assert.deepEqual(transport.envelopes().map((e) => e.data.cursor), [1, 2]);
});

test("a log line that breaks the cursor rule holds that run where it is, with one warning, and other runs go on", async (t) => {
  const bad = seedRun(t);
  bad.writer.close();
  appendFileSync(runFile(bad.dir, "events"), `${JSON.stringify({ run_id: bad.run.id, cursor: 5, time: new Date().toISOString(), kind: "run.output", data: { channel: "text", text: "x" } })}\n`);
  const good = seedRun(t, bad.stateDir);
  good.writer.transition("running", null);
  good.writer.close();

  const transport = new FakeTransport();
  const warnings: string[] = [];
  const pub = publisher(bad.stateDir, transport, warnings);
  for (let i = 0; i < 3; i++) await pub.pass();
  const byRun = (id: string) => transport.envelopes().filter((e) => e.runId === id).map((e) => e.data.cursor);
  assert.deepEqual(byRun(bad.run.id), [1], "the event after the gap is never published under a guessed cursor");
  assert.deepEqual(byRun(good.run.id), [1, 2]);
  assert.equal(warnings.filter((w) => w.includes(bad.run.id)).length, 1, warnings.join(" | "));
  for (const w of warnings) assert.ok(!w.includes('"text"'), "a warning never quotes the log line");
});

test("a long backlog is published in bounded batches so one run cannot starve the others", async (t) => {
  const big = seedRun(t);
  big.writer.transition("running", null);
  for (let i = 0; i < 30; i++) big.writer.append({ kind: "run.output", data: { channel: "text", text: `chunk ${i}` } });
  big.writer.close();
  const small = seedRun(t, big.stateDir);
  small.writer.close();
  const transport = new FakeTransport();
  const pub = createPublisher({ stateDir: big.stateDir, source: SOURCE, transport, warn: () => undefined, batch: 10 });
  await pub.pass();
  const first = transport.envelopes();
  assert.equal(first.filter((e) => e.runId === big.run.id).length, 10);
  assert.equal(first.filter((e) => e.runId === small.run.id).length, 1, "the other run was served in the same pass");
  while ((await pub.pass()) > 0);
  assert.deepEqual(transport.envelopes().filter((e) => e.runId === big.run.id).map((e) => e.data.cursor), Array.from({ length: 32 }, (_, i) => i + 1));
});

test("start follows the logs on its own until stop, and stop closes the transport", async (t) => {
  const { stateDir, run, writer } = seedRun(t);
  const transport = new FakeTransport();
  const pub = createPublisher({ stateDir, source: SOURCE, transport, warn: () => undefined, pollMs: 10, retryMs: 10 });
  pub.start();
  writer.transition("running", null);
  transport.down = true;
  writer.transition("succeeded", null);
  writer.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  transport.down = false;
  const deadline = Date.now() + 5000;
  while (transport.sent.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(transport.envelopes().map((e) => e.id), [1, 2, 3].map((c) => eventId(run.id, c)));
  await pub.stop();
  assert.ok(transport.closed);
  await pub.stop(); // twice is fine
});

test("stop does not wait for a publish the broker never acknowledges", async (t) => {
  const { stateDir, writer } = seedRun(t);
  writer.close();
  const transport = new FakeTransport();
  transport.onPublish = () => new Promise<void>(() => undefined); // never settles
  const pub = createPublisher({ stateDir, source: SOURCE, transport, warn: () => undefined, pollMs: 10 });
  pub.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const started = Date.now();
  await pub.stop();
  assert.ok(Date.now() - started < 2000, "stop returned promptly");
});
