/**
 * Publishing against a real broker: a throwaway Mosquitto started by each test (broker.ts). When
 * none can start, each test is skipped as NOT VERIFIED.
 *
 * The first test drives the publisher directly. The others run the real core (the daemon child of
 * the run-service tests) with real worker processes, so the path under test is the shipped one:
 * a worker appends, the core's follower reads the log and publishes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import type { RunEvent } from "../../src/contract/index.js";
import { BROKER_URL_ENV, POSITION_FILE, createPublisher, eventId, loadPublishConfig, readPosition, type PublishConfig } from "../../src/publish/index.js";
import { connectBroker } from "../../src/publish/transport.js";
import { readLog } from "../../src/store/event-log.js";
import { runDir } from "../../src/store/files.js";
import { events, killDaemon, makeEnv, ok, startDaemon, submitBody, waitFor, waitRun, type Env, type FakeHarness } from "../runs/support.js";
import { startBroker, type Subscriber } from "./broker.js";
import { MARKERS, SOURCE, assertNoContent, contentRun } from "./support.js";

const configOf = (url: string): PublishConfig => loadPublishConfig({ [BROKER_URL_ENV]: url }) as PublishConfig;

/** A run whose prompt, output and tool result carry markers, with a pause in the middle. */
const harness = (id: string, pauseMs: number): FakeHarness => ({
  id,
  steps: [
    { op: "started" },
    { op: "output", data: { channel: "text", text: MARKERS.output } },
    { op: "output", data: { channel: "tool_result", text: MARKERS.toolResult } },
    { op: "sleep", ms: pauseMs },
    { op: "output", data: { channel: "reasoning", text: MARKERS.reasoning } },
    { op: "completed", summary: MARKERS.output },
  ],
});
/** queued, running, three outputs, succeeded. */
const EVENTS = 6;

async function submitMarked(env: Env, harnessId: string): Promise<string> {
  const body = submitBody(harnessId, env.repoA, { task: MARKERS.prompt });
  return (await ok<{ run: { id: string } }>(env, "POST", "/v1/runs", 201, "control-action#submit_response", body)).run.id;
}

function assertLifecycleOnly(sub: Subscriber): void {
  for (const message of sub.received) {
    assertNoContent(message.payload);
    assertNoContent(message.topic);
  }
}

/**
 * The broker's own reader, when a checkout of it is named by CULTURE_AGENTS_EVENTS_CLI_DIR: every
 * payload must parse as its envelope and every topic must map back to the envelope's type.
 * Returns null when no checkout is named.
 */
function readWithEventsCli(messages: { topic: string; payload: string }[]): string | null {
  const checkout = process.env["CULTURE_AGENTS_EVENTS_CLI_DIR"];
  if (!checkout) return null;
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from events_cli.core.envelope import Envelope",
    "from events_cli.core.topics import topic_to_type",
    "count = 0",
    "for line in sys.stdin:",
    "    message = json.loads(line)",
    "    envelope = Envelope.from_json(message['payload'])",
    "    assert not envelope.unknown_marks()",
    "    assert topic_to_type(message['topic']) == envelope.type, message['topic']",
    "    assert len(envelope.type.split('.')) <= 4, envelope.type",
    "    assert envelope.to_json() == message['payload'], 'the reader writes back the same bytes'",
    "    count += 1",
    "print(count)",
  ].join("\n");
  const result = spawnSync("python3", ["-I", "-c", script, checkout], { input: messages.map((m) => JSON.stringify(m)).join("\n"), encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `the events-cli reader refused a message: ${result.stderr}`);
  return result.stdout.trim();
}

test("every run event type is read back through a subscriber, and publishing an event twice yields one id", async (t) => {
  const broker = await startBroker(t);
  if (!broker) return;
  const { stateDir, run, dir } = contentRun(t);
  const log = readLog(dir, run.id).events;
  const sub = await broker.subscribe();

  const first = createPublisher({ stateDir, source: SOURCE, transport: connectBroker(configOf(broker.url)), warn: () => undefined, pollMs: 20, retryMs: 50 });
  first.start();
  await sub.waitFor(log.length);
  await first.stop();

  const got = sub.envelopes();
  assert.deepEqual(got.map((e) => e.id), log.map((e) => eventId(run.id, e.cursor)));
  assert.deepEqual(got.map((e) => e.data.cursor), log.map((e) => e.cursor));
  assert.deepEqual(got.map((e) => e.time), log.map((e) => e.time));
  assert.deepEqual(
    got.map((e) => e.type),
    ["queued", "running", "output", "output", "output", "output", "control", "refused", "question", "answer", "error", "failed"].map((s) => `agents.run.${s}`),
  );
  assert.deepEqual(sub.received.map((m) => m.topic), got.map((e) => `events/${e.type.replaceAll(".", "/")}`));
  for (const e of got) assert.ok(e.type.split(".").length <= 4);
  assertLifecycleOnly(sub);

  // Publish the whole run again, as a core that lost its position would.
  rmSync(join(dir, POSITION_FILE));
  const second = createPublisher({ stateDir, source: SOURCE, transport: connectBroker(configOf(broker.url)), warn: () => undefined, pollMs: 20, retryMs: 50 });
  second.start();
  await sub.waitFor(log.length * 2);
  await second.stop();
  assert.equal(new Set(sub.envelopes().map((e) => e.id)).size, log.length, "the second publish added no new id");
  assert.deepEqual(sub.received.slice(log.length), sub.received.slice(0, log.length), "the same topics and the same bytes");

  const read = readWithEventsCli(sub.received);
  if (read === null) t.diagnostic("NOT VERIFIED: the events-cli reader was not run (set CULTURE_AGENTS_EVENTS_CLI_DIR to a checkout)");
  else {
    assert.equal(read, String(log.length * 2));
    t.diagnostic(`the events-cli reader parsed all ${read} messages`);
  }
});

test("a real core publishes a run's events as its worker appends them; a subscriber that drops out catches up from the log by cursor", async (t) => {
  const broker = await startBroker(t);
  if (!broker) return;
  const env = makeEnv(t, [harness("fake-pub", 600)]);
  env.vars[BROKER_URL_ENV] = broker.url;
  const full = await broker.subscribe();
  const flaky = await broker.subscribe();
  await startDaemon(t, env);

  const runId = await submitMarked(env, "fake-pub");
  await flaky.waitFor(3);
  await flaky.close(); // the connection drops mid-run
  const seen = flaky.envelopes();
  assert.ok(seen.length >= 3 && seen.length < EVENTS, `the subscriber dropped mid-run (${seen.length} events)`);

  const ended = await waitRun(env, runId, (r) => r.terminal, "terminal", 15_000);
  assert.equal(ended.state, "succeeded");
  await full.waitFor(EVENTS);
  const log = await events(env, runId);
  assert.equal(log.length, EVENTS);

  // What the one that stayed saw: every event, once, in order, with the log's ids.
  await delay(300);
  assert.deepEqual(full.envelopes().map((e) => e.id), log.map((e) => eventId(runId, e.cursor)));
  assert.deepEqual(full.envelopes().map((e) => e.type), ["queued", "running", "output", "output", "output", "succeeded"].map((s) => `agents.run.${s}`));
  assert.deepEqual(full.envelopes().map((e) => e.source), Array<string>(EVENTS).fill("app://culture-agents/thor"));
  assertLifecycleOnly(full);
  assert.ok(JSON.stringify(log).includes(MARKERS.toolResult), "the content is in the log, where the core's own access rules apply");

  // The one that dropped resumes from the core by the last cursor it saw.
  const last = seen.at(-1)?.data.cursor as number;
  const missed = (await ok<{ events: RunEvent[] }>(env, "GET", `/v1/runs/${runId}/events?after=${last}`, 200, "event#event_page")).events;
  const cursors = [...seen.map((e) => e.data.cursor), ...missed.map((e) => e.cursor)];
  assert.deepEqual(cursors, [1, 2, 3, 4, 5, 6], "every event once, none missing, none twice");
  assert.equal(readPosition(runDir(env.stateDir, runId)).cursor, EVENTS);
});

test("broker down for a whole run, then a core restart: every event is published once, with its original id, after the broker returns", async (t) => {
  const broker = await startBroker(t);
  if (!broker) return;
  const env = makeEnv(t, [harness("fake-pub", 200)]);
  env.vars[BROKER_URL_ENV] = broker.url;
  broker.stop();
  const first = await startDaemon(t, env);
  const runId = await submitMarked(env, "fake-pub");
  const ended = await waitRun(env, runId, (r) => r.terminal, "terminal", 15_000);
  assert.equal(ended.state, "succeeded", "the run ended the same way with the broker stopped");
  const log = await events(env, runId);
  assert.equal(log.length, EVENTS);
  await waitFor(() => /broker is not taking run events/.test(first.stderr()), 10_000, "the outage line");
  assert.equal(readPosition(runDir(env.stateDir, runId)).cursor, 0);
  await killDaemon(first); // the core dies with every event appended and none published

  await broker.start();
  const sub = await broker.subscribe();
  await startDaemon(t, env);
  await sub.waitFor(EVENTS);
  await delay(1500); // longer than a publish round and a reconnect: a repeat would have arrived
  assert.deepEqual(sub.envelopes().map((e) => e.id), log.map((e) => eventId(runId, e.cursor)), "each event once, in order, none skipped");
  assert.deepEqual(sub.envelopes().map((e) => e.time), log.map((e) => e.time), "with the time of its append, not of its publish");
  assertLifecycleOnly(sub);
  assert.equal(readPosition(runDir(env.stateDir, runId)).cursor, EVENTS);
  assert.deepEqual(await events(env, runId), log, "publishing changed nothing in the log");
});

test("broker stopped in the middle of a run: the run ends the same, and the missed events are published when the broker returns", async (t) => {
  const broker = await startBroker(t);
  if (!broker) return;
  const env = makeEnv(t, [harness("fake-pub", 2500)]);
  env.vars[BROKER_URL_ENV] = broker.url;
  const before = await broker.subscribe();
  const daemon = await startDaemon(t, env);
  const runId = await submitMarked(env, "fake-pub");
  await before.waitFor(2);
  broker.stop(); // during the run's pause

  const ended = await waitRun(env, runId, (r) => r.terminal, "terminal", 20_000);
  assert.equal(ended.state, "succeeded");
  const log = await events(env, runId);
  assert.equal(log.length, EVENTS);
  const dir = runDir(env.stateDir, runId);
  const publishedBefore = readPosition(dir).cursor;
  assert.ok(publishedBefore >= 2 && publishedBefore < EVENTS, `some events are still to publish (${publishedBefore} of ${EVENTS})`);

  // Hold the core still while the broker returns, so the new subscriber is there before the core reconnects.
  daemon.proc.kill("SIGSTOP");
  t.after(() => void daemon.proc.kill("SIGCONT"));
  await broker.start();
  const after = await broker.subscribe();
  daemon.proc.kill("SIGCONT");

  await after.waitFor(EVENTS - publishedBefore);
  await delay(1500);
  assert.deepEqual(after.envelopes().map((e) => e.data.cursor), log.slice(publishedBefore).map((e) => e.cursor), "exactly the events not yet recorded as published, in order");
  const all = [...before.received, ...after.received];
  const byId = new Map(all.map((m) => [(JSON.parse(m.payload) as { id: string }).id, m.payload]));
  assert.deepEqual([...byId.keys()].sort(), log.map((e) => eventId(runId, e.cursor)).sort(), "none skipped, each under its original id");
  for (const m of all) assert.equal(m.payload, byId.get((JSON.parse(m.payload) as { id: string }).id), "an event seen twice is the same bytes");
  for (const sub of [before, after]) assertLifecycleOnly(sub);
  assert.equal(readPosition(dir).cursor, EVENTS);
  // The outage is announced only when a publish was tried while the broker was down. On a slow host the
  // run can end and the broker return between two publish rounds, and then nothing was refused.
  if (/broker is not taking run events/.test(daemon.stderr())) assert.match(daemon.stderr(), /the broker takes run events again/);
  assert.equal(JSON.parse(readFileSync(join(dir, POSITION_FILE), "utf8")).state, "succeeded");
});
