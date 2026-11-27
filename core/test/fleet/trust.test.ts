// Acceptance 2 of t21: adding a member is adding its public key, removing the key revokes it on the
// next connection, and one member's key gives no access to another's private key.
import assert from "node:assert/strict";
import { createSecureContext } from "node:tls";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { certificateFor, fleetKeyText, newFleetKey } from "../../src/fleet/cert.js";
import { fleetCall } from "../../src/fleet/transport.js";
import { loadTrust, MAX_TRUST_FILE_BYTES, parseTrust, trustSource, TrustConfigError } from "../../src/fleet/trust.js";
import { entry, LOOPBACK, servingCore, tmp, trustOf, writeTrust } from "./support.js";

const t = tmp();
after(() => t.cleanup());

const version = { method: "GET", path: "/v1/version" } as const;

test("adding a key admits the member and removing it refuses the next connection, with no restart", async () => {
  const caller = newFleetKey(); // the calling core
  const serving = await servingCore(t, []); // the serving core starts trusting nobody
  const call = () => fleetCall({ key: caller, trust: trustOf(t, "caller-rev", [serving.key]), host: LOOPBACK, port: serving.port, ...version });
  try {
    await assert.rejects(call(), "refused before its key is added");
    writeTrust(serving.trustPath, [caller]);
    assert.equal((await call()).status, 200, "admitted on the next connection after its key is added");
    writeTrust(serving.trustPath, []);
    await assert.rejects(call(), "refused on the next connection after its key is removed");
    assert.equal(serving.requests.length, 1, "only the admitted call reached the application");
  } finally {
    await serving.server.stop();
  }
});

test("a trust list made invalid while running refuses every peer and says why", async () => {
  const caller = newFleetKey();
  const serving = await servingCore(t, [caller]);
  try {
    writeFileSync(serving.trustPath, "{ not json");
    await assert.rejects(fleetCall({ key: caller, trust: trustOf(t, "caller-bad", [serving.key]), host: LOOPBACK, port: serving.port, ...version }));
    assert.ok(serving.logs.some((l) => l.includes("trust list refused")), serving.logs.join("\n"));
    assert.equal(serving.requests.length, 0);
  } finally {
    await serving.server.stop();
  }
});

test("a trust list holds certificates only: no byte of any member's private key", () => {
  const a = newFleetKey();
  const b = newFleetKey();
  const path = join(t.dir, "public-only.json");
  writeTrust(path, [a]);
  writeTrust(join(t.dir, "other.json"), [b]);
  const text = readFileSync(path);
  for (const key of [a, b]) {
    const pkcs8 = key.export({ type: "pkcs8", format: "der" });
    assert.ok(!text.includes(pkcs8.subarray(pkcs8.length - 32)), "no seed");
    assert.ok(!text.includes(Buffer.from(fleetKeyText(key).slice(8))), "no key text");
  }
});

test("holding a member's certificate without its private key does not let a core present it", async () => {
  const member = newFleetKey();
  const other = newFleetKey(); // another member: it has the first member's certificate, as every trust list does
  assert.throws(() => createSecureContext({ key: other.export({ type: "pkcs8", format: "pem" }), cert: certificateFor(member).pem }), /key values mismatch/);
  const serving = await servingCore(t, [member]);
  try {
    await assert.rejects(fleetCall({ key: other, trust: trustOf(t, "other", [serving.key]), host: LOOPBACK, port: serving.port, ...version }));
    assert.equal(serving.requests.length, 0);
  } finally {
    await serving.server.stop();
  }
});

test("one node name given to two keys is refused", () => {
  const text = JSON.stringify([entry(newFleetKey()), entry(newFleetKey())]);
  assert.throws(() => parseTrust(text, "trust.json"), (e: unknown) => e instanceof TrustConfigError && e.message.includes("node name thor to two keys"));
});

test("a private key pasted where a certificate belongs is refused without echoing it", () => {
  const keyText = fleetKeyText(newFleetKey());
  assert.throws(
    () => parseTrust(JSON.stringify([{ node: "thor", cert: keyText }]), "trust.json"),
    (e: unknown) => e instanceof TrustConfigError && !e.message.includes(keyText.slice(8, 40)),
  );
  const pkcs8 = keyText.slice(8);
  assert.throws(() => parseTrust(JSON.stringify([{ node: "thor", cert: pkcs8 }]), "trust.json"), (e: unknown) => e instanceof TrustConfigError && !e.message.includes(pkcs8.slice(0, 32)));
});

test("malformed entries, unknown fields and oversized files are refused; a missing file trusts nobody", () => {
  const cert = certificateFor(newFleetKey()).text;
  const bad = [`{}`, `[{"node":"thor"}]`, `[{"node":"Thor!","cert":"${cert}"}]`, `[{"node":"thor","cert":"${cert}","key":"x"}]`, `[1]`];
  for (const text of bad) assert.throws(() => parseTrust(text, "trust.json"), TrustConfigError, text.slice(0, 40));
  assert.deepEqual(loadTrust(join(t.dir, "absent.json")), []);
  const big = join(t.dir, "big.json");
  writeFileSync(big, " ".repeat(MAX_TRUST_FILE_BYTES + 1));
  assert.throws(() => loadTrust(big), /larger than/);
});

test("the trust source reads the file again and reports a change", () => {
  const path = join(t.dir, "source.json");
  const errors: string[] = [];
  const source = trustSource(path, (m) => errors.push(m));
  assert.deepEqual(source(), { list: [], changed: true });
  assert.equal(source().changed, false);
  writeTrust(path, [newFleetKey()]);
  const next = source();
  assert.equal(next.changed, true);
  assert.equal(next.list.length, 1);
  writeFileSync(path, "[");
  assert.equal(source().list.length, 0);
  assert.equal(errors.length, 1);
});
