// Starting stand-in cores (core.mjs) as child processes and reading their JSON events.
// Throwaway probe code: never built.
import { spawn } from 'node:child_process';
import { privateKeyText, sleep } from './lib.mjs';

const CORE = new URL('./core.mjs', import.meta.url).pathname;

/** Start `core.mjs <args>` with the key in CULTURE_AGENTS_FLEET_KEY; collect its events. */
export function start(args, keyPair) {
  const child = spawn(process.execPath, [CORE, ...args], {
    env: { ...process.env, CULTURE_AGENTS_FLEET_KEY: privateKeyText(keyPair.privateKey) },
  });
  const events = [];
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) events.push({ ...JSON.parse(line), seen_mono_s: performance.now() / 1000 });
    }
  });
  child.stderr.on('data', (c) => process.stderr.write(c));
  child.events = events;
  child.done = new Promise((r) => child.on('exit', (code) => r(code)));
  return child;
}

/** The first event (at or after index `from`) matching `pred`, or throw after `ms`. */
export async function waitFor(child, pred, ms = 5000, from = 0) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = child.events.slice(from).find(pred);
    if (hit) return hit;
    await sleep(10);
  }
  throw new Error(`timed out after ${ms} ms waiting for an event`);
}
