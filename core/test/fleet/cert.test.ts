// The member key and the certificate derived from it (design record, Decisions 1 and 2).
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { test } from "node:test";

import { certificateFor, FleetKeyError, fingerprint, fleetKeyText, newFleetKey, parseFleetKey, parseMemberCertificate } from "../../src/fleet/cert.js";

test("the key's one-line form round-trips and is 72 characters", () => {
  const key = newFleetKey();
  const text = fleetKeyText(key);
  assert.match(text, /^ed25519:[A-Za-z0-9+/]+=*$/);
  assert.equal(text.length, 72);
  assert.equal(fingerprint(parseFleetKey(text)), fingerprint(key));
  assert.equal(fingerprint(parseFleetKey(`${text}\n`)), fingerprint(key), "a trailing newline is tolerated");
});

test("a bad key is refused and the message never holds the value", () => {
  const x25519 = generateKeyPairSync("x25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  for (const text of ["", "secret-value-123", "ed25519:not-base64-secret!!", `ed25519:${x25519}`]) {
    assert.throws(
      () => parseFleetKey(text),
      (e: unknown) => e instanceof FleetKeyError && (text.length < 9 || !e.message.includes(text.slice(8))),
      text.slice(0, 12),
    );
  }
});

test("one key always gives the same certificate, which parses and is signed by that key", () => {
  const key = newFleetKey();
  const a = certificateFor(key);
  assert.deepEqual(a.der, certificateFor(key).der);
  const cert = new X509Certificate(a.der);
  assert.ok(cert.verify(cert.publicKey));
  assert.equal(fingerprint(cert), fingerprint(key));
  assert.match(cert.subject, /culture-agents member [0-9a-f]{32}/);
  assert.equal(cert.ca, false);
  assert.equal(new Date(cert.validTo).getUTCFullYear(), 9999);
  assert.equal(fingerprint(parseMemberCertificate(a.text).cert), fingerprint(key));
});

test("a certificate not signed by its own key is refused", () => {
  const der = Buffer.from(certificateFor(newFleetKey()).der);
  der[der.length - 1] = (der[der.length - 1] ?? 0) ^ 0xff; // break the signature
  assert.throws(() => parseMemberCertificate(der.toString("base64")), FleetKeyError);
});

test("a key whose serial would start with a zero byte still gives a certificate that parses (minimal DER integer)", () => {
  // About 1 key in 256 has a SHA-256 of its public key that starts 0x00 or 0x80 then a byte under 0x80.
  const leadingZero = (k: ReturnType<typeof newFleetKey>): boolean => {
    const d = createHash("sha256").update(createPublicKey(k).export({ type: "spki", format: "der" })).digest();
    return ((d[0] ?? 0) & 0x7f) === 0 && (d[1] ?? 0) < 0x80;
  };
  let key = newFleetKey();
  for (let i = 0; i < 20_000 && !leadingZero(key); i++) key = newFleetKey();
  assert.ok(leadingZero(key), "found such a key");
  const { cert } = parseMemberCertificate(certificateFor(key).text);
  assert.equal(fingerprint(cert), fingerprint(key));
});
