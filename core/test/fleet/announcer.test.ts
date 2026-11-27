// t22: the announcer's own rules, with an injected transport call (no sockets).
import assert from "node:assert/strict";
import { test } from "node:test";

import { certificateFor, fingerprint, newFleetKey } from "../../src/fleet/cert.js";
import { createAnnouncer } from "../../src/fleet/announce.js";
import { createMemberList } from "../../src/fleet/members.js";
import type { FleetCallOptions, FleetResponse } from "../../src/fleet/transport.js";
import { sleep } from "./support.js";

const key = newFleetKey();
const peerKey = newFleetKey();
const peerCert = certificateFor(peerKey);
const peer = { node: "xxxxxxxx", cert: peerCert.text, pem: peerCert.pem, fingerprint: fingerprint(peerKey) }; // filler name: two members never share thor
const reply = (body: unknown, status = 200): FleetResponse => ({ status, body: Buffer.from(JSON.stringify(body)), member: peer });

function announcer(call: (o: FleetCallOptions) => Promise<FleetResponse>) {
  const logs: string[] = [];
  const members = createMemberList({ node: "thor", fingerprint: fingerprint(key), log: (l) => logs.push(l) });
  const a = createAnnouncer({ key, trust: () => [], peers: () => [{ host: "127.0.0.1", port: 7443 }], members, log: (l) => logs.push(l), call });
  return { a, members, logs };
}

test("a clean stop lets the announcement in flight settle before it announces leaving", async () => {
  const order: string[] = [];
  const { a } = announcer(async (o) => {
    const state = (JSON.parse(o.body ?? "{}") as { state: string }).state;
    order.push(`${state} sent`);
    if (state === "up") await sleep(200);
    order.push(`${state} answered`);
    return reply({ node: "xxxxxxxx", api_version: "3.1", seq: 0, state: "up" });
  });
  const round = a.round();
  await sleep(20);
  await a.stop();
  await round;
  assert.deepEqual(order, ["up sent", "up answered", "leaving sent", "leaving answered"]);
});

test("each call has the transport's 5 s timeout at most, and reads at most 16 KiB of the reply", async () => {
  const seen: FleetCallOptions[] = [];
  const { a } = announcer(async (o) => {
    seen.push(o);
    return reply({ node: "xxxxxxxx", api_version: "3.1", seq: 0, state: "up" });
  });
  await a.round();
  await a.stop();
  assert.deepEqual([seen[0]?.timeoutMs, seen[0]?.maxResponseBytes, seen[0]?.path, seen[0]?.method], [5000, 16384, "/v1/fleet/announce", "POST"]);
  assert.equal(seen[1]?.timeoutMs, 1000, "the leaving of a clean stop waits at most 1 s");
});

test("the reply lists the peer it came from; a reply that is not an announcement lists nobody", async () => {
  let body: unknown = { node: "xxxxxxxx", api_version: "3.1", seq: 3, state: "up" };
  const { a, members, logs } = announcer(async () => reply(body));
  await a.round();
  assert.deepEqual(members.view().members.map((m) => [m.node, m.seq]), [["xxxxxxxx", 3]]);
  const fresh = announcer(async () => reply(body));
  body = { node: "xxxxxxxx", api_version: "3.1", seq: 3, state: "up", cert: "MCow" };
  await fresh.a.round();
  assert.deepEqual(fresh.members.view().members, []);
  assert.ok(fresh.logs.some((l) => l.includes("not an announcement")));
  assert.ok(logs.some((l) => l.includes("announced to 127.0.0.1:7443, which is member xxxxxxxx")));
});

test("outcomes are logged when they change, not on every round", async () => {
  const { a, logs } = announcer(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  await a.round();
  await a.round();
  await a.round();
  assert.equal(logs.filter((l) => l.includes("cannot announce to 127.0.0.1:7443")).length, 1);
});
