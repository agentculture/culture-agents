import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";

import { TRACE_CONTENT_ENV, TRACE_ENDPOINT_ENV, TRACE_PUBLIC_KEY_ENV, TRACE_SECRET_KEY_ENV, TraceConfigError, createTraceFollower, loadTraceConfig, workerEnv } from "../../src/trace/index.js";
import { identityOf, writeWorkerIdentity } from "../../src/store/liveness.js";
import { readLog } from "../../src/store/event-log.js";
import { EventLogWriter, type EventInput } from "../../src/store/event-log.js";
import { MARKERS, contentRun, seedRun } from "../publish/support.js";
import { stateDir } from "../worker/helpers.js";

interface Received {
  url: string;
  auth: string | undefined;
  body: string;
}
interface Attr {
  key: string;
  value: { stringValue?: string; intValue?: string };
}
interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
}

async function receiver(t: TestContext): Promise<{ url: string; got: Received[]; spans: () => WireSpan[] }> {
  const got: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push({ url: req.url ?? "", auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const spans = (): WireSpan[] => got.flatMap((r) => (JSON.parse(r.body) as { resourceSpans: { scopeSpans: { spans: WireSpan[] }[] }[] }).resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((s) => s.spans)));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/public/otel/v1/traces`, got, spans };
}

const attr = (s: WireSpan, key: string): string | undefined => {
  const v = s.attributes.find((a) => a.key === key)?.value;
  return v?.stringValue ?? v?.intValue;
};

function follower(dir: string, url: string, content = false, warns: string[] = []): ReturnType<typeof createTraceFollower> {
  return createTraceFollower({
    stateDir: dir,
    node: "thor",
    url,
    authorization: "Basic dGVzdA==",
    content,
    modelOf: (h) => (h === "claude-code" ? "haiku" : "gateway/worker"),
    warn: (l) => warns.push(l),
  });
}

/** A whole run: queued, running, a tool call and result, a question and its answer, terminal. */
function fullRun(t: TestContext, dir?: string): ReturnType<typeof seedRun> {
  const seeded = contentRun(t, dir);
  return seeded;
}

test("a run exports one trace with a span for each step, each with run id, harness, model and duration", async (t) => {
  const rx = await receiver(t);
  const { stateDir: dir, run } = fullRun(t);
  await follower(dir, rx.url).pass();
  const spans = rx.spans();
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
  const names = spans.map((s) => s.name);
  for (const name of ["agents.run", "run.submit", "sandbox.setup", "harness.turn", "tool.call", "operator.question", "result.collection", "run.terminal"]) {
    assert.ok(names.includes(name), `missing span ${name}: ${names.join(",")}`);
  }
  const root = spans.find((s) => s.name === "agents.run");
  for (const s of spans) {
    assert.equal(attr(s, "culture.run_id"), run.id);
    assert.equal(attr(s, "culture.harness"), run.harness);
    assert.equal(attr(s, "culture.model"), run.harness === "claude-code" ? "haiku" : "gateway/worker");
    assert.ok(attr(s, "culture.duration_ms") !== undefined);
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano));
    if (s !== root) assert.equal(s.parentSpanId, root?.spanId);
  }
  assert.equal(attr(spans.find((s) => s.name === "run.terminal") as WireSpan, "culture.state"), "failed");
  assert.equal(rx.got[0]?.auth, "Basic dGVzdA==");
  assert.match(rx.got[0]?.url ?? "", /\/v1\/traces$/);
});

test("by default no span carries prompt, output, tool or question content; the setting turns it on", async (t) => {
  const off = await receiver(t);
  const { stateDir: dir } = fullRun(t);
  await follower(dir, off.url).pass();
  const all = off.got.map((r) => r.body).join("\n");
  for (const marker of Object.values(MARKERS)) assert.ok(!all.includes(marker), `content leaked: ${marker}`);
  const on = await receiver(t);
  await follower(fullRun(t).stateDir, on.url, true).pass();
  const text = on.got.map((r) => r.body).join("\n");
  assert.ok(text.includes(MARKERS.prompt));
  assert.ok(text.includes(MARKERS.toolCall));
  assert.ok(text.includes(MARKERS.question));
});

test("a receiver that is down changes nothing about the run, is warned once, and the spans arrive when it is back", async (t) => {
  const dir = stateDir(t);
  const { run } = fullRun(t, dir);
  const logBefore = readFileSync(`${dir}/runs/${run.id}/events.jsonl`, "utf8").length;
  const warns: string[] = [];
  const dead = follower(dir, "http://127.0.0.1:1/v1/traces", false, warns);
  const started = Date.now();
  assert.equal(await dead.pass(), 0);
  await dead.pass();
  assert.ok(Date.now() - started < 4000);
  assert.equal(warns.length, 1);
  assert.equal(readLog(`${dir}/runs/${run.id}`, run.id).tail.state, "failed");
  assert.equal(readFileSync(`${dir}/runs/${run.id}/events.jsonl`, "utf8").length, logBefore);
  const rx = await receiver(t);
  assert.ok((await follower(dir, rx.url).pass()) > 0);
  assert.ok(rx.spans().some((s) => s.name === "agents.run"));
});

test("a restarted core continues from the recorded position and sends no span twice", async (t) => {
  const rx = await receiver(t);
  const seeded = seedRun(t);
  const { stateDir: dir, run, dir: runDir } = seeded;
  seeded.writer.transition("running", null);
  seeded.writer.append({ kind: "run.output", data: { channel: "tool_call", text: "x", tool: "bash" } } as EventInput);
  seeded.writer.append({ kind: "run.output", data: { channel: "tool_result", text: "y", tool: "bash" } } as EventInput);
  await follower(dir, rx.url).pass();
  const first = rx.spans().map((s) => s.spanId);
  assert.ok(rx.spans().some((s) => s.name === "sandbox.setup"));
  assert.ok(!first.includes(rx.spans().find((s) => s.name === "agents.run")?.spanId ?? "none"));
  const w = EventLogWriter.open(runDir, run.id);
  w.transition("succeeded", null);
  w.close();
  await follower(dir, rx.url).pass(); // a new follower, as after a restart
  const all = rx.spans().map((s) => s.spanId);
  assert.equal(new Set(all).size, all.length);
  assert.ok(rx.spans().some((s) => s.name === "agents.run"));
});

test("3 active runs on 2 harnesses are exported split by harness and model, matching the store's active count", async (t) => {
  const rx = await receiver(t);
  const dir = stateDir(t);
  for (const harness of ["claude-code", "claude-code", "opencode"]) writeWorkerIdentity(seedRun(t, dir, { harness }).dir, identityOf(process.pid)); // this process stands for the worker, so the runs are alive
  await follower(dir, rx.url).pass();
  const gauges = rx.spans().filter((s) => s.name === "fleet.active_runs");
  const split = Object.fromEntries(gauges.map((s) => [`${attr(s, "culture.harness")}/${attr(s, "culture.model")}`, Number(attr(s, "culture.active_runs"))]));
  assert.deepEqual(split, { "claude-code/haiku": 2, "opencode/gateway/worker": 1 });
  const { listRunEntries, activeRuns } = await import("../../src/store/entries.js");
  assert.equal(activeRuns(listRunEntries(dir)).length, 3);
});

test("the keys are read once, removed from the environment, and absent from a worker's environment", () => {
  const env: Record<string, string | undefined> = { PATH: "/bin", [TRACE_ENDPOINT_ENV]: "http://127.0.0.1:3000/api/public/otel", [TRACE_PUBLIC_KEY_ENV]: "pk-lf-1", [TRACE_SECRET_KEY_ENV]: "sk-lf-2", [TRACE_CONTENT_ENV]: "1" };
  const config = loadTraceConfig(env);
  assert.equal(config?.url, "http://127.0.0.1:3000/api/public/otel/v1/traces");
  assert.equal(config?.content, true);
  assert.equal(config?.authorization, `Basic ${Buffer.from("pk-lf-1:sk-lf-2").toString("base64")}`);
  assert.deepEqual(env, { PATH: "/bin" });
  const inherited = workerEnv({ PATH: "/bin", [TRACE_SECRET_KEY_ENV]: "sk", [TRACE_PUBLIC_KEY_ENV]: "pk" });
  assert.deepEqual(inherited, { PATH: "/bin" });
  assert.equal(loadTraceConfig({ PATH: "/bin" }), null);
  assert.throws(() => loadTraceConfig({ [TRACE_ENDPOINT_ENV]: "http://127.0.0.1:3000/", [TRACE_PUBLIC_KEY_ENV]: "a" }), TraceConfigError);
});

test("the exporter adds no dependency and uses fetch", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
  assert.ok(!Object.keys(pkg.dependencies ?? {}).some((d) => /opentelemetry|langfuse/i.test(d)));
  assert.match(readFileSync(new URL("../../../src/trace/otlp.ts", import.meta.url), "utf8"), /await fetch\(/);
});

test("a trace endpoint that is not on this host is refused, and a redirect is never followed", async () => {
  for (const endpoint of ["http://203.0.113.7:3000/api/public/otel", "https://traces.example/api/public/otel", "http://127.0.0.1.example/otel", "http://[2001:db8::1]:3000/otel"]) {
    assert.throws(() => loadTraceConfig({ [TRACE_ENDPOINT_ENV]: endpoint }), /loopback/, endpoint);
  }
  for (const endpoint of ["http://127.0.0.1:3000/api/public/otel", "http://localhost:3000/api/public/otel", "http://[::1]:3000/api/public/otel", "http://127.9.8.7/otel"]) {
    assert.ok(loadTraceConfig({ [TRACE_ENDPOINT_ENV]: endpoint }) !== null, endpoint);
  }
  const otlp = readFileSync(new URL("../../../src/trace/otlp.ts", import.meta.url), "utf8");
  assert.match(otlp, /redirect: "error"/);
});
