/** The gateway read is bounded in size and held to loopback from the first request. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readGateway, type GatewaySource } from "../../src/runs/gateway.js";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const source = (fetchFn: typeof fetch, url = "http://127.0.0.1:8001/v1", timeoutMs = 2000): GatewaySource => ({ harnesses: ["opencode"], url, fetch: fetchFn, timeoutMs });

test("an endless /status body is read up to a cap, then dropped: unknown", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(16 * 1024).fill(32);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk.length;
      if (pulled > 64 * 1024 * 1024) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const s = await readGateway(source(async () => new Response(stream)), NOW);
  assert.equal(s.state, "unknown");
  assert.ok(pulled <= 1024 * 1024, `read ${pulled} bytes`);
});

test("a content-length past the cap is refused without reading the body", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(10)); } });
  const s = await readGateway(source(async () => new Response(stream, { headers: { "content-length": "1000000" } })), NOW);
  assert.equal(s.state, "unknown");
  assert.ok(pulled <= 2, `pulled ${pulled} chunks`);
});

test("a gateway URL whose host is not loopback is not asked: unknown, not on this host", async () => {
  let calls = 0;
  const s = await readGateway(source(async () => { calls++; return new Response("{}"); }, "http://gateway.example.test:8001/v1"), NOW);
  assert.equal(calls, 0);
  assert.equal(s.state, "unknown");
  assert.match(s.reason ?? "", /not on this host/);
});
