// Probe 1 (task t20): an encrypted, mutually authenticated connection between two cores from key
// pairs, Node's standard library only. Throwaway: never built.
//
//   node spikes/d2-part-two/transport-probe.mjs
//
// Two processes on loopback stand for two cores: core A (`core.mjs serve`) and core B
// (`core.mjs call`). This orchestrator holds the keys only to hand them over and to search the
// captured bytes; it writes evidence/transport.ndjson. Keys and trust files live in a temporary
// directory removed at the end; no key is printed or written under evidence/.
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { start, waitFor } from './proc.mjs';
import { certificateFor, certificateText, evidence, fleetConnect, fleetServer, newKeyPair, privateKeyText, sleep } from './lib.mjs';

const ev = evidence('transport');
const dir = mkdtempSync(join(tmpdir(), 'd2-t20-transport-'));

const A = newKeyPair();
const B = newKeyPair();
const X = newKeyPair(); // a key no core trusts
const entry = (node, kp) => ({ node, cert: certificateText(kp.privateKey) });
const trustFile = (name, list) => {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify(list));
  return p;
};
const trustA = trustFile('trust-a', [entry('thor', B)]); // A trusts B
const trustB = trustFile('trust-b', [entry('host-a', A)]); // B trusts A
const trustX = trustFile('trust-x', [entry('host-a', A)]); // X trusts A, A does not trust X
const trustBWrong = trustFile('trust-b-wrong', [entry('host-a', X)]); // B expects another key at A's port

async function call(keyPair, trust, port, node = 'thor') {
  const c = start(['call', '--node', node, '--trust', trust, '--port', String(port)], keyPair);
  await c.done;
  return c.events.at(-1);
}

// A recording proxy between B and A: every byte in both directions.
const captured = [];
let proxyPort = 0;
function startProxy(target) {
  const proxy = net.createServer((client) => {
    const upstream = net.connect(target, '127.0.0.1');
    client.on('data', (d) => (captured.push(Buffer.from(d)), upstream.write(d)));
    upstream.on('data', (d) => (captured.push(Buffer.from(d)), client.write(d)));
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => {});
    upstream.on('error', () => {});
  });
  return new Promise((r) => proxy.listen(0, '127.0.0.1', () => r(proxy)));
}

const coreA = start(['serve', '--node', 'host-a', '--trust', trustA], A);
const { port } = await waitFor(coreA, (e) => e.event === 'listening');
ev.log('core_a_listening', { address: '127.0.0.1', note: 'loopback only' });

// 1. B and A authenticate each other and B reads A's version, through the recording proxy.
const proxy = await startProxy(port);
proxyPort = proxy.address().port;
const ok = await call(B, trustB, proxyPort);
ev.log('case_trusted_pair', { result: ok.event, status: ok.status, peer_seen_by_b: ok.peer, body: ok.body, ms: ok.ms });
const seenByA = coreA.events.find((e) => e.event === 'request');
ev.log('case_trusted_pair_on_a', { request_from: seenByA?.from, path: seenByA?.path });

// 2. The bytes on the wire hold no private key, no reusable secret and no plaintext request.
const wire = Buffer.concat(captured);
const needles = [];
for (const [who, kp] of [['A', A], ['B', B]]) {
  const pkcs8 = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
  needles.push([`${who} private key PKCS8 DER`, pkcs8]);
  needles.push([`${who} private key seed (32 raw bytes)`, pkcs8.subarray(pkcs8.length - 32)]);
  needles.push([`${who} private key text form`, Buffer.from(privateKeyText(kp.privateKey))]);
  needles.push([`${who} private key PEM`, Buffer.from(kp.privateKey.export({ type: 'pkcs8', format: 'pem' }))]);
  needles.push([`${who} certificate DER (public; TLS 1.3 encrypts it)`, certificateFor(kp.privateKey).der]);
}
needles.push(['plaintext request line', Buffer.from('GET /v1/version')]);
needles.push(['plaintext response field', Buffer.from('api_version')]);
const hits = needles.map(([label, n]) => ({ label, found: wire.includes(n) }));
const tls13Records = wire.filter((_, i) => i < wire.length - 2 && wire[i] === 0x17 && wire[i + 1] === 0x03 && wire[i + 2] === 0x03).length;
ev.log('case_capture', { bytes_captured: wire.length, application_data_record_headers: tls13Records, searched: hits, any_found: hits.some((h) => h.found) });

// 3. A key A does not trust is refused before A reads a request.
const servedBefore = coreA.events.filter((e) => e.event === 'request').length;
const unknown = await call(X, trustX, port, 'intruder');
await sleep(200);
const refusal = coreA.events.find((e) => e.event === 'refused');
const servedAfter = coreA.events.filter((e) => e.event === 'request').length;
ev.log('case_unknown_client', { b_side: unknown.event, b_error: unknown.error, a_refusal_reason: refusal?.reason, requests_served_before: servedBefore, requests_served_after: servedAfter });

// 4. B refuses a server whose key is not the one B trusts at that address, before writing.
const wrongServer = await call(B, trustBWrong, port);
ev.log('case_unknown_server', { b_side: wrongServer.event, b_error: wrongServer.error, requests_served_on_a: coreA.events.filter((e) => e.event === 'request').length });

// 5. Removing B's certificate from A's trust list refuses B on its next connection.
writeFileSync(trustA, JSON.stringify([]));
coreA.kill('SIGHUP');
await waitFor(coreA, (e) => e.event === 'trust_reloaded');
const revoked = await call(B, trustB, port);
await sleep(200);
const lastRefusal = coreA.events.filter((e) => e.event === 'refused').at(-1);
ev.log('case_revoked', { b_side: revoked.event, b_error: revoked.error, a_refusal_reason: lastRefusal?.reason });
writeFileSync(trustA, JSON.stringify([entry('thor', B)]));
coreA.kill('SIGHUP');
await sleep(100);

// 6. Session resumption: a TLS 1.3 ticket would let a peer resume without presenting its
//    certificate again, so a ticket is a reusable secret. Node's default server issues one; the
//    fleet server sets SSL_OP_NO_TICKET. Measured in-process, since it needs the client's session.
async function resumption(makeServer) {
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const opts = { host: '127.0.0.1', port: server.address().port, ...tlsClient(B), checkServerIdentity: () => undefined };
  const session = await new Promise((resolve) => {
    let got = null;
    const s = tls.connect(opts);
    s.on('session', (sess) => (got = sess));
    s.on('data', () => {});
    s.on('close', () => resolve(got));
    s.on('error', () => resolve(got));
  });
  const reused = !session
    ? null
    : await new Promise((resolve) => {
        const s = tls.connect({ ...opts, session });
        s.once('secureConnect', () => {
          resolve(s.isSessionReused());
          s.destroy();
        });
        s.on('error', (e) => resolve(e.code || e.message));
      });
  server.close();
  return { session_offered_to_client: Boolean(session), resumed: reused };
}
const nodeDefault = await resumption(() =>
  tls.createServer({ ...tlsClient(A, B), requestCert: true, rejectUnauthorized: true }, (s) => s.end('ok')),
);
const fleetDefault = await resumption(() => fleetServer(A.privateKey, [entry('thor', B)], (s) => s.end('ok'), () => {}));
ev.log('case_session_ticket', { node_default_server: nodeDefault, fleet_server_no_ticket: fleetDefault });

// 7. Cost: median full handshake on loopback over 50 connections.
const times = [];
for (let i = 0; i < 50; i++) {
  const t0 = performance.now();
  const { socket } = await fleetConnect(B.privateKey, [entry('host-a', A)], port);
  times.push(performance.now() - t0);
  socket.destroy();
}
times.sort((a, b) => a - b);
ev.log('case_handshake_cost', { connections: times.length, median_ms: Number(times[25].toFixed(2)), p90_ms: Number(times[45].toFixed(2)), note: 'loopback, same machine; says nothing about a real network' });

const cert = new X509Certificate(certificateFor(A.privateKey).der);
ev.log('versions', { node: process.version, openssl: process.versions.openssl, key: 'ed25519', cert_subject: cert.subject.replace(/[0-9a-f]{32}/, '<fingerprint>'), cert_valid_to: cert.validTo });

coreA.kill('SIGTERM');
proxy.close();
await coreA.done;
rmSync(dir, { recursive: true, force: true });
await ev.close();
process.exit(0);

function tlsClient(kp, trusted = A) {
  const cert = certificateFor(kp.privateKey).pem;
  return { key: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert, ca: [certificateFor(trusted.privateKey).pem], minVersion: 'TLSv1.3' };
}
