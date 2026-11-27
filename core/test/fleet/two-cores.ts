// Two real cores for the end-to-end fleet tests (t23, t25): each is the real `main` in its own process
// with the fleet transport on. The executing core is thor; the calling core is CALLER_NODE, filler that
// names no host.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { MemberList } from "../../src/contract/index.js";
import { certificateFor, fleetKeyText, newFleetKey } from "../../src/fleet/cert.js";
import { call } from "../daemon/harness.js";
import { HANG, makeEnv, startDaemon, waitFor, type Daemon, type Env } from "../runs/support.js";
import { ALIAS, CALLER_NODE } from "./remote-support.js";

function fleetEnv(env: Env, node: string, key: KeyObject, trusted: [string, KeyObject][]): string {
  const dir = join(env.vars["XDG_CONFIG_HOME"] ?? "", "culture-agents", "fleet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "trust.json"), JSON.stringify(trusted.map(([name, k]) => ({ node: name, cert: certificateFor(k).text }))));
  Object.assign(env.vars, { TEST_NODE: node, CULTURE_AGENTS_FLEET_LISTEN: "127.0.0.1:0", CULTURE_AGENTS_FLEET_KEY: fleetKeyText(key) });
  return dir;
}

function portOf(daemon: Daemon): number {
  const m = /fleet transport listening on 127\.0\.0\.1:(\d+)/.exec(daemon.stderr());
  assert.ok(m, daemon.stderr());
  return Number(m[1]);
}

export async function twoCores(t: TestContext): Promise<{ thor: Env; caller: Env; thorDaemon: Daemon }> {
  const thorKey = newFleetKey();
  const callerKey = newFleetKey();
  const thor = makeEnv(t, [HANG]);
  const thorFleet = fleetEnv(thor, "thor", thorKey, [[CALLER_NODE, callerKey]]);
  writeFileSync(join(thorFleet, "aliases.json"), JSON.stringify({ version: 1, aliases: [{ alias: ALIAS, repo: thor.repoA }] }));
  const thorDaemon = await startDaemon(t, thor);
  await waitFor(() => /fleet transport listening/.test(thorDaemon.stderr()), 10_000, "thor's fleet transport");
  const caller = makeEnv(t, null);
  const callerFleet = fleetEnv(caller, CALLER_NODE, callerKey, [["thor", thorKey]]);
  writeFileSync(join(callerFleet, "peers.json"), JSON.stringify([`127.0.0.1:${portOf(thorDaemon)}`]));
  await startDaemon(t, caller); // it announces itself to thor at once; thor's reply lists thor
  const listed = async (): Promise<boolean> => ((await call(caller.socket, "GET", "/v1/fleet/members")).json as MemberList).members.some((m) => m.node === "thor");
  await waitFor(listed, 10_000, "the caller to list thor");
  return { thor, caller, thorDaemon };
}

