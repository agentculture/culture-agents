/**
 * Waits and buffers the harness layer cannot let a sandbox control: calls to the OpenCode server
 * and the Claude Code bridge are bounded and stop at an abort, and output read from the sandbox
 * is capped per line and per event.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ClaudeCodeBackend, SESSION_CLOSE_TIMEOUT_MS, type AgentLike } from "../../src/harness/claude-code/backend.js";
import { DESTROY_DEADLINE_MS, SandboxWorkspace, type SandboxSettings } from "../../src/harness/common/sandbox-workspace.js";
import type { TurnEvent, Workspace } from "../../src/harness/common/types.js";
import { OpenCodeBackend, type SandboxBacked } from "../../src/harness/opencode/backend.js";
import { MAX_STREAM_UNIT, OpenCodeClient, parseSse, type FetchLike } from "../../src/harness/opencode/client.js";
import { TAIL_LINE_CHARS, waitForLine } from "../../src/harness/opencode/lines.js";
import { OPENCODE_CALL_TIMEOUT_MS, startOpenCodeTurn } from "../../src/harness/opencode/turn.js";
import type { PreparedTree, RunProcess, RunSandbox, RunSandboxes } from "../../src/sandbox/index.js";
import { FakeOpenCode } from "./fake-opencode.js";

const never = <T>() => new Promise<T>(() => undefined);
const hang = (): Promise<void> => new Promise(() => undefined);
const diagnostics = (events: TurnEvent[]) => events.flatMap((e) => (e.type === "output" && e.data.channel === "diagnostic" ? [e.data.text] : []));

async function server(t: TestContext) {
  const fake = new FakeOpenCode();
  const base = await fake.listen();
  t.after(() => fake.close());
  return { fake, base, client: new OpenCodeClient(base, fake.password) };
}

test("the named bounds", () => {
  assert.equal(OPENCODE_CALL_TIMEOUT_MS, 30_000);
  assert.equal(SESSION_CLOSE_TIMEOUT_MS, 15_000);
  assert.equal(DESTROY_DEADLINE_MS, 90_000);
  assert.equal(MAX_STREAM_UNIT, 1 << 20);
});

for (const route of ["session", "prompt"] as const) {
  test(`an OpenCode server that never answers the ${route} call fails the turn start within the bound`, async (t) => {
    const { fake, client } = await server(t);
    fake.stalled.add(route);
    const began = Date.now();
    await assert.rejects(startOpenCodeTurn(client, fake.sessionId, "do it", new AbortController().signal, () => undefined, { connectMs: 2000, callMs: 150 }), /did not finish within/);
    assert.ok(Date.now() - began < 2000);
    await delay(50);
    assert.equal(fake.connections, 0, "the event stream of the turn that never started is closed");
  });
}

test("a stalled prompt is released at once when the backend closes", async (t) => {
  const { fake, client } = await server(t);
  fake.stalled.add("prompt");
  const closer = new AbortController();
  const starting = startOpenCodeTurn(client, fake.sessionId, "do it", closer.signal, () => undefined, { connectMs: 2000, callMs: 20_000 });
  const began = Date.now();
  setTimeout(() => closer.abort(new Error("closed")), 100);
  await assert.rejects(starting);
  assert.ok(Date.now() - began < 2000, "released by the stop signal, not by the 20 s bound");
});

test("a steer the server never answers is released within the bound", async (t) => {
  const { fake, client } = await server(t);
  const turn = await startOpenCodeTurn(client, fake.sessionId, "do it", new AbortController().signal, () => undefined, { connectMs: 2000, callMs: 150, pollMs: 20 });
  fake.stalled.add("prompt");
  await assert.rejects(turn.steer("go left"), /did not finish within/);
  fake.finish("succeeded");
  assert.equal((await turn.outcome).kind, "completed");
});

test("a server that stops answering mid-turn fails the turn instead of holding it open", async (t) => {
  const { fake, client } = await server(t);
  const timing = { connectMs: 2000, callMs: 100, pollMs: 10, waitMs: 100, maxFailures: 3 };
  const turn = await startOpenCodeTurn(client, fake.sessionId, "do it", new AbortController().signal, () => undefined, timing);
  fake.stalled.add("session");
  const began = Date.now();
  const outcome = await turn.outcome;
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.error.message : "", /stopped answering.*did not finish within/);
  assert.ok(Date.now() - began < 5000);
});

test("an interrupt the server never answers is released within the bound", async (t) => {
  const { fake, client } = await server(t);
  const turn = await startOpenCodeTurn(client, fake.sessionId, "do it", new AbortController().signal, () => undefined, { connectMs: 2000, callMs: 150, pollMs: 20 });
  fake.stalled.add("interrupt");
  await assert.rejects(turn.interrupt(), /did not finish within/);
  fake.stalled.delete("interrupt");
  fake.finish("succeeded");
  assert.equal((await turn.outcome).kind, "completed");
});

function scriptedProcess(stdout: ReadableStream<Uint8Array>): RunProcess & { cancelled: number } {
  const proc = {
    cancelled: 0,
    stdout,
    stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    write: () => undefined,
    closeInput: () => undefined,
    wait: () => never<{ exitCode: number }>(),
    cancel: async () => {
      proc.cancelled += 1;
    },
  };
  return proc;
}

function openCodeWorkspace(proc: RunProcess, port: number, seen: { spawnSignal?: AbortSignal | undefined }): SandboxBacked {
  return {
    workdir: "/sandbox/work",
    sandbox: {
      home: "/sandbox",
      writeFile: async () => undefined,
      spawn: async (_command: string, options?: { signal?: AbortSignal }) => {
        seen.spawnSignal = options?.signal;
        return proc;
      },
      endpoint: async () => ({ host: "127.0.0.1", port }),
    },
  } as unknown as SandboxBacked;
}

const settings = { model: "gateway/worker", baseUrl: "http://gw/v1", keyEnv: "LOBES_GATEWAY_KEY", port: 4096 };

test("the wait for the OpenCode server to listen stops at an abort, and the server process is given the signal", async () => {
  const proc = scriptedProcess(new ReadableStream<Uint8Array>({ start: () => undefined })); // never prints, never ends
  const seen: { spawnSignal?: AbortSignal | undefined } = {};
  const ctl = new AbortController();
  const backend = new OpenCodeBackend({ ...settings, startTimeoutMs: 20_000 });
  const opening = backend.open(openCodeWorkspace(proc, 1, seen), ctl.signal, () => undefined);
  const began = Date.now();
  setTimeout(() => ctl.abort(new Error("cancelled")), 100);
  await assert.rejects(opening, /could not start OpenCode: cancelled/);
  assert.ok(Date.now() - began < 2000, "released by the abort, not by the 20 s start timeout");
  assert.equal(seen.spawnSignal, ctl.signal, "spawn gets the signal");
  assert.equal(proc.cancelled, 1);
});

test("creating the OpenCode session is bounded", async (t) => {
  const { fake, base } = await server(t);
  fake.stalled.add("create");
  const listening = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode("opencode server listening on http://127.0.0.1:4096\n")) });
  const proc = scriptedProcess(listening);
  // The backend makes its own per-run password; the fake server checks for a fixed one.
  const auth = `Basic ${Buffer.from(`opencode:${fake.password}`).toString("base64")}`;
  const withAuth: FetchLike = (url, init) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: auth } });
  const backend = new OpenCodeBackend(settings, withAuth, { callMs: 150 });
  const began = Date.now();
  await assert.rejects(backend.open(openCodeWorkspace(proc, Number(new URL(base).port), {}), new AbortController().signal, () => undefined), /creating the OpenCode session did not finish within/);
  assert.ok(Date.now() - began < 2000);
  assert.equal(proc.cancelled, 1, "the server is stopped when the start fails");
});

test("closing a Claude Code session that never finishes is bounded and reported", async () => {
  const agent: AgentLike = {
    createSession: async () => ({ experimental_steerTurn: async () => undefined, destroy: () => hang() }),
    stream: async () => ({ fullStream: (async function* () {})() }),
  };
  const sunk: TurnEvent[] = [];
  const backend = new ClaudeCodeBackend("r1", "haiku", () => agent, undefined, 100);
  const session = await backend.open({ workdir: "/sandbox/work" } as Workspace, new AbortController().signal, (e) => sunk.push(e));
  const began = Date.now();
  await session.close();
  await session.close();
  const took = Date.now() - began;
  assert.ok(took >= 90 && took < 2000, `close returned at the bound (took ${took} ms)`);
  assert.deepEqual(diagnostics(sunk).filter((d) => /closing the Claude Code session did not finish/.test(d)).length, 1, "said once");
});

test("the whole sandbox deletion, fallback included, is one deadline", async () => {
  let fallbacks = 0;
  const sandbox = { name: "t-abc", home: "/sandbox", destroy: () => hang() } as unknown as RunSandbox;
  const sandboxes = { destroy: async () => void (fallbacks += 1) } as unknown as RunSandboxes;
  const s: SandboxSettings = { gateway: { endpoint: "https://x", tlsDir: "/tls", name: null }, openshellBin: "openshell", image: "i", providers: [], sandboxPrefix: "t-", ref: "HEAD", identity: { name: "n", email: "e@x" } };
  const deps = { openRunSandboxes: never, prepare: never, collect: never, destroyDeadlineMs: 120 };
  const ws = new SandboxWorkspace(sandboxes, sandbox, { branch: "runs/r", baseCommit: "a".repeat(40), path: "/sandbox/work" } as PreparedTree, "r", "/host", s, deps);
  const began = Date.now();
  await assert.rejects(ws.destroy(), /deleting sandbox t-abc did not finish within/);
  assert.ok(Date.now() - began < 2000);
  assert.equal(fallbacks, 0, "no second round starts after the deadline");
  await assert.rejects(ws.destroy(), /did not finish/, "the result is kept; destroy is not run again");
});

const encode = (text: string) => new TextEncoder().encode(text);
function chunks(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(encode(p));
      c.close();
    },
  });
}

test("a line without an end is dropped at the cap, reported once, and reading goes on; kept lines are clipped", async () => {
  const tail: string[] = [];
  let overlong = 0;
  const big = "x".repeat(600);
  // cap 1000: the first line grows past it across chunks, then ends; the next lines are read normally.
  const found = await waitForLine(chunks(["start\n", big, big, big, "tail-of-the-long-line\nserver listening on :1\n", "y".repeat(TAIL_LINE_CHARS + 50), "\n"]), /server listening on /, tail, { maxLineChars: 1000, onOverlong: () => (overlong += 1) });
  assert.equal(found, true, "the line after the dropped one is still matched");
  await delay(10);
  assert.equal(overlong, 1);
  assert.deepEqual(tail.slice(0, 2), ["start", "server listening on :1"]);
  assert.equal(tail[2]?.length, TAIL_LINE_CHARS, "a kept line is clipped");
  assert.ok(!tail.some((l) => l.includes("tail-of-the-long-line")), "the rest of the dropped line is not taken for a line of its own");
});

test("parseSse drops an event block over the cap, reports it once, and keeps parsing", async () => {
  const ok = (n: number) => `data: ${JSON.stringify({ type: `e${n}` })}\n\n`;
  const half = "z".repeat(700);
  let dropped = 0;
  const seen: string[] = [];
  // The oversized block arrives in pieces with no blank line; its end and the next event share a chunk, with the separator split.
  const body = chunks([ok(1), `data: {"type":"big","pad":"${half}`, half, half, `"}\n`, `\n${ok(2)}`, ok(3)]);
  for await (const event of parseSse(body, undefined, () => (dropped += 1), 1000)) seen.push(event.type);
  assert.deepEqual(seen, ["e1", "e2", "e3"]);
  assert.equal(dropped, 1);
  // A whole block over the cap that arrives in one piece is dropped too.
  dropped = 0;
  const whole = chunks([`data: {"type":"big","pad":"${"z".repeat(3000)}"}\n\n${ok(4)}`]);
  const after: string[] = [];
  for await (const event of parseSse(whole, undefined, () => (dropped += 1), 1000)) after.push(event.type);
  assert.deepEqual(after, ["e4"]);
  assert.equal(dropped, 1);
});
