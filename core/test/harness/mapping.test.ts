/**
 * Event mapping for both real harnesses, from samples recorded in live runs (scrubbed:
 * test/harness/fixtures/), plus the Claude Code backend's steer, interrupt and close sequencing
 * with a fake agent replaying a recorded stream.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ClaudeCodeBackend, type AgentLike, type AgentSessionLike } from "../../src/harness/claude-code/backend.js";
import { ClaudePartMapper, COMPLETED_FINISH_REASONS, type StreamPart } from "../../src/harness/claude-code/map.js";
import type { TurnEvent, Workspace } from "../../src/harness/common/types.js";
import type { V2Event } from "../../src/harness/opencode/client.js";
import { OpenCodeEventMapper } from "../../src/harness/opencode/map.js";

const FIXTURES = new URL("../../../test/harness/fixtures/", import.meta.url);
const load = <T>(name: string): T[] =>
  readFileSync(new URL(name, FIXTURES), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { raw: T }).raw);

const data = (events: TurnEvent[]) => events.flatMap((e) => (e.type === "output" ? [e.data] : []));
const channel = (events: TurnEvent[], c: string) => data(events).filter((d) => d.channel === c);

test("claude-code steer sample: writes, results, reasoning and text map; outcome completed with the final text", () => {
  const parts = load<StreamPart>("claude-code-steer.ndjson");
  const mapper = new ClaudePartMapper();
  const events = parts.flatMap((p) => mapper.map(p));
  const calls = channel(events, "tool_call");
  assert.deepEqual(calls.map((d) => d.tool), ["write", "write", "write", "write"]);
  assert.deepEqual(calls.map((d) => (JSON.parse(d.text) as { file_path: string }).file_path), ["file01.txt", "file02.txt", "file03.txt", "STEERED.txt"]);
  assert.equal(channel(events, "tool_result").length, 4);
  assert.ok(channel(events, "reasoning").length > 0);
  const text = channel(events, "text").map((d) => d.text).join("");
  const expected = parts.filter((p) => p.type === "text-delta").map((p) => p.text).join("");
  assert.equal(text, expected, "text deltas pass through unchanged");
  assert.deepEqual(mapper.outcome(), { kind: "completed", summary: expected });
});

test("claude-code cancel sample: the tool error maps to an error result; the abort makes the outcome interrupted", () => {
  const mapper = new ClaudePartMapper();
  const events = load<StreamPart>("claude-code-cancel.ndjson").flatMap((p) => mapper.map(p));
  const results = channel(events, "tool_result");
  assert.ok(results.some((d) => d.text.startsWith("error:") && (d.extension as { error?: boolean } | undefined)?.error === true));
  assert.deepEqual(mapper.outcome(), { kind: "interrupted" });
});

test("claude-code mapper: an error part without finish fails the turn; finish without text completes", () => {
  const failing = new ClaudePartMapper();
  const events = failing.map({ type: "error", error: new Error("overloaded") });
  assert.equal(events[0]?.type, "error");
  const outcome = failing.outcome();
  assert.equal(outcome.kind, "failed");
  const quiet = new ClaudePartMapper();
  quiet.map({ type: "finish", finishReason: "stop" });
  assert.deepEqual(quiet.outcome(), { kind: "completed" });
});

test("claude-code mapper: only a normal finish completes; a truncated or filtered turn fails naming the reason", () => {
  for (const reason of ["length", "content-filter", "tool-calls", "interrupted", "other", "unknown", "error"]) {
    const mapper = new ClaudePartMapper();
    mapper.map({ type: "text-delta", text: "partial answ" });
    mapper.map({ type: "finish", finishReason: reason });
    const outcome = mapper.outcome();
    assert.equal(outcome.kind, "failed", `${reason} must not complete`);
    if (outcome.kind === "failed") assert.match(outcome.error.message, new RegExp(`finish reason ${reason}\\b`));
  }
  const cut = new ClaudePartMapper();
  cut.map({ type: "finish", finishReason: "length" });
  const outcome = cut.outcome();
  assert.ok(outcome.kind === "failed" && /output limit/.test(outcome.error.message), "the message says what length means");
  // The harness layer's own shape ({ unified, raw }) is read the same way as the flattened string.
  const shaped = new ClaudePartMapper();
  shaped.map({ type: "finish", finishReason: { unified: "stop", raw: "stop" } });
  assert.deepEqual(shaped.outcome(), { kind: "completed" });
  const shapedCut = new ClaudePartMapper();
  shapedCut.map({ type: "finish", finishReason: { unified: "content-filter", raw: "refusal" } });
  assert.equal(shapedCut.outcome().kind, "failed");
  assert.deepEqual([...COMPLETED_FINISH_REASONS], ["stop"]);
});

test("opencode v2 steer sample: shell and write calls with names, results, deliveries, final text", () => {
  const events = load<V2Event>("opencode-v2-steer.ndjson");
  const sessionId = String(events.find((e) => e.data?.["sessionID"])?.data?.["sessionID"]);
  const mapper = new OpenCodeEventMapper(sessionId);
  const out = events.flatMap((e) => mapper.map(e));
  const calls = channel(out, "tool_call");
  assert.deepEqual(calls.map((d) => d.tool), ["shell", "shell", "write"]);
  assert.match(calls[0]?.text ?? "", /file1\.txt/);
  assert.match(calls[2]?.text ?? "", /STEERED\.txt/);
  assert.equal(channel(out, "tool_result").length, 3);
  assert.equal(channel(out, "diagnostic").filter((d) => d.text === "input delivered to the harness").length, 2, "the prompt and the steer");
  assert.ok(channel(out, "reasoning").length > 0);
  const lastEnded = events.filter((e) => e.type === "session.text.ended").pop();
  assert.equal(mapper.summary, lastEnded?.data?.["text"]);
});

test("opencode v2 cancel sample: the interrupted tool and step map to an error result and an error", () => {
  const events = load<V2Event>("opencode-v2-cancel.ndjson");
  const sessionId = String(events.find((e) => e.data?.["sessionID"])?.data?.["sessionID"]);
  const mapper = new OpenCodeEventMapper(sessionId);
  const out = events.flatMap((e) => mapper.map(e));
  assert.ok(channel(out, "tool_result").some((d) => d.text.startsWith("error:") && d.tool === "shell"));
  assert.ok(out.some((e) => e.type === "error" && /step failed/.test(e.error.message)));
  assert.equal(new OpenCodeEventMapper("ses_someone_else").map(events[0] as V2Event).length, 0);
});

/** A fake agent replaying recorded parts; abort ends the stream with an `abort` part. */
function fakeAgent(parts: StreamPart[], gate?: Promise<void>) {
  const calls: string[] = [];
  const session: AgentSessionLike = {
    experimental_steerTurn: async (text) => void calls.push(`steer:${text}`),
    destroy: async () => void calls.push("destroy"),
  };
  const agent: AgentLike = {
    createSession: async ({ sessionId }) => {
      calls.push(`session:${sessionId}`);
      return session;
    },
    stream: async ({ abortSignal }) => ({
      fullStream: (async function* () {
        for (const [i, part] of parts.entries()) {
          if (i === 3 && gate) await Promise.race([gate, new Promise((r) => abortSignal.addEventListener("abort", r))]);
          if (abortSignal.aborted) {
            yield { type: "abort" };
            return;
          }
          yield part;
        }
      })(),
    }),
  };
  return { agent, calls };
}

const workspace = { workdir: "/sandbox/work" } as Workspace;

test("claude-code backend: steer goes to experimental_steerTurn, close destroys the session once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { agent, calls } = fakeAgent(load<StreamPart>("claude-code-steer.ndjson"), gate);
  const backend = new ClaudeCodeBackend("spark-a.run.01ABC", "haiku", () => agent);
  const session = await backend.open(workspace, new AbortController().signal, () => undefined);
  const turn = await session.startTurn("task");
  await turn.steer("change of plan");
  release();
  for await (const _ of turn.events) void _;
  assert.equal((await turn.outcome).kind, "completed");
  await session.close();
  await session.close();
  assert.deepEqual(calls, ["session:spark-a-run-01ABC", "steer:change of plan", "destroy"]);
});

test("claude-code backend: interrupt aborts the stream and the outcome is interrupted", async () => {
  const { agent } = fakeAgent(load<StreamPart>("claude-code-steer.ndjson"), new Promise(() => undefined));
  const backend = new ClaudeCodeBackend("r1", "haiku", () => agent);
  const session = await backend.open(workspace, new AbortController().signal, () => undefined);
  const turn = await session.startTurn("task");
  await turn.interrupt();
  for await (const _ of turn.events) void _;
  assert.deepEqual(await turn.outcome, { kind: "interrupted" });
});
