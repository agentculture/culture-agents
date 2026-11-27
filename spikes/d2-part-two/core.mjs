// A stand-in for one core on the fleet transport (task t20 probe). Throwaway: never built.
//
// Not product code. It holds only what the probes need to measure: the key reaching the process,
// the TLS 1.3 listener with a trust list, a tiny HTTP surface over it, announcements and the
// silence sweep. Every line of output is one JSON event on stdout.
//
//   node core.mjs serve --node <name> --trust <file> [--announce-to <port>[,<port>]]
//                       [--interval-s 5] [--silence-s 15] [--sweep-s 1] [--clock-offset-s 0]
//   node core.mjs call  --node <name> --trust <file> --port <port> [--path /v1/version]
//
// The private key arrives in CULTURE_AGENTS_FLEET_KEY (one line, `ed25519:<base64 PKCS#8>`), the
// way `grant run --inject` would pass it. It is read once and deleted from process.env before
// anything else runs. The trust file is JSON: [{ "node": "...", "cert": "<base64 DER>" }].
// SIGHUP re-reads the trust file for the next connection.
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { parseArgs } from 'node:util';
import { fleetConnect, fleetServer, fingerprint, parsePrivateKeyText } from './lib.mjs';

const KEY_ENV = 'CULTURE_AGENTS_FLEET_KEY';
const keyText = process.env[KEY_ENV];
Reflect.deleteProperty(process.env, KEY_ENV);
if (!keyText) throw new Error(`${KEY_ENV} is not set`);
const privateKey = parsePrivateKeyText(keyText);

const [cmd, ...rest] = process.argv.slice(2);
const { values: opt } = parseArgs({
  args: rest,
  options: {
    node: { type: 'string' },
    trust: { type: 'string' },
    port: { type: 'string' },
    path: { type: 'string', default: '/v1/version' },
    'announce-to': { type: 'string', default: '' },
    'interval-s': { type: 'string', default: '5' },
    'silence-s': { type: 'string', default: '15' },
    'sweep-s': { type: 'string', default: '1' },
    'clock-offset-s': { type: 'string', default: '0' },
  },
});
const emit = (event, data = {}) =>
  process.stdout.write(JSON.stringify({ mono_s: Number((performance.now() / 1000).toFixed(3)), node: opt.node, event, ...data }) + '\n');
function readTrust() {
  const list = JSON.parse(readFileSync(opt.trust, 'utf8'));
  const names = list.map((t) => t.node);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) {
    emit('trust_invalid', { reason: `node name ${dup} appears twice in the trust list` });
    process.exit(2);
  }
  return list;
}
const now = () => new Date(Date.now() + Number(opt['clock-offset-s']) * 1000).toISOString();
const API_VERSION = '3.0';

/** One HTTP request over a connection that has already passed the handshake and the trust check. */
const timeoutMs = Number(opt['interval-s']) * 1000; // one interval: a request never outlives the next announcement
async function request(port, method, path, body) {
  const { socket, member } = await fleetConnect(privateKey, readTrust(), port, '127.0.0.1', timeoutMs);
  return new Promise((resolve, reject) => {
    const req = http.request({ method, path, createConnection: () => socket, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, peer: member.node }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

if (cmd === 'call') {
  try {
    const t0 = performance.now();
    const res = await request(Number(opt.port), 'GET', opt.path);
    emit('call_ok', { ...res, ms: Number((performance.now() - t0).toFixed(1)) });
  } catch (err) {
    emit('call_refused', { error: err.code || err.message });
  }
  process.exit(0);
}

if (cmd !== 'serve') throw new Error(`unknown command ${cmd}`);

// ---------------------------------------------------------------- member list (announcements only)
const silenceMs = Number(opt['silence-s']) * 1000;
const members = new Map(); // node -> { fp, lastHeardMono, seq }

function announce(member, body) {
  if (body.node !== member.node) return { status: 409, body: { code: 'conflict', message: `node name ${body.node} is held by another key` } };
  const known = members.get(body.node);
  if (body.state === 'leaving') {
    if (known) {
      members.delete(body.node);
      emit('member_down', { member: body.node, reason: 'left', silent_for_s: 0 });
    }
    return { status: 200, body: { node: opt.node } };
  }
  if (!known) emit('member_up', { member: body.node, fp: memberFp(member), their_clock: body.sent_at });
  members.set(body.node, { lastHeardMono: performance.now(), seq: body.seq });
  return { status: 200, body: { node: opt.node, members: [...members.keys()] } };
}
const memberFp = (member) => fingerprint(new X509Certificate(Buffer.from(member.cert, 'base64'))).slice(0, 16);

setInterval(() => {
  const t = performance.now();
  for (const [name, m] of members) {
    if (t - m.lastHeardMono > silenceMs) {
      members.delete(name);
      emit('member_down', { member: name, reason: 'silent', silent_for_s: Number(((t - m.lastHeardMono) / 1000).toFixed(3)) });
    }
  }
}, Number(opt['sweep-s']) * 1000).unref();

// ---------------------------------------------------------------- listener
let served = 0;
const httpServer = http.createServer((req, res) => {
  served++;
  const member = req.socket.fleetMember;
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let out = { status: 404, body: { code: 'not_found' } };
    if (req.method === 'GET' && req.url === '/v1/version') out = { status: 200, body: { api_version: API_VERSION, node: opt.node } };
    if (req.method === 'GET' && req.url === '/v1/fleet/members') out = { status: 200, body: { members: [...members.keys()] } };
    if (req.method === 'POST' && req.url === '/v1/fleet/announce') {
      const body = JSON.parse(raw);
      out = announce(member, body);
      if (out.status !== 200) emit('announce_refused', { claimed: body.node, holder_of_key: member.node, reason: out.body.message });
    }
    emit('request', { method: req.method, path: req.url, from: member.node, status: out.status, served });
    res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
  });
});
const server = fleetServer(
  privateKey,
  readTrust(),
  (socket, member) => {
    socket.fleetMember = member;
    httpServer.emit('connection', socket);
  },
  (why) => emit('refused', { ...why, served }),
);
process.on('SIGHUP', () => {
  server.reload(readTrust());
  emit('trust_reloaded', { entries: readTrust().length });
});

// ---------------------------------------------------------------- announcer
let seq = 0;
const peers = opt['announce-to'].split(',').filter(Boolean).map(Number);
async function announceAll(state = 'up') {
  await Promise.all(
    peers.map(async (port) => {
      try {
        const res = await request(port, 'POST', '/v1/fleet/announce', { node: opt.node, api_version: API_VERSION, seq: ++seq, state, sent_at: now() });
        if (res.status !== 200) emit('announce_rejected', { port, status: res.status, body: res.body });
        else if (state === 'up' && !members.has(res.body.node)) {
          // The reply is the peer's own announcement: a configured side and a dialled side see each other.
          members.set(res.body.node, { lastHeardMono: performance.now(), seq: 0 });
          emit('member_up', { member: res.body.node, via: 'reply' });
        } else if (members.has(res.body.node)) members.get(res.body.node).lastHeardMono = performance.now();
      } catch (err) {
        emit('announce_failed', { port, error: err.code || err.message });
      }
    }),
  );
}
process.on('SIGTERM', async () => {
  await announceAll('leaving');
  emit('stopping');
  process.exit(0);
});

server.listen(0, '127.0.0.1', () => {
  emit('listening', { port: server.address().port });
  if (peers.length) {
    announceAll();
    setInterval(announceAll, Number(opt['interval-s']) * 1000);
  }
});
