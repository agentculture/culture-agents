/**
 * A fleet member's key and the certificate derived from it (docs/d2/part-two-design.md, Decisions 1
 * and 2). Node's standard library only.
 *
 * - The private key is Ed25519. It reaches the core as one line, `ed25519:<base64 PKCS#8 DER>`, in
 *   `CULTURE_AGENTS_FLEET_KEY`, injected by `grant run --inject`. The core takes it out of its
 *   environment at start with the other injected secrets (daemon/secrets.ts). The kernel keeps the
 *   environment the process started with, so the key stays readable in `/proc/<core pid>/environ`
 *   to processes of the same user for as long as the core runs; other users cannot read it.
 * - The certificate is a self-signed X.509 v3 certificate built in memory. Every field is fixed or
 *   derived from the public key, and Ed25519 signatures are deterministic, so one key always gives
 *   the same certificate bytes. It is public: it is what an operator adds to another member's trust
 *   list. Node can parse a certificate but cannot make one, so the few DER fields are encoded here.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate, type KeyObject } from "node:crypto";

export const FLEET_KEY_ENV = "CULTURE_AGENTS_FLEET_KEY";
const KEY_PREFIX = "ed25519:";

export class FleetKeyError extends Error {
  override readonly name = "FleetKeyError";
}

/** Parse the one-line key form. The error never contains the value. */
export function parseFleetKey(text: string): KeyObject {
  const trimmed = text.trim();
  if (!trimmed.startsWith(KEY_PREFIX)) throw new FleetKeyError(`${FLEET_KEY_ENV} must be one line of the form ed25519:<base64 PKCS#8>`);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.from(trimmed.slice(KEY_PREFIX.length), "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new FleetKeyError(`${FLEET_KEY_ENV} is not a valid PKCS#8 private key`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new FleetKeyError(`${FLEET_KEY_ENV} must hold an Ed25519 key`);
  return key;
}

/** The one-line form of a private key. Only the key command prints it, for the operator to store in grant. */
export function fleetKeyText(key: KeyObject): string {
  return KEY_PREFIX + key.export({ type: "pkcs8", format: "der" }).toString("base64");
}

/** A fresh Ed25519 private key. */
export function newFleetKey(): KeyObject {
  return generateKeyPairSync("ed25519").privateKey;
}

/** SHA-256 of the SubjectPublicKeyInfo DER, hex: the fingerprint an operator compares by eye. */
export function fingerprint(keyOrCert: KeyObject | X509Certificate): string {
  const pub = keyOrCert instanceof X509Certificate ? keyOrCert.publicKey : createPublicKey(keyOrCert);
  return createHash("sha256").update(pub.export({ type: "spki", format: "der" })).digest("hex");
}

// ---------------------------------------------------------------- DER, only what the certificate needs

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const int = (b: Buffer): Buffer => tlv(0x02, (b[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = (bytes: number[]): Buffer => tlv(0x06, Buffer.from(bytes));
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
const bits = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));

const ED25519_ALGORITHM = seq(oid([0x2b, 0x65, 0x70])); // 1.3.101.112, no parameters
const commonName = (cn: string): Buffer => seq(set(seq(oid([0x55, 0x04, 0x03]), utf8(cn))));
// From 2000 to 9999 (RFC 5280's "no well-defined expiry"): trust ends when the certificate leaves a trust list.
const VALIDITY = seq(tlv(0x17, Buffer.from("000101000000Z", "ascii")), tlv(0x18, Buffer.from("99991231235959Z", "ascii")));

export interface MemberCertificate {
  readonly der: Buffer;
  readonly pem: string;
  /** The certificate DER as one base64 line: the form a trust list holds. */
  readonly text: string;
}

const pemOf = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----\n`;

/** The self-signed certificate of `key`. The subject is the key's fingerprint, so no two members share one. */
export function certificateFor(key: KeyObject): MemberCertificate {
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const digest = createHash("sha256").update(spki).digest();
  const serial = Buffer.from(digest.subarray(0, 16));
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const subject = commonName(`culture-agents member ${digest.toString("hex").slice(0, 32)}`);
  const version = tlv(0xa0, int(Buffer.from([2])));
  const tbs = seq(version, int(serial), ED25519_ALGORITHM, subject, VALIDITY, subject, spki);
  const der = seq(tbs, ED25519_ALGORITHM, bits(sign(null, tbs, key)));
  return { der, pem: pemOf(der), text: der.toString("base64") };
}

/**
 * A trust-list certificate from its one-line form. Refused unless it parses, carries an Ed25519
 * public key and is signed by that key (a member certificate is self-signed).
 */
export function parseMemberCertificate(text: string): { cert: X509Certificate; pem: string } {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new FleetKeyError("a member certificate must be one base64 line");
  const der = Buffer.from(text, "base64");
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(der);
  } catch {
    throw new FleetKeyError("a member certificate does not parse as X.509");
  }
  if (cert.publicKey.asymmetricKeyType !== "ed25519") throw new FleetKeyError("a member certificate must carry an Ed25519 key");
  if (!cert.verify(cert.publicKey)) throw new FleetKeyError("a member certificate must be signed by its own key");
  return { cert, pem: pemOf(der) };
}
