// t22: the local, untracked address list a core announces to (peers.ts). IP addresses only, so no
// name can redirect a call; bounded; read again each round; an invalid one stops the core at start.
// Every address here is loopback.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { fleetKeyText, newFleetKey } from "../../src/fleet/cert.js";
import { FLEET_LISTEN_ENV, FleetConfigError, loadFleetConfig } from "../../src/fleet/config.js";
import { loadPeers, MAX_PEERS, parsePeers, peersSource, resolvePeersPath } from "../../src/fleet/peers.js";
import { resolveTrustPath } from "../../src/fleet/trust.js";
import { tmp, writeTrust } from "./support.js";

const t = tmp();
after(() => t.cleanup());

test("the address list sits beside the trust list in the user's config directory", () => {
  const env = { XDG_CONFIG_HOME: "/config" };
  assert.equal(resolvePeersPath(env), "/config/culture-agents/fleet/peers.json");
  assert.equal(join(resolveTrustPath(env), "..", "peers.json"), resolvePeersPath(env));
});

test("addresses are IP literals with a port; duplicates collapse", () => {
  assert.deepEqual(parsePeers(JSON.stringify(["127.0.0.1:7443", "[::1]:7443", "127.0.0.1:7443"]), "p"), [
    { host: "127.0.0.1", port: 7443 },
    { host: "::1", port: 7443 },
  ]);
  assert.deepEqual(parsePeers("[]", "p"), []);
});

test("a name, a missing or zero port, a non-string or a non-array is refused", () => {
  for (const bad of [["localhost:7443"], ["thor:7443"], ["127.0.0.1"], ["127.0.0.1:0"], ["127.0.0.1:70000"], [7443], { peers: [] }]) {
    assert.throws(() => parsePeers(JSON.stringify(bad), "p"), FleetConfigError, JSON.stringify(bad));
  }
  assert.throws(() => parsePeers("not json", "p"), FleetConfigError);
});

test("the list is bounded", () => {
  const many = Array.from({ length: MAX_PEERS + 1 }, (_, i) => `127.0.0.1:${1000 + i}`);
  assert.throws(() => parsePeers(JSON.stringify(many), "p"), /at most 64/);
});

test("a missing file announces to nobody", () => {
  assert.deepEqual(loadPeers(join(t.dir, "absent.json")), []);
});

test("the list is read again each round; an invalid one announces to nobody and is reported once per change", () => {
  const path = join(t.dir, "live-peers.json");
  const errors: string[] = [];
  const peers = peersSource(path, (m) => errors.push(m));
  assert.deepEqual(peers(), []);
  writeFileSync(path, JSON.stringify(["127.0.0.1:7443"]));
  assert.deepEqual(peers(), [{ host: "127.0.0.1", port: 7443 }]);
  writeFileSync(path, JSON.stringify(["localhost:7443"]));
  assert.deepEqual(peers(), []);
  assert.deepEqual(peers(), []);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /announcing to nobody/);
});

test("a configured transport with an invalid address list does not start", () => {
  const configHome = join(t.dir, "bad-peers");
  const trustPath = resolveTrustPath({ XDG_CONFIG_HOME: configHome });
  writeTrust(trustPath, [newFleetKey()]);
  mkdirSync(join(trustPath, ".."), { recursive: true });
  writeFileSync(join(trustPath, "..", "peers.json"), JSON.stringify(["localhost:7443"]));
  const env = { [FLEET_LISTEN_ENV]: "127.0.0.1:0", XDG_CONFIG_HOME: configHome };
  assert.throws(() => loadFleetConfig(env, fleetKeyText(newFleetKey())), /not a name/);
  writeFileSync(join(trustPath, "..", "peers.json"), JSON.stringify(["127.0.0.1:7443"]));
  assert.equal(loadFleetConfig(env, fleetKeyText(newFleetKey()))?.peersPath, join(trustPath, "..", "peers.json"));
});
