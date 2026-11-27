// t22: the member list (docs/d2/part-two-design.md, Decision 3), with an injected monotonic clock.
// The listing core is thor's fixture. A peer that must hold a name other than this core's own uses
// OTHER_NODE, length-boundary filler that names no host: two members may never share thor (c40), so
// a peer listed beside a core named thor cannot be named thor too.
import assert from "node:assert/strict";
import { test } from "node:test";

import { validate, type Announcement } from "../../src/contract/index.js";
import { certificateFor, fingerprint, newFleetKey } from "../../src/fleet/cert.js";
import { ANNOUNCE_INTERVAL_MS, createMemberList, SILENCE_MS, SWEEP_MS } from "../../src/fleet/members.js";
import type { TrustEntry } from "../../src/fleet/trust.js";

const OTHER_NODE = "xxxxxxxx";

function trusted(node: string): TrustEntry {
  const key = newFleetKey();
  const cert = certificateFor(key);
  return { node, cert: cert.text, pem: cert.pem, fingerprint: fingerprint(key) };
}

function listing(self = "thor") {
  let now = 1_000_000;
  const logs: string[] = [];
  const members = createMemberList({ node: self, fingerprint: fingerprint(newFleetKey()), now: () => now, log: (l) => logs.push(l) });
  return { members, logs, advance: (ms: number) => (now += ms) };
}

const up = (node: string, seq = 0): Announcement => ({ node, api_version: "3.1", seq, state: "up" });
const leaving = (node: string, seq = 1): Announcement => ({ node, api_version: "3.1", seq, state: "leaving" });

test("the stated numbers are the design record's: announce every 5 s, drop after 15 s of silence, sweep every 1 s", () => {
  assert.deepEqual([ANNOUNCE_INTERVAL_MS, SILENCE_MS, SWEEP_MS], [5000, 15000, 1000]);
  const { members } = listing();
  const view = members.view();
  assert.deepEqual([view.announce_interval_ms, view.silence_ms], [5000, 15000]);
  assert.ok(validate("fleet", view).ok);
});

test("nobody is listed before an announcement, trusted or not: the list is built from announcements only", () => {
  const { members } = listing();
  assert.deepEqual(members.view().members, []);
  assert.equal(members.view().node, "thor");
});

test("a trusted key that announces is listed under its trust-list name, with its key and api version", () => {
  const { members, logs, advance } = listing();
  const peer = trusted(OTHER_NODE);
  assert.deepEqual(members.receive(peer, up(OTHER_NODE, 7)), { ok: true });
  advance(1200);
  const view = members.view();
  assert.ok(validate("fleet", view).ok, JSON.stringify(validate("fleet", view)));
  assert.deepEqual(view.members, [{ node: OTHER_NODE, fingerprint: peer.fingerprint, api_version: "3.1", seq: 7, heard_ms_ago: 1200 }]);
  assert.ok(logs.some((l) => l.includes(`member ${OTHER_NODE} joined`)));
});

test("a silent member stays listed for 15 s and is gone after: the drop is within 16 s with the 1 s sweep", () => {
  const { members, logs, advance } = listing();
  const peer = trusted(OTHER_NODE);
  members.receive(peer, up(OTHER_NODE));
  advance(SILENCE_MS);
  members.sweep();
  assert.equal(members.view().members.length, 1, "15 s of silence is not yet more than 15 s");
  advance(1);
  assert.equal(members.view().members.length, 0, "a read never shows a member silent for more than 15 s");
  members.sweep();
  assert.ok(logs.some((l) => l.includes(`member ${OTHER_NODE} dropped`) && l.includes("silent")));
});

test("each announcement restarts the silence; a returning member is listed again at its next announcement", () => {
  const { members, advance } = listing();
  const peer = trusted(OTHER_NODE);
  members.receive(peer, up(OTHER_NODE, 0));
  for (let i = 1; i <= 6; i++) {
    advance(ANNOUNCE_INTERVAL_MS);
    members.receive(peer, up(OTHER_NODE, i));
  }
  assert.equal(members.view().members[0]?.seq, 6, "30 s of announcements every 5 s: still listed");
  advance(SILENCE_MS + SWEEP_MS);
  members.sweep();
  assert.equal(members.view().members.length, 0);
  members.receive(peer, up(OTHER_NODE, 0)); // it came back (restarted: its seq starts again)
  assert.equal(members.view().members[0]?.heard_ms_ago, 0);
});

test("a member that announces leaving is dropped at once", () => {
  const { members, logs } = listing();
  const peer = trusted(OTHER_NODE);
  members.receive(peer, up(OTHER_NODE));
  assert.deepEqual(members.receive(peer, leaving(OTHER_NODE)), { ok: true });
  assert.deepEqual(members.view().members, []);
  assert.ok(logs.some((l) => l.includes(`member ${OTHER_NODE} left`)));
});

test("a key claiming this core's own node name is refused and reported, and never listed (c40)", () => {
  // A second core started with thor's name and a different key, trusted here as thor.
  const { members, logs } = listing("thor");
  const second = trusted("thor");
  const receipt = members.receive(second, up("thor"));
  assert.equal(receipt.ok, false);
  assert.ok(!receipt.ok && /held by this core's own key/.test(receipt.reason));
  const view = members.view();
  assert.deepEqual(view.members, []);
  assert.equal(view.refused.length, 1);
  assert.deepEqual({ ...view.refused[0], heard_ms_ago: 0 }, { node: "thor", trusted_as: "thor", fingerprint: second.fingerprint, reason: receipt.ok ? "" : receipt.reason, count: 1, heard_ms_ago: 0 });
  assert.ok(logs.some((l) => l.includes("refused an announcement") && l.includes(second.fingerprint.slice(0, 16))));
});

test("an announcement claiming a name other than the one the trust list gives its key is refused", () => {
  const { members } = listing("thor");
  const peer = trusted(OTHER_NODE);
  const receipt = members.receive(peer, up("thor"));
  assert.ok(!receipt.ok && receipt.reason.includes(`names this key ${OTHER_NODE}`));
  assert.equal(receipt.ok ? null : receipt.retryable, false);
  assert.deepEqual(members.view().members, []);
  assert.equal(members.view().refused[0]?.trusted_as, OTHER_NODE);
});

test("a name still held by a listed key is refused to a new key until the old one leaves or goes silent", () => {
  // The operator replaced the trust entry for one name with a new key while the old key's core still runs.
  const { members, advance } = listing("thor");
  const old = trusted(OTHER_NODE);
  const replacement = trusted(OTHER_NODE);
  members.receive(old, up(OTHER_NODE));
  const refused = members.receive(replacement, up(OTHER_NODE));
  assert.ok(!refused.ok && /held by another key/.test(refused.reason));
  assert.equal(refused.ok ? null : refused.retryable, true, "retryable: the name frees once its holder is gone");
  assert.equal(members.view().members[0]?.fingerprint, old.fingerprint, "the name stays with the key that held it");
  assert.equal(members.receive(replacement, leaving(OTHER_NODE)).ok, false, "a leaving from the wrong key drops nothing");
  assert.equal(members.view().members[0]?.fingerprint, old.fingerprint);
  advance(SILENCE_MS + 1);
  assert.deepEqual(members.receive(replacement, up(OTHER_NODE)), { ok: true });
  assert.equal(members.view().members[0]?.fingerprint, replacement.fingerprint);
});

test("repeated refusals of one claim are counted, logged once a minute, and the report is bounded", () => {
  const { members, logs, advance } = listing("thor");
  const second = trusted("thor");
  for (let i = 0; i < 12; i++) {
    members.receive(second, up("thor", i));
    advance(ANNOUNCE_INTERVAL_MS);
  }
  assert.equal(members.view().refused.length, 1);
  assert.equal(members.view().refused[0]?.count, 12);
  assert.equal(logs.filter((l) => l.includes("refused an announcement")).length, 1, "60 s of repeats: one line");
  advance(1);
  members.receive(second, up("thor", 12));
  assert.equal(logs.filter((l) => l.includes("refused an announcement")).length, 2);
  for (let i = 0; i < 40; i++) members.receive(trusted("thor"), up("thor"));
  assert.equal(members.view().refused.length, 32);
  assert.ok(validate("fleet", members.view()).ok);
});

test("this core's own announcement carries no key material and counts up", () => {
  const { members } = listing("thor");
  const first = members.announcement("up");
  const second = members.announcement("leaving");
  assert.deepEqual(Object.keys(first).sort(), ["api_version", "node", "seq", "state"]);
  assert.equal(first.node, "thor");
  assert.equal(second.seq, first.seq + 1);
  assert.equal(second.state, "leaving");
  assert.ok(validate("fleet#announcement", first).ok);
});

test("an announcement from this core's own key is refused and reported: a core is not its own member", () => {
  let now = 0;
  const own = newFleetKey();
  const cert = certificateFor(own);
  const members = createMemberList({ node: "thor", fingerprint: fingerprint(own), now: () => now, log: () => undefined });
  const receipt = members.receive({ node: "thor", cert: cert.text, pem: cert.pem, fingerprint: fingerprint(own) }, up("thor"));
  assert.ok(!receipt.ok && /this core's own/.test(receipt.reason));
  now += 1;
  assert.deepEqual(members.view().members, []);
  assert.equal(members.view().refused.length, 1);
});

test("a member whose key leaves the trust list leaves the list at once, without waiting for its silence", () => {
  let now = 1_000_000;
  const peer = trusted(OTHER_NODE);
  let list: TrustEntry[] = [peer];
  const logs: string[] = [];
  const members = createMemberList({ node: "thor", fingerprint: fingerprint(newFleetKey()), now: () => now, log: (l) => logs.push(l), trust: () => list });
  assert.equal(members.receive(peer, up(OTHER_NODE)).ok, true);
  assert.deepEqual(members.view().members.map((m) => m.node), [OTHER_NODE]);
  list = []; // the operator removed the key
  now += 1;
  assert.deepEqual(members.view().members, [], "not listed one moment later");
  members.sweep();
  assert.ok(logs.some((l) => /no longer in this core's trust list/.test(l)), logs.join("\n"));
});
