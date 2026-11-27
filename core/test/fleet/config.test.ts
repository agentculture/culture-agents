// Acceptance 3 of t21: the transport is off unless configured, and nothing reads the chat mesh's link
// password. The core is started for real (in a child process) with the transport off and on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { fleetKeyText, newFleetKey } from "../../src/fleet/cert.js";
import { FLEET_LISTEN_ENV, FleetConfigError, loadFleetConfig, parseListen } from "../../src/fleet/config.js";
import { resolveTrustPath } from "../../src/fleet/trust.js";
import { makeEnv } from "../daemon/harness.js";
import { tmp, writeTrust } from "./support.js";

const t = tmp();
after(() => t.cleanup());
const CHILD = fileURLToPath(new URL("./fleet-child.js", import.meta.url));
const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** An environment that records every variable read from it. */
function recording(vars: Record<string, string>): { env: Record<string, string | undefined>; read: Set<string> } {
  const read = new Set<string>();
  const env = new Proxy(vars as Record<string, string | undefined>, {
    get: (target, prop) => {
      if (typeof prop === "string") read.add(prop);
      return target[prop as string];
    },
  });
  return { env, read };
}

test("the transport is off unless a listen address is configured, even with a key held", () => {
  const { env, read } = recording({ CULTURE_MESH_LINK_PASSWORD: "decoy", HOME: "/nonexistent" });
  assert.equal(loadFleetConfig(env, fleetKeyText(newFleetKey())), null);
  assert.deepEqual([...read], [FLEET_LISTEN_ENV], "only the listen variable was read");
  assert.equal(loadFleetConfig({ [FLEET_LISTEN_ENV]: "  " }, undefined), null);
});

test("a configured transport reads the listen address, the trust file and the held key, and nothing else", () => {
  const configHome = join(t.dir, "config");
  writeTrust(resolveTrustPath({ XDG_CONFIG_HOME: configHome }), [newFleetKey()]);
  const { env, read } = recording({ [FLEET_LISTEN_ENV]: "127.0.0.1:0", XDG_CONFIG_HOME: configHome, CULTURE_MESH_LINK_PASSWORD: "decoy" });
  const config = loadFleetConfig(env, fleetKeyText(newFleetKey()));
  assert.equal(config?.trust.length, 1);
  assert.deepEqual([...read].sort(), [FLEET_LISTEN_ENV, "XDG_CONFIG_HOME"]);
});

test("no core source names the chat mesh's configuration or link password", () => {
  const pattern = /mesh\.yaml|LINK_PASS|link_password|linkPassword|keyring|\bPASS /;
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
  const hits = walk(SRC).filter((f) => f.endsWith(".js") && pattern.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});

test("a listen address must be an IP literal with a port", () => {
  assert.deepEqual(parseListen("127.0.0.1:7000"), { host: "127.0.0.1", port: 7000 });
  assert.deepEqual(parseListen("[::1]:0"), { host: "::1", port: 0 });
  for (const bad of ["localhost:7000", "127.0.0.1", "127.0.0.1:99999", "::1:7000", "thor:7000"]) assert.throws(() => parseListen(bad), FleetConfigError, bad);
});

test("a configured transport without a key, with a bad key or with a bad trust list is refused without printing the key", () => {
  const configHome = join(t.dir, "config-bad");
  const env = { [FLEET_LISTEN_ENV]: "127.0.0.1:0", XDG_CONFIG_HOME: configHome };
  assert.throws(() => loadFleetConfig(env, undefined), /CULTURE_AGENTS_FLEET_KEY is not/);
  assert.throws(() => loadFleetConfig(env, "ed25519:c2VjcmV0LXZhbHVl"), (e: unknown) => e instanceof FleetConfigError && !e.message.includes("c2VjcmV0LXZhbHVl"));
  writeTrust(resolveTrustPath(env), [newFleetKey(), newFleetKey()]);
  assert.throws(() => loadFleetConfig(env, fleetKeyText(newFleetKey())), /two keys/);
});

interface ChildResult {
  code: number | null;
  stderr: string;
  out: Record<string, unknown>;
}

async function runCore(extra: Record<string, string>, mode: string): Promise<ChildResult> {
  const env = makeEnv();
  try {
    const child = spawn(process.execPath, [CHILD, mode, env.configHome], { env: { ...process.env, ...env.vars, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    return { code, stderr, out: JSON.parse(out.trim().split("\n").pop() || "{}") as Record<string, unknown> };
  } finally {
    env.cleanup();
  }
}

test("a core started without a listen address opens no fleet transport", async () => {
  const r = await runCore({ CULTURE_AGENTS_FLEET_KEY: fleetKeyText(newFleetKey()) }, "off");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stderr.includes("fleet transport"), r.stderr);
  assert.equal(r.out["keyInCoreEnv"], false);
});

test("a core with the transport on serves a member, and its key has left the environment of the core, host commands and workers", async () => {
  const key = fleetKeyText(newFleetKey());
  const r = await runCore({ CULTURE_AGENTS_FLEET_KEY: key, [FLEET_LISTEN_ENV]: "127.0.0.1:0" }, "on");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out["status"], 200, r.stderr);
  assert.equal(r.out["keyInCoreEnv"], false);
  assert.equal(r.out["keyInHostEnv"], false);
  assert.equal(r.out["keyInWorkerEnv"], false);
  assert.ok(!r.stderr.includes(key.slice(8)), "the key is never logged");
});

test("a core with the transport configured wrongly stops before its Unix socket listens", async () => {
  const key = "ed25519:c2VjcmV0LXZhbHVlLW5vdC1hLWtleQ==";
  const r = await runCore({ CULTURE_AGENTS_FLEET_KEY: key, [FLEET_LISTEN_ENV]: "127.0.0.1:0" }, "bad");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot start: fleet transport/);
  assert.ok(!r.stderr.includes("listening on"), r.stderr);
  assert.ok(!r.stderr.includes(key.slice(8)), "the key is never logged");
});
