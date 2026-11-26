/**
 * The published message: the broker's envelope, the type prefix, the id rule and the topic.
 *
 * The patterns below are the rules of the broker's own reader, copied from the events-cli
 * checkout the envelope follows (events_cli/core/envelope.py: `_ID_RE`, `_TYPE_RE`, the length
 * caps, `REQUIRED_FIELDS`, `WIRE_FIELD_NAMES`; events_cli/core/topics.py: `type_to_topic`). A
 * message that breaks one is acknowledged and dropped for good by that reader.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadSchemaFiles, runStates } from "../../src/contract/index.js";
import { MAX_TYPE_SEGMENTS, TYPE_PREFIX, buildMessage, eventId, eventType, sourceFor, topicFor, type RunFact } from "../../src/publish/index.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:+/=@-]*$/;
const TYPE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const MAX_ID = 128;
const MAX_TYPE = 128;
const WIRE_FIELDS = new Set([
  "id",
  "type",
  "source",
  "time",
  "schemaVersion",
  "correlationId",
  "causationId",
  "runId",
  "traceparent",
  "producer",
  "deliveryAttempt",
  "visibility",
  "origin",
  "fidelity",
  "timestamps",
  "data",
]);
const REQUIRED = ["id", "type", "source", "time", "schemaVersion", "data"];

const RUN = "thor-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5";
const KINDS = ["run.state", "run.output", "run.control", "run.refused", "run.error", "run.question", "run.answer"];
const fact = (over: Partial<RunFact> = {}): RunFact => ({ run_id: RUN, kind: "run.output", state: "running", cursor: 3, time: "2026-11-25T10:00:03.123Z", ...over });

test("every state and every event kind gets a type of its own under agents.run, within 4 segments", () => {
  assert.equal(TYPE_PREFIX, "agents.run");
  assert.equal(MAX_TYPE_SEGMENTS, 4);
  const types = new Set<string>();
  for (const state of runStates) types.add(eventType("run.state", state));
  for (const kind of KINDS.filter((k) => k !== "run.state")) types.add(eventType(kind, "running"));
  assert.equal(types.size, runStates.length + KINDS.length - 1, "no two facts share a type");
  for (const type of types) {
    assert.ok(type.startsWith("agents.run."), type);
    assert.match(type, TYPE_RE);
    assert.ok(type.length <= MAX_TYPE);
    assert.ok(type.split(".").length <= MAX_TYPE_SEGMENTS, `${type} has more than 4 segments`);
  }
  assert.equal(eventType("run.state", "succeeded"), "agents.run.succeeded");
  assert.equal(eventType("run.state", "timed_out"), "agents.run.timed_out");
  assert.equal(eventType("run.output", "running"), "agents.run.output");
  assert.equal(eventType("run.question", "running"), "agents.run.question");
});

test("the contract's event kinds are the ones this test covers", () => {
  // If the contract gains a kind, this fails until the kind is checked above.
  const schema = loadSchemaFiles().get("event.json") as unknown as { $defs: { kind: { enum: string[] } } };
  assert.deepEqual([...schema.$defs.kind.enum].sort(), [...KINDS].sort());
});

test("a kind or state that cannot be a type segment is refused, never published under a guessed type", () => {
  for (const kind of ["output", "run.", "run.Out", "run.a.b", "runs.output", "run.a b", "run.a/b", "run.#", "run.+"]) {
    assert.throws(() => eventType(kind, "running"), /event kind/, kind);
  }
  for (const state of ["", "Running", "a.b", "a/b", "a b", "#"]) assert.throws(() => eventType("run.state", state), /state/, JSON.stringify(state));
});

test("the id is the run id and the cursor, the same every time, and fits the broker's id rule", () => {
  assert.equal(eventId(RUN, 7), `${RUN}:7`);
  assert.equal(eventId(RUN, 7), eventId(RUN, 7));
  assert.notEqual(eventId(RUN, 7), eventId(RUN, 8));
  assert.match(eventId(RUN, 7), ID_RE);
  assert.throws(() => eventId(RUN, 0), /cursor/);
  assert.throws(() => eventId(RUN, 1.5), /cursor/);
});

test("a run id too long for `<run id>:<cursor>` still gets a stable, distinct id within 128 characters", () => {
  const long = `thor-${"a".repeat(91)}.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5`; // 127 characters, the contract's maximum
  assert.equal(long.length, 127);
  const other = `thor-${"a".repeat(90)}b.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5`;
  const id = eventId(long, 12);
  assert.ok(id.length <= MAX_ID, `${id.length} characters`);
  assert.match(id, ID_RE);
  assert.equal(id, eventId(long, 12));
  assert.notEqual(id, eventId(long, 13));
  assert.notEqual(id, eventId(other, 12));
  assert.ok(id.endsWith(":12"), "the cursor stays readable");
  // The longest id that still fits is used as it is.
  const fits = `thor-${"a".repeat(89)}.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5`;
  assert.equal(eventId(fits, 12), `${fits}:12`);
  assert.equal(eventId(fits, 12).length, MAX_ID);
});

test("the topic is events/ plus the type with dots as levels", () => {
  assert.equal(topicFor("agents.run.succeeded"), "events/agents/run/succeeded");
  assert.equal(topicFor("agents.run.timed_out"), "events/agents/run/timed_out");
  assert.throws(() => topicFor("agents.run.a.b.c"), /segments/);
  assert.throws(() => topicFor("Agents.run"), /type/);
  assert.throws(() => topicFor("agents/run"), /type/);
});

test("the source is an absolute URI naming this product and the node", () => {
  assert.equal(sourceFor("thor"), "app://culture-agents/thor");
  assert.ok(new URL(sourceFor("thor")).protocol === "app:");
  assert.throws(() => sourceFor("Not A Node"), /node/);
});

test("the message is the broker's envelope: required fields, known wire names, the cursor in data", () => {
  const { topic, payload, envelope } = buildMessage(fact({ kind: "run.state", state: "succeeded", cursor: 9 }), "app://culture-agents/thor");
  assert.equal(topic, "events/agents/run/succeeded");
  const wire = JSON.parse(payload) as Record<string, unknown>;
  assert.deepEqual(wire, envelope);
  for (const key of Object.keys(wire)) assert.ok(WIRE_FIELDS.has(key), `${key} is not an envelope field`);
  for (const key of REQUIRED) assert.ok(key in wire, `${key} is required`);
  for (const value of Object.values(wire)) assert.notEqual(value, null, "absent fields are omitted, never null");
  assert.deepEqual(wire, {
    id: `${RUN}:9`,
    type: "agents.run.succeeded",
    source: "app://culture-agents/thor",
    time: "2026-11-25T10:00:03.123Z",
    schemaVersion: "1",
    runId: RUN,
    data: { run_id: RUN, kind: "run.state", state: "succeeded", cursor: 9 },
  });
  assert.match(wire["time"] as string, TIME_RE);
  assert.match(wire["runId"] as string, ID_RE);
  assert.ok(!payload.includes("\n"), "one compact JSON text");
});

test("the same fact always builds the same bytes, so a republished event is the same message", () => {
  const a = buildMessage(fact(), "app://culture-agents/thor");
  const b = buildMessage(fact(), "app://culture-agents/thor");
  assert.equal(a.payload, b.payload);
  assert.equal(a.topic, b.topic);
});

test("a fact the broker's reader would drop is refused before it is published", () => {
  assert.throws(() => buildMessage(fact({ time: "yesterday" }), "app://culture-agents/thor"), /time/);
  assert.throws(() => buildMessage(fact({ time: "2026-11-25T10:00:03+02:00" }), "app://culture-agents/thor"), /time/);
  assert.throws(() => buildMessage(fact({ run_id: "not a run id" }), "app://culture-agents/thor"), /run id/);
  assert.throws(() => buildMessage(fact(), "no-scheme"), /source/);
});
