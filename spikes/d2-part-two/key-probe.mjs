// Probe 2 (task t20): where a core's private key lives and how it reaches the core.
// Throwaway: never built.
//
//   node spikes/d2-part-two/key-probe.mjs
//
// The orchestrator makes a key and starts a stand-in core four ways:
//   env       the key in CULTURE_AGENTS_FLEET_KEY, as `grant run --inject` passes it;
//   env-pem   the same with the multi-line PEM form instead of the one-line form;
//   pipe      the key written to the core's file descriptor 3 by a launcher, env clean;
//   file      the key read from a 0600 file in a 0700 directory (and refused at 0644).
// The stand-in core takes the key, deletes the variable, signs a challenge with it, spawns a
// worker with its own process.env, and reports what the worker and /proc can still see.
// No key is printed: the evidence holds booleans and lengths only.
import { spawn, spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes, verify } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidence, newKeyPair, parsePrivateKeyText, privateKeyText } from './lib.mjs';

const KEY_ENV = 'CULTURE_AGENTS_FLEET_KEY';
const role = process.argv[2];

if (role === 'core') {
  // ---------------------------------------------------------------- the stand-in core
  const mode = process.argv[3];
  let text;
  if (mode === 'env' || mode === 'env-pem') {
    text = process.env[KEY_ENV];
    Reflect.deleteProperty(process.env, KEY_ENV); // what takeSecrets does today
  } else if (mode === 'pipe') {
    text = readFileSync(3, 'utf8'); // fd 3, read to end once, then closed by the launcher
  } else if (mode === 'file') {
    const path = process.argv[4];
    const st = statSync(path);
    if (st.mode & 0o077) {
      process.stdout.write(JSON.stringify({ refused: `key file mode ${(st.mode & 0o777).toString(8)} is readable by others` }));
      process.exit(0);
    }
    text = readFileSync(path, 'utf8').trim();
  }
  const key = text.startsWith('ed25519:') ? parsePrivateKeyText(text) : createPrivateKey(text);
  const challenge = Buffer.from(process.argv.at(-1), 'hex');
  const signature = (await import('node:crypto')).sign(null, challenge, key).toString('hex');
  const needle = text.startsWith('ed25519:') ? text.slice(8, 40) : text.split('\n')[1].slice(0, 32);
  const worker = spawnSync(
    process.execPath,
    ['-e', `const fs=require('fs');const env=JSON.stringify(process.env);let parent='';try{parent=fs.readFileSync('/proc/${process.pid}/environ','latin1')}catch(e){parent='ERR '+e.code}process.stdout.write(JSON.stringify({inEnv:env.includes(${JSON.stringify(needle)}),varName:'${KEY_ENV}' in process.env,inParentProcEnviron:parent.includes(${JSON.stringify(needle)}),parentReadable:!parent.startsWith('ERR')}))`],
    { env: process.env, encoding: 'utf8' },
  );
  const own = readFileSync('/proc/self/environ', 'latin1');
  process.stdout.write(
    JSON.stringify({
      signature,
      key_in_process_env_after_take: KEY_ENV in process.env,
      key_in_own_proc_environ: own.includes(needle),
      worker: JSON.parse(worker.stdout),
    }),
  );
  process.exit(0);
}

// ---------------------------------------------------------------- the orchestrator
const ev = evidence('key');
const self = new URL(import.meta.url).pathname;
const kp = newKeyPair();
const oneLine = privateKeyText(kp.privateKey);
const pem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = createPublicKey(kp.privateKey);
ev.log('key_forms', { one_line_length: oneLine.length, one_line_has_newline: oneLine.includes('\n'), pem_lines: pem.trim().split('\n').length });

function run(mode, { env = {}, fd3, extra = [] } = {}) {
  const challenge = randomBytes(32);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [self, 'core', mode, ...extra, challenge.toString('hex')], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'inherit', fd3 === undefined ? 'ignore' : 'pipe'],
    });
    if (fd3 !== undefined) child.stdio[3].end(fd3);
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('exit', () => {
      const r = JSON.parse(out);
      if (r.signature) {
        r.signature_verifies = verify(null, challenge, pub, Buffer.from(r.signature, 'hex'));
        delete r.signature;
      }
      resolve(r);
    });
  });
}

ev.log('case_env_one_line', await run('env', { env: { [KEY_ENV]: oneLine } }));
ev.log('case_env_pem', await run('env-pem', { env: { [KEY_ENV]: pem } }));
ev.log('case_pipe_fd3', await run('pipe', { fd3: oneLine }));

const dir = mkdtempSync(join(tmpdir(), 'd2-t20-key-'));
const keyDir = join(dir, 'fleet');
mkdirSync(keyDir, { mode: 0o700 });
const keyFile = join(keyDir, 'key');
writeFileSync(keyFile, oneLine + '\n', { mode: 0o600 });
ev.log('case_file_0600', await run('file', { extra: [keyFile] }));
chmodSync(keyFile, 0o644);
ev.log('case_file_0644', await run('file', { extra: [keyFile] }));
rmSync(dir, { recursive: true, force: true });

const grant = spawnSync('sh', ['-c', 'command -v grant'], { encoding: 'utf8' });
ev.log('grant_present', { found: grant.status === 0, note: grant.status === 0 ? 'present' : 'grant is not installed here: storing and injecting the key through grant is NOT VERIFIED' });
await ev.close();
