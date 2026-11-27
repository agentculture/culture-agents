// t22 acceptance 1 and 2 over the real transport on loopback: two cores, each a fleet (listener, member
// list, announcer) of thor's fixture. The announcing core is named thor. The core it announces to
// must hold another name, because two members never share one (c40); it uses OTHER_NODE, length-boundary
// filler that names no host. Timing rules use each core's injected clock; nothing waits 15 real seconds.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { join } from "node:path";
import { after, test } from "node:test";

import { validate } from "../../src/contract/index.js";
import { certificateFor, fingerprint, newFleetKey } from "../../src/fleet/cert.js";
import type { FleetConfig } from "../../src/fleet/config.js";
import { createFleet, type Fleet } from "../../src/fleet/index.js";
import { SILENCE_MS } from "../../src/fleet/members.js";
import { loadTrust } from "../../src/fleet/trust.js";
import { LOOPBACK, sleep, tmp } from "./support.js";

const OTHER_NODE = "xxxxxxxx";
const t = tmp();
after(() => t.cleanup());

interface Core {
  fleet: Fleet;
  key: KeyObject;
  logs: string[];
  dir: string;
  advance(ms: number): void;
  port(): number;
}

/** A core named `node` that trusts `trusted` (a key and the name its entry gives it), announcing to nobody yet. */
function core(node: string, key: KeyObject, trusted: readonly [string, KeyObject][]): Core {
  const dir = join(t.dir, Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const trustPath = join(dir, "trust.json");
  writeFileSync(trustPath, JSON.stringify(trusted.map(([name, k]) => ({ node: name, cert: certificateFor(k).text }))));
  const config: FleetConfig = { host: LOOPBACK, port: 0, key, trustPath, trust: loadTrust(trustPath), peersPath: join(dir, "peers.json") };
  let clock = 0;
  const logs: string[] = [];
  // A long interval: only the first round of `start` and the rounds a test asks for are sent.
  const fleet = createFleet(config, node, (l) => logs.push(l), { now: () => clock, intervalMs: 3_600_000 });
  return { fleet, key, logs, dir, advance: (ms) => (clock += ms), port: () => fleet.address()?.port ?? 0 };
}

const announceTo = (c: Core, ...targets: Core[]): void => writeFileSync(join(c.dir, "peers.json"), JSON.stringify(targets.map((x) => `${LOOPBACK}:${x.port()}`)));
const listed = (c: Core): string[] => c.fleet.members.view().members.map((m) => m.node);

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting until ${what}`);
    await sleep(20);
  }
}

/** The core named OTHER_NODE that knows no address, and thor's core that announces to it. */
async function pair(): Promise<{ listening: Core; announcing: Core }> {
  const listeningKey = newFleetKey();
  const announcingKey = newFleetKey();
  const listening = core(OTHER_NODE, listeningKey, [["thor", announcingKey]]);
  const announcing = core("thor", announcingKey, [[OTHER_NODE, listeningKey]]);
  assert.ok(await listening.fleet.start());
  announceTo(announcing, listening);
  return { listening, announcing };
}

test("each core lists the other after one announcement, under its trust-list name; before it, nobody", async () => {
  const { listening, announcing } = await pair();
  try {
    assert.deepEqual(listed(listening), [], "trusted, but not listed before it announces");
    const started = Date.now();
    assert.ok(await announcing.fleet.start());
    await until("both list each other", () => listed(listening).includes("thor") && listed(announcing).includes(OTHER_NODE));
    assert.ok(Date.now() - started < 5000, "listed within one interval (5 s)");
    const view = listening.fleet.members.view();
    assert.ok(validate("fleet", view).ok);
    assert.equal(view.members[0]?.fingerprint, fingerprint(announcing.key), "listed with the key the transport authenticated");
    assert.equal(announcing.fleet.members.view().members[0]?.fingerprint, fingerprint(listening.key), "the reply listed the core that knows no address");
  } finally {
    await announcing.fleet.stop();
    await listening.fleet.stop();
  }
});

test("a core that stops cleanly is dropped at once: its leaving arrives before its stop returns", async () => {
  const { listening, announcing } = await pair();
  try {
    assert.ok(await announcing.fleet.start());
    await until("listed", () => listed(listening).includes("thor"));
    const started = Date.now();
    await announcing.fleet.stop();
    assert.deepEqual(listed(listening), [], "no member left after the stop, with no sweep and no clock advance");
    assert.ok(Date.now() - started < 1500, "the stop, leaving included, took under the 1 s leaving timeout plus margin");
    assert.ok(listening.logs.some((l) => l.includes("member thor left")));
  } finally {
    await announcing.fleet.stop();
    await listening.fleet.stop();
  }
});

test("a core that goes silent is dropped after 15 s of silence on the listening core's clock, and listed again when it returns", async () => {
  const { listening, announcing } = await pair();
  try {
    assert.ok(await announcing.fleet.start());
    await until("listed", () => listed(listening).includes("thor"));
    // From here the announcing core sends nothing: it stands for a crashed, halted or cut-off host.
    listening.advance(SILENCE_MS);
    assert.deepEqual(listed(listening), ["thor"], "still listed at 15 s");
    listening.advance(1);
    assert.deepEqual(listed(listening), [], "gone after 15 s of silence");
    await sleep(1100); // one real sweep (1 s) logs the drop
    assert.ok(listening.logs.some((l) => l.includes("member thor dropped")));
    await announcing.fleet.announce();
    assert.deepEqual(listed(listening), ["thor"], "listed again at its next announcement");
  } finally {
    await announcing.fleet.stop();
    await listening.fleet.stop();
  }
});

test("the announcing core sees the core it announces to go silent: a failed announcement refreshes nothing", async () => {
  const { listening, announcing } = await pair();
  try {
    assert.ok(await announcing.fleet.start());
    await until("listed through the reply", () => listed(announcing).includes(OTHER_NODE));
    await listening.fleet.stop(); // knows no address, so it can tell nobody it leaves
    await announcing.fleet.announce(); // fails: nothing listens there now
    assert.ok(announcing.logs.some((l) => l.includes("cannot announce to")));
    announcing.advance(SILENCE_MS + 1);
    assert.deepEqual(listed(announcing), []);
  } finally {
    await announcing.fleet.stop();
    await listening.fleet.stop();
  }
});

test("a second core with thor's name and a different key is refused with conflict and reported on both sides (c40)", async () => {
  const firstKey = newFleetKey();
  const secondKey = newFleetKey();
  const first = core("thor", firstKey, [["thor", secondKey]]); // the operator trusted the second key under thor's own name
  const second = core("thor", secondKey, [["thor", firstKey]]);
  try {
    assert.ok(await first.fleet.start());
    announceTo(second, first);
    assert.ok(await second.fleet.start());
    await until("the refusal is reported", () => first.fleet.members.view().refused.length === 1);
    const view = first.fleet.members.view();
    assert.deepEqual(view.members, [], "never listed");
    assert.equal(view.refused[0]?.fingerprint, fingerprint(secondKey));
    assert.match(view.refused[0]?.reason ?? "", /held by this core's own key/);
    assert.ok(first.logs.some((l) => l.includes("refused an announcement (conflict)")));
    await until("the second core logs the refusal", () => second.logs.some((l) => l.includes("refused this core's announcement (409, conflict")));
    assert.deepEqual(listed(second), []);
  } finally {
    await second.fleet.stop();
    await first.fleet.stop();
  }
});

test("a key the listening core does not trust is refused in the handshake and never listed or reported as a member", async () => {
  const listeningKey = newFleetKey();
  const strangerKey = newFleetKey();
  const listening = core(OTHER_NODE, listeningKey, []);
  const stranger = core("thor", strangerKey, [[OTHER_NODE, listeningKey]]);
  try {
    assert.ok(await listening.fleet.start());
    announceTo(stranger, listening);
    assert.ok(await stranger.fleet.start());
    await until("the stranger's announcement failed", () => stranger.logs.some((l) => l.includes("cannot announce to")));
    await until("the listening core logged the refusal", () => listening.logs.some((l) => l.includes("refused a peer before reading any request")));
    assert.deepEqual(listening.fleet.members.view().members, []);
    assert.deepEqual(listening.fleet.members.view().refused, [], "refused before any announcement was read");
  } finally {
    await stranger.fleet.stop();
    await listening.fleet.stop();
  }
});

test("a member reads the list over the transport; an announcement over the size cap is refused unread", async () => {
  const { listening, announcing } = await pair();
  try {
    assert.ok(await announcing.fleet.start());
    await until("listed", () => listed(listening).includes("thor"));
    const { fleetCall } = await import("../../src/fleet/transport.js");
    const trust = loadTrust(join(announcing.dir, "trust.json"));
    const call = { key: announcing.key, trust, host: LOOPBACK, port: listening.port() } as const;
    const res = await fleetCall({ ...call, method: "GET", path: "/v1/fleet/members" });
    assert.equal(res.status, 200);
    assert.deepEqual((JSON.parse(res.body.toString()) as { members: { node: string }[] }).members.map((m) => m.node), ["thor"]);
    const big = await fleetCall({ ...call, method: "POST", path: "/v1/fleet/announce", body: JSON.stringify({ node: "thor", pad: "x".repeat(20_000) }) });
    assert.equal(big.status, 400);
  } finally {
    await announcing.fleet.stop();
    await listening.fleet.stop();
  }
});
