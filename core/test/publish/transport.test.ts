/**
 * The MQTT transport against brokers that misbehave, with no container: a port nothing listens
 * on, a peer that accepts and never speaks, and a peer that accepts the connection and never
 * acknowledges a publish. In each case a publish is refused within its time limit and nothing
 * throws out of the client.
 */
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { test, type TestContext } from "node:test";

import { loadPublishConfig, BROKER_URL_ENV } from "../../src/publish/index.js";
import { connectBroker } from "../../src/publish/transport.js";
import { pollUntil } from "../../src/util/sequence.js";

function listen(t: TestContext, onSocket: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      onSocket(socket);
    });
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

const config = (port: number) => loadPublishConfig({ [BROKER_URL_ENV]: `mqtt://127.0.0.1:${port}` }) as NonNullable<ReturnType<typeof loadPublishConfig>>;

async function refusedWithin(publish: () => Promise<void>, ms: number): Promise<number> {
  const started = Date.now();
  await assert.rejects(publish, { name: "BrokerUnavailableError" });
  const took = Date.now() - started;
  assert.ok(took < ms, `refused after ${took} ms, limit ${ms} ms`);
  return took;
}

test("nothing listens on the port: connecting does not throw and a publish is refused at once", async (t) => {
  const { server, port } = await listen(t, () => undefined);
  await new Promise((resolve) => server.close(resolve)); // the port is now closed
  const transport = connectBroker(config(port), { reconnectMs: 50 });
  t.after(() => transport.close());
  for (let i = 0; i < 5; i++) {
    await refusedWithin(() => transport.publish("events/agents/run/queued", "{}"), 100);
    await new Promise((resolve) => setTimeout(resolve, 40)); // across several failed reconnects
  }
});

test("a peer that accepts and never speaks: a publish is refused at once, nothing is queued", async (t) => {
  let bytes = 0;
  const { port } = await listen(t, (socket) => socket.on("data", (d: Buffer) => (bytes += d.length)));
  const transport = connectBroker(config(port), { reconnectMs: 50 });
  t.after(() => transport.close());
  await pollUntil(() => bytes > 0, { everyMs: 10, timeoutMs: 5000 }); // the CONNECT arrived; no CONNACK follows
  const afterConnect = bytes;
  await refusedWithin(() => transport.publish("events/agents/run/queued", '{"marker":"never-sent"}'), 100);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(bytes, afterConnect, "the refused message was not sent later");
});

test("a broker that never acknowledges: the publish is refused at its time limit and is not resent by the client", async (t) => {
  const seen: Buffer[] = [];
  const { port } = await listen(t, (socket) => {
    let connected = false;
    socket.on("data", (data: Buffer) => {
      if (!connected) {
        connected = true;
        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00])); // CONNACK, accepted
        return;
      }
      seen.push(data); // PUBLISH (and later pings): never acknowledged
    });
  });
  const transport = connectBroker(config(port), { ackTimeoutMs: 200, reconnectMs: 50 });
  t.after(() => transport.close());
  await pollUntil(() => transport.publish("events/agents/run/queued", "probe").then(() => true, (e: Error) => /acknowledgement/.test(e.message)), { everyMs: 20, timeoutMs: 5000 });
  const before = seen.filter((d) => d.includes("payload-A")).length;
  const took = await refusedWithin(() => transport.publish("events/agents/run/queued", "payload-A"), 1000);
  assert.ok(took >= 150, "it waited for the acknowledgement first");
  assert.equal(seen.filter((d) => d.includes("payload-A")).length, before + 1, "sent once");
});

test("close resolves with the broker down", async (t) => {
  const { server, port } = await listen(t, () => undefined);
  await new Promise((resolve) => server.close(resolve));
  const transport = connectBroker(config(port), { reconnectMs: 50 });
  const started = Date.now();
  await transport.close();
  assert.ok(Date.now() - started < 2000);
});
