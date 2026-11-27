// The operator's command: a new key, and the public trust entry with its fingerprint.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fingerprint, parseFleetKey } from "../../src/fleet/cert.js";
import { run } from "../../src/fleet/command.js";
import { parseTrust } from "../../src/fleet/trust.js";

function capture(argv: string[], env: Record<string, string | undefined> = {}): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = run(argv, env, (t) => (out += t), (t) => (err += t));
  return { code, out, err };
}

test("keygen prints one key line, and cert prints a trust entry other members accept with the key's fingerprint", () => {
  const gen = capture(["keygen"]);
  assert.equal(gen.code, 0);
  const keyText = gen.out.trim();
  const shown = capture(["cert", "--node", "thor"], { CULTURE_AGENTS_FLEET_KEY: keyText });
  assert.equal(shown.code, 0, shown.err);
  const printed = JSON.parse(shown.out) as { entry: { node: string; cert: string }; fingerprint: string };
  assert.ok(!shown.out.includes(keyText.slice(8)), "cert prints no private key");
  const [accepted] = parseTrust(JSON.stringify([printed.entry]), "trust.json");
  assert.equal(accepted?.node, "thor");
  assert.equal(printed.fingerprint, `sha256:${fingerprint(parseFleetKey(keyText))}`);
  assert.equal(accepted?.fingerprint, fingerprint(parseFleetKey(keyText)));
});

test("cert without a key, with a bad key or with bad arguments exits 2 and never echoes the key", () => {
  assert.equal(capture(["cert", "--node", "thor"]).code, 2);
  const bad = capture(["cert", "--node", "thor"], { CULTURE_AGENTS_FLEET_KEY: "ed25519:c2VjcmV0LXZhbHVl" });
  assert.equal(bad.code, 2);
  assert.ok(!bad.err.includes("c2VjcmV0LXZhbHVl"));
  assert.equal(capture(["cert", "--node"]).code, 2);
  assert.equal(capture(["unknown"]).code, 2);
});
