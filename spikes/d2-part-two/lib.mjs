// Shared plumbing for the D2 part two probes (task t20). Throwaway probe code: never built,
// linted or held to the line cap. Node's standard library only: node:crypto, node:tls,
// node:net, node:http. No npm dependency.
//
// What lives here:
//   - a member key pair (Ed25519) and its one-line text form, as the core would receive it;
//   - a self-signed X.509 certificate DERIVED from the key in memory (Node can parse a
//     certificate but cannot make one, so this file encodes the few DER fields by hand);
//   - a TLS 1.3 server and client that trust exactly the member certificates of a trust list,
//     so the handshake itself refuses an unknown key in both directions;
//   - an NDJSON evidence writer.
import { constants, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import tls from 'node:tls';

// ---------------------------------------------------------------- keys

/** A fresh Ed25519 key pair. */
export function newKeyPair() {
  return generateKeyPairSync('ed25519');
}

/** The one-line text form of a private key: `ed25519:` + base64 of its PKCS#8 DER (64 chars). */
export function privateKeyText(privateKey) {
  return 'ed25519:' + privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
}

/** Parse the one-line text form back into a KeyObject. Throws on anything else. */
export function parsePrivateKeyText(text) {
  if (typeof text !== 'string' || !text.startsWith('ed25519:')) throw new Error('not an ed25519: key text');
  return createPrivateKey({ key: Buffer.from(text.slice(8), 'base64'), format: 'der', type: 'pkcs8' });
}

/** SHA-256 of the SubjectPublicKeyInfo DER, hex: the fingerprint an operator compares by eye. */
export function fingerprint(keyOrCert) {
  const pub = keyOrCert instanceof X509Certificate ? keyOrCert.publicKey : createPublicKey(keyOrCert);
  return createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex');
}

// ---------------------------------------------------------------- a certificate derived from the key

const der = {
  len(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  },
  tlv(tag, body) {
    return Buffer.concat([Buffer.from([tag]), der.len(body.length), body]);
  },
  seq: (...parts) => der.tlv(0x30, Buffer.concat(parts)),
  set: (...parts) => der.tlv(0x31, Buffer.concat(parts)),
  int(buf) {
    return der.tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
  },
  oid: (bytes) => der.tlv(0x06, Buffer.from(bytes)),
  utf8: (s) => der.tlv(0x0c, Buffer.from(s, 'utf8')),
  utcTime: (s) => der.tlv(0x17, Buffer.from(s, 'ascii')),
  genTime: (s) => der.tlv(0x18, Buffer.from(s, 'ascii')),
  bits: (buf) => der.tlv(0x03, Buffer.concat([Buffer.from([0]), buf])),
  explicit: (n, body) => der.tlv(0xa0 + n, body),
};

const ED25519 = der.seq(der.oid([0x2b, 0x65, 0x70])); // 1.3.101.112, no parameters
const name = (cn) => der.seq(der.set(der.seq(der.oid([0x55, 0x04, 0x03]), der.utf8(cn)))); // CN=

/**
 * A self-signed X.509 v3 certificate for `privateKey`, built in memory. Every field is fixed or
 * derived from the public key and Ed25519 signatures are deterministic, so the same key always
 * gives the same certificate bytes: nothing but the private key has to be stored. The subject is
 * the key's fingerprint, so two members never share a subject name in a trust store. Validity
 * runs from 2000 to 9999 (RFC 5280's "no well-defined expiry"): trust ends by removing the
 * certificate from the trust list, not by a date.
 */
export function certificateFor(privateKey) {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const fp = createHash('sha256').update(spki).digest();
  const serial = Buffer.from(fp.subarray(0, 16));
  serial[0] &= 0x7f;
  const subject = name(`culture-agents member ${fp.toString('hex').slice(0, 32)}`);
  const tbs = der.seq(
    der.explicit(0, der.int(Buffer.from([2]))), // v3
    der.int(serial),
    ED25519,
    subject, // issuer: self-signed
    der.seq(der.utcTime('000101000000Z'), der.genTime('99991231235959Z')),
    subject,
    spki,
  );
  const signature = sign(null, tbs, privateKey);
  const certDer = der.seq(tbs, ED25519, der.bits(signature));
  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  return { der: certDer, pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n` };
}

/** The certificate as one base64 line: the public, shareable form an operator adds on each peer. */
export function certificateText(privateKey) {
  return certificateFor(privateKey).der.toString('base64');
}

function pemOfCertText(text) {
  const b64 = text.match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

// ---------------------------------------------------------------- TLS with a trust list

/**
 * Context options for one core. `trust` is a list of `{ node, cert }` with `cert` in the one-line
 * form. The private key is handed to OpenSSL as PEM held in memory only.
 */
export function tlsOptions(privateKey, trust) {
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: certificateFor(privateKey).pem,
    ca: trust.map((t) => pemOfCertText(t.cert)),
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  };
}

/** The trust-list entry whose certificate has this peer's public key, or undefined. */
export function memberOf(socket, trust) {
  const peer = socket.getPeerX509Certificate?.();
  if (!peer) return undefined;
  const fp = fingerprint(peer);
  return trust.find((t) => fingerprint(new X509Certificate(Buffer.from(t.cert, 'base64'))) === fp);
}

/**
 * A server that hands a connection to the application only when the peer's certificate is in
 * the trust list. `strict: true` makes OpenSSL abort the handshake itself (Node then reports only
 * "socket hang up"); the default lets the handshake finish and destroys the socket in
 * 'secureConnection' when `authorized` is false, which keeps OpenSSL's reason for the operator's
 * log. In both modes the application reads no byte from a refused peer.
 * `reload(trust)` swaps the trust list for the NEXT connection (setSecureContext).
 */
export function fleetServer(privateKey, trust, onMember, onRefused = () => {}, { strict = false } = {}) {
  let current = trust;
  // SSL_OP_NO_TICKET: no TLS 1.3 session ticket, so no resumption secret is handed out and every
  // connection presents and checks its certificate again (probe case_session_ticket).
  const noTicket = { secureOptions: constants.SSL_OP_NO_TICKET };
  const server = tls.createServer({ ...tlsOptions(privateKey, trust), ...noTicket, requestCert: true, rejectUnauthorized: strict });
  server.on('secureConnection', (socket) => {
    const member = socket.authorized ? memberOf(socket, current) : undefined;
    if (!member) {
      onRefused({ reason: socket.authorizationError || 'not in trust list', peer: peerFingerprint(socket) });
      socket.destroy();
      return;
    }
    onMember(socket, member);
  });
  server.on('tlsClientError', (err) => onRefused({ reason: err.code || err.message, message: err.message }));
  server.reload = (trust2) => {
    current = trust2;
    server.setSecureContext({ ...tlsOptions(privateKey, trust2), ...noTicket });
  };
  return server;
}

function peerFingerprint(socket) {
  const peer = socket.getPeerX509Certificate?.();
  return peer ? fingerprint(peer).slice(0, 16) : null;
}

/**
 * Connect to a peer and resolve with the socket only after the handshake verified the peer's
 * certificate against the trust list. No application byte is written before that.
 * The host-name check is replaced by the trust-list check: a member is its key, not a name.
 */
export function fleetConnect(privateKey, trust, port, host = '127.0.0.1', timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      ...tlsOptions(privateKey, trust),
      host,
      port,
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
    });
    if (timeoutMs) socket.setTimeout(timeoutMs, () => socket.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    socket.once('secureConnect', () => {
      const member = memberOf(socket, trust);
      if (!member) {
        socket.destroy();
        reject(new Error('peer not in trust list'));
        return;
      }
      resolve({ socket, member });
    });
    socket.once('error', reject);
  });
}

// ---------------------------------------------------------------- evidence

/** A log on stdout and an NDJSON record under evidence/, with seconds since start. */
export function evidence(name) {
  mkdirSync(new URL('./evidence/', import.meta.url), { recursive: true });
  const out = createWriteStream(new URL(`./evidence/${name}.ndjson`, import.meta.url));
  const t0 = performance.now();
  const elapsed = () => Number(((performance.now() - t0) / 1000).toFixed(3));
  return {
    log(event, data = {}) {
      const rec = { t: elapsed(), event, ...data };
      out.write(JSON.stringify(rec) + '\n');
      console.log(JSON.stringify(rec));
    },
    close: () => new Promise((r) => out.end(r)),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
