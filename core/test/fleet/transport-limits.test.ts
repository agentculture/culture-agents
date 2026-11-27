// One address cannot take every connection slot of a member, and refused or failed handshakes are
// logged at most once per address in a window, so a host that can reach the port cannot flood the log.
import assert from "node:assert/strict";
import { connect as netConnect, type Socket } from "node:net";
import { after, test } from "node:test";

import { newFleetKey } from "../../src/fleet/cert.js";
import { LOOPBACK, servingCore, tmp } from "./support.js";

const t = tmp();
after(() => t.cleanup());

/** Open a raw TCP connection; resolves once connected, with a promise of its close. */
function open(port: number): Promise<{ socket: Socket; closed: Promise<void> }> {
  return new Promise((resolve) => {
    const socket = netConnect(port, LOOPBACK);
    const closed = new Promise<void>((done) => socket.on("close", () => done()));
    socket.on("error", () => undefined);
    socket.on("connect", () => resolve({ socket, closed }));
  });
}

const within = (p: Promise<void>, ms: number): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

test("past the per-address limit a connection is closed at once; the held ones stay open", async () => {
  const serving = await servingCore(t, [newFleetKey()], { handshakeTimeoutMs: 600_000, maxPerAddress: 2 });
  try {
    const first = await open(serving.port);
    const second = await open(serving.port);
    const third = await open(serving.port);
    assert.equal(await within(third.closed, 2000), true, "the third connection from the address was closed");
    assert.equal(await within(first.closed, 200), false, "the first stays open");
    first.socket.destroy();
    await first.closed;
    await new Promise((r) => setTimeout(r, 50));
    const again = await open(serving.port);
    assert.equal(await within(again.closed, 300), false, "a slot freed by a close is usable again");
    again.socket.destroy();
    second.socket.destroy();
  } finally {
    await serving.server.stop();
  }
});

test("failed handshakes from one address are logged once in the window", async () => {
  const serving = await servingCore(t, [newFleetKey()], { logEveryMs: 60_000 });
  try {
    const failOnce = async (): Promise<void> => {
      const c = await open(serving.port);
      c.socket.end("not a TLS hello\r\n");
      await c.closed;
    };
    await Promise.all(Array.from({ length: 5 }, failOnce));
    const lines = serving.logs.filter((l) => /handshake/.test(l));
    assert.equal(lines.length, 1, lines.join("\n"));
  } finally {
    await serving.server.stop();
  }
});
