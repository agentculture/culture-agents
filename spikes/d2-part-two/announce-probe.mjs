// Probe 3 (task t20): a core announces itself to its peers over the fleet transport, without the
// chat mesh, and is dropped when it stops or goes silent. Throwaway: never built.
//
//   node spikes/d2-part-two/announce-probe.mjs [--interval-s 5] [--silence-s 15]
//
// Two processes on loopback stand for two cores. Core A (host-a) knows no address; core B (thor)
// is configured with A's port and announces to it every interval. A builds its member list from
// announcements only; B learns A from A's reply. Every time below is measured on the observing
// core's monotonic clock, from the moment the orchestrator acted. Runs about 90 seconds at the
// stated numbers. Writes evidence/announce.ndjson.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { certificateText, evidence, newKeyPair, sleep } from './lib.mjs';
import { start, waitFor } from './proc.mjs';

const { values: opt } = parseArgs({ options: { 'interval-s': { type: 'string', default: '5' }, 'silence-s': { type: 'string', default: '15' } } });
const INTERVAL = Number(opt['interval-s']);
const SILENCE = Number(opt['silence-s']);
const SWEEP = 1;
const BOUND = SILENCE + SWEEP; // the stated detection bound for a silent member, in seconds
const ev = evidence('announce');
ev.log('stated_numbers', { interval_s: INTERVAL, silence_s: SILENCE, sweep_s: SWEEP, request_timeout_s: INTERVAL, silent_detection_bound_s: BOUND, leave_detection_bound_s: 1 });

const dir = mkdtempSync(join(tmpdir(), 'd2-t20-announce-'));
const A = newKeyPair();
const B = newKeyPair();
const C = newKeyPair(); // trusted by A under another name, then claims B's name
const D = newKeyPair(); // trusted by nobody
const entry = (node, kp) => ({ node, cert: certificateText(kp.privateKey) });
const file = (name, list) => (writeFileSync(join(dir, name), JSON.stringify(list)), join(dir, name));
const trustA = file('a.json', [entry('thor', B), entry('host-c', C)]);
const trustB = file('b.json', [entry('host-a', A)]);
const timing = ['--interval-s', String(INTERVAL), '--silence-s', String(SILENCE), '--sweep-s', String(SWEEP)];

const now = () => performance.now() / 1000;
const r3 = (x) => Number(x.toFixed(3));
const coreA = start(['serve', '--node', 'host-a', '--trust', trustA, ...timing], A);
const { port } = await waitFor(coreA, (e) => e.event === 'listening');
await sleep(INTERVAL * 1000 + 200);
ev.log('a_alone', { member_events_on_a: coreA.events.filter((e) => e.event.startsWith('member_')).length, note: 'no announcement yet, so A lists nobody' });

async function startB(extra = []) {
  const from = coreA.events.length;
  const t0 = now();
  const b = start(['serve', '--node', 'thor', '--trust', trustB, '--announce-to', String(port), ...timing, ...extra], B);
  const up = await waitFor(coreA, (e) => e.event === 'member_up' && e.member === 'thor', 10000, from);
  const back = await waitFor(b, (e) => e.event === 'member_up' && e.member === 'host-a', 10000);
  return { b, appeared_on_a_after_s: r3(up.seen_mono_s - t0), a_appeared_on_b_after_s: r3(back.seen_mono_s - t0), their_clock_as_announced: up.their_clock };
}
async function measureDown(b, signal, reason) {
  const from = coreA.events.length;
  const t0 = now();
  b.kill(signal);
  const down = await waitFor(coreA, (e) => e.event === 'member_down' && e.member === 'thor', (BOUND + 10) * 1000, from);
  const after = r3(down.seen_mono_s - t0);
  return { signal, reason_on_a: down.reason, dropped_after_s: after, silent_for_s_on_a: down.silent_for_s, within_bound: after <= (reason === 'left' ? 1 : BOUND) };
}

// 1. B appears on A after its first announcement, and A on B through the reply.
let s = await startB();
ev.log('case_appear', { ...s, b: undefined });

// 2. A clean stop: B says it is leaving.
ev.log('case_stop_sigterm', await measureDown(s.b, 'SIGTERM', 'left'));
await s.b.done;

// 3. A crash: no goodbye, so silence decides.
s = await startB();
ev.log('case_crash_sigkill', await measureDown(s.b, 'SIGKILL', 'silent'));

// 4. A halt or a partition: the process is frozen and its TCP socket stays open, as a halted host's
//    would look from A. B's clock is set 1 hour ahead to show A never reads it.
s = await startB(['--clock-offset-s', '3600']);
ev.log('case_clock_offset', { their_clock_as_announced: s.their_clock_as_announced, note: 'B claims a time 1 hour ahead; A measures silence on its own monotonic clock' });
const halted = await measureDown(s.b, 'SIGSTOP', 'silent');
ev.log('case_halt_sigstop', halted);
const from = coreA.events.length;
const t0 = now();
s.b.kill('SIGCONT');
const back = await waitFor(coreA, (e) => e.event === 'member_up' && e.member === 'thor', (INTERVAL + 5) * 1000, from);
ev.log('case_resume_sigcont', { reappeared_on_a_after_s: r3(back.seen_mono_s - t0), note: 'listed again only by a new announcement' });

// 5. The other direction: A halts, B stops hearing A's replies and drops it; B's announcements time out.
const fromB = s.b.events.length;
const tA = now();
coreA.kill('SIGSTOP');
const aDown = await waitFor(s.b, (e) => e.event === 'member_down' && e.member === 'host-a', (BOUND + 10) * 1000, fromB);
const timeouts = s.b.events.slice(fromB).filter((e) => e.event === 'announce_failed').map((e) => e.error);
ev.log('case_peer_halt_seen_by_b', { dropped_after_s: r3(aDown.seen_mono_s - tA), reason_on_b: aDown.reason, within_bound: aDown.seen_mono_s - tA <= BOUND, announce_errors: timeouts });
coreA.kill('SIGCONT');
await sleep(500);

// 6. Name uniqueness: C holds a trusted key of its own and claims B's name.
const fromC = coreA.events.length;
const c = start(['serve', '--node', 'thor', '--trust', trustB, '--announce-to', String(port), ...timing], C);
const refused = await waitFor(coreA, (e) => e.event === 'announce_refused', 10000, fromC);
const rejected = await waitFor(c, (e) => e.event === 'announce_rejected', 10000);
ev.log('case_duplicate_name', { reported_on_a: refused.reason, claimed: refused.claimed, key_belongs_to: refused.holder_of_key, c_told: rejected.status, thor_still_held_by_b: true });
c.kill('SIGKILL');

// 7. A key nobody trusts never reaches the member list.
const fromD = coreA.events.length;
const d = start(['serve', '--node', 'stranger', '--trust', trustB, '--announce-to', String(port), ...timing], D);
const dRefused = await waitFor(coreA, (e) => e.event === 'refused', 10000, fromD);
await sleep(500);
ev.log('case_untrusted_key', { refused_on_a: dRefused.reason, listed: coreA.events.slice(fromD).some((e) => e.event === 'member_up' && e.member === 'stranger') });
d.kill('SIGKILL');

// 8. A trust list that gives one node name to two keys is refused at start.
const dupTrust = file('dup.json', [entry('thor', B), entry('thor', C)]);
const dup = start(['serve', '--node', 'host-a', '--trust', dupTrust, ...timing], A);
const code = await dup.done;
ev.log('case_trust_list_duplicate_name', { exit_code: code, reason: dup.events.find((e) => e.event === 'trust_invalid')?.reason });

s.b.kill('SIGKILL');
coreA.kill('SIGKILL');
rmSync(dir, { recursive: true, force: true });
await ev.close();
process.exit(0);
