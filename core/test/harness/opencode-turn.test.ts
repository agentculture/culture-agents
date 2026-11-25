/**
 * The OpenCode v2 turn against a fake server: completion is decided by the wait and session
 * routes (a premature or missing stream event changes nothing), the stream is reconnected after
 * a drop, steer posts a `steer` delivery, interrupt ends the turn as interrupted.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { TurnEvent, TurnOutcome } from "../../src/harness/common/types.js";
import { OpenCodeApiError, OpenCodeClient, parseSse } from "../../src/harness/opencode/client.js";
import { startOpenCodeTurn } from "../../src/harness/opencode/turn.js";
import { FakeOpenCode } from "./fake-opencode.js";

const timing = { pollMs: 20, drainMs: 30, connectMs: 2000, maxFailures: 3 };

async function setup(t: TestContext) {
  const server = new FakeOpenCode();
  const base = await server.listen();
  const closer = new AbortController();
  t.after(async () => {
    closer.abort();
    await server.close();
  });
  const client = new OpenCodeClient(base, server.password);
  const sinkEvents: TurnEvent[] = [];
  const turn = await startOpenCodeTurn(client, server.sessionId, "do it", closer.signal, (e) => sinkEvents.push(e), timing);
  const events: TurnEvent[] = [];
  const pumped = (async () => {
    for await (const e of turn.events) events.push(e);
  })();
  return { server, client, turn, events, pumped, sinkEvents, closer };
}

const texts = (events: TurnEvent[], channel: string) =>
  events.flatMap((e) => (e.type === "output" && e.data.channel === channel ? [e.data.text] : []));

test("completion waits for the session authority, not for the stream's success event", async (t) => {
  const { server, turn, events, pumped } = await setup(t);
  assert.deepEqual(server.prompts, [{ text: "do it" }]);
  let settled: TurnOutcome | null = null;
  void turn.outcome.then((o) => (settled = o));
  server.emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "hel" });
  server.emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "lo" });
  server.emit("session.text.ended", { assistantMessageID: "m", ordinal: 0, text: "hello" });
  // The stream claims success while the server still reports the session busy.
  server.emit("session.execution.succeeded", {});
  await delay(150);
  assert.equal(settled, null, "a stream event alone does not end the turn");
  server.finish("succeeded");
  assert.deepEqual(await turn.outcome, { kind: "completed", summary: "hello" });
  await pumped;
  assert.deepEqual(texts(events, "text"), ["hel", "lo"]);
});

test("the turn ends on the authority even when the stream never reports the end", async (t) => {
  const { server, turn } = await setup(t);
  server.dropStreams();
  server.finish("succeeded");
  assert.equal((await turn.outcome).kind, "completed");
});

test("a dropped stream is reconnected and the gap is reported", async (t) => {
  const { server, turn, events, pumped } = await setup(t);
  await delay(50);
  server.dropStreams();
  for (let i = 0; i < 50 && server.connections === 0; i++) await delay(20);
  assert.equal(server.connections, 1, "the client reconnected");
  server.emit("session.reasoning.delta", { assistantMessageID: "m", ordinal: 0, delta: "thinking" });
  await delay(50);
  server.finish("succeeded");
  await turn.outcome;
  await pumped;
  assert.ok(texts(events, "diagnostic").some((t) => t.includes("event stream dropped")));
  assert.deepEqual(texts(events, "reasoning"), ["thinking"]);
});

test("steer posts a prompt with delivery steer to the running session", async (t) => {
  const { server, turn } = await setup(t);
  await turn.steer("go left");
  assert.deepEqual(server.prompts[1], { text: "go left", delivery: "steer" });
  server.finish("succeeded");
  await turn.outcome;
});

test("interrupt ends the turn as interrupted", async (t) => {
  const { server, turn } = await setup(t);
  await turn.interrupt();
  assert.equal(server.interrupts, 1);
  assert.deepEqual(await turn.outcome, { kind: "interrupted" });
});

test("a failed execution carries the streamed error", async (t) => {
  const { server, turn } = await setup(t);
  server.emit("session.execution.failed", { error: { type: "provider", message: "model not feasible" } });
  await delay(50);
  server.finish("failed");
  const outcome = await turn.outcome;
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.error.message : "", /provider: model not feasible/);
});

test("tool events map to tool_call and tool_result with the tool's name", async (t) => {
  const { server, turn, events, pumped } = await setup(t);
  server.emit("session.tool.input.started", { assistantMessageID: "m", id: "c1", name: "shell" });
  server.emit("session.tool.called", { assistantMessageID: "m", id: "c1", input: { command: "ls" }, executed: true });
  server.emit("session.tool.success", { assistantMessageID: "m", id: "c1", content: [{ type: "text", text: "README" }], executed: true });
  server.emit("session.text.delta", { sessionID: "ses_other", assistantMessageID: "m", ordinal: 0, delta: "not ours" });
  await delay(50);
  server.finish("succeeded");
  await turn.outcome;
  await pumped;
  const tools = events.flatMap((e) => (e.type === "output" && e.data.tool ? [[e.data.channel, e.data.tool, e.data.text]] : []));
  assert.deepEqual(tools, [
    ["tool_call", "shell", '{"command":"ls"}'],
    ["tool_result", "shell", "README"],
  ]);
  assert.deepEqual(texts(events, "text"), [], "events of other sessions are ignored");
});

test("closing the backend ends an unfinished turn as interrupted", async (t) => {
  const { turn, closer } = await setup(t);
  closer.abort();
  assert.deepEqual(await turn.outcome, { kind: "interrupted" });
});

test("the client sends basic auth and surfaces a refusal", async (t) => {
  const server = new FakeOpenCode();
  const base = await server.listen();
  t.after(() => server.close());
  const bad = new OpenCodeClient(base, "wrong");
  await assert.rejects(bad.createSession({ directory: "/w", providerID: "gateway", modelID: "worker" }), (err: unknown) => {
    assert.ok(err instanceof OpenCodeApiError);
    assert.equal(err.status, 401);
    return true;
  });
  const good = new OpenCodeClient(base, server.password);
  assert.equal((await good.createSession({ directory: "/w", providerID: "gateway", modelID: "worker" })).id, server.sessionId);
});

test("parseSse reports a block whose data is not JSON; it does not drop it silently", async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('data: {"type":"a"}\r'));
      c.enqueue(enc.encode('\n\r\ndata: {"type":"session.tex\r\ndata: t.updated"}\r\n\r\ndata: {"type":"b"}\n\n'));
      c.close();
    },
  });
  let dropped = 0;
  const seen: string[] = [];
  for await (const event of parseSse(body, undefined, () => (dropped += 1))) seen.push(event.type);
  assert.deepEqual(seen, ["a", "b"], "a line ending split across chunks is handled");
  assert.equal(dropped, 1, "the block split inside a JSON string is counted");
});
