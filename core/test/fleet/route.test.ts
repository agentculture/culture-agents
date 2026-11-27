// t22 acceptance 3, core side: the member list on the control socket (`fleet.members`, added in 3.1).
// With the transport off it is empty and says so; with it on, it is the member list's own view.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { validate, type MemberList } from "../../src/contract/index.js";
import { startDaemon } from "../../src/daemon/daemon.js";
import { fingerprint, newFleetKey } from "../../src/fleet/cert.js";
import { createMemberList } from "../../src/fleet/members.js";
import { FakeRunService } from "../daemon/fake-service.js";
import { call, makeEnv, type Env } from "../daemon/harness.js";

// A fresh socket path per test, as the other daemon tests do: Node's default agent keeps
// connections alive, and a request on a reused path can land on the stopped daemon's socket.
let env: Env;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

test("with the fleet transport off the control socket reports an empty member list, transport off", async () => {
  const daemon = await startDaemon({ service: new FakeRunService(), node: "thor", env: env.vars });
  try {
    const reply = await call(env.socket, "GET", "/v1/fleet/members");
    assert.equal(reply.status, 200, reply.text);
    assert.ok(validate("fleet", reply.json).ok, reply.text);
    const list = reply.json as MemberList;
    assert.deepEqual([list.node, list.transport, list.members, list.refused], ["thor", "off", [], []]);
    const refused = await call(env.socket, "GET", "/v1/fleet/members", { version: "2.0" });
    assert.equal(refused.status, 412, "the version header is checked first, as on every route");
    assert.equal((await call(env.socket, "POST", "/v1/fleet/members", { body: {} })).status, 400);
    assert.equal((await call(env.socket, "POST", "/v1/fleet/announce", { body: {} })).status, 404, "announcing is never served on the control socket");
  } finally {
    await daemon.stop();
  }
});

test("with the fleet transport on the control socket reports what the member list heard", async () => {
  let now = 0;
  const members = createMemberList({ node: "thor", fingerprint: fingerprint(newFleetKey()), now: () => now, log: () => undefined });
  const peer = newFleetKey();
  const daemon = await startDaemon({ service: new FakeRunService(), node: "thor", env: env.vars, members: () => members.view() });
  try {
    // A second core started with thor's name and another key: refused, and the refusal is in the list.
    members.receive({ node: "thor", cert: "", pem: "", fingerprint: fingerprint(peer) }, { node: "thor", api_version: "3.1", seq: 0, state: "up" });
    now += 250;
    const reply = await call(env.socket, "GET", "/v1/fleet/members");
    assert.ok(validate("fleet", reply.json).ok, reply.text);
    const list = reply.json as MemberList;
    assert.equal(list.transport, "on");
    assert.deepEqual(list.members, []);
    assert.equal(list.refused[0]?.fingerprint, fingerprint(peer));
    assert.equal(list.refused[0]?.heard_ms_ago, 250);
  } finally {
    await daemon.stop();
  }
});
