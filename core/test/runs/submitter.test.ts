import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Run } from "../../src/contract/index.js";
import { HANG, getRun, makeEnv, ok, refused, startDaemon, submit, submitBody, waitFor } from "./support.js";

const uid = process.getuid?.() ?? 0;

test("a run submitted over the socket records the user that owns the socket, and no request field changes it", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  assert.equal(statSync(env.socket).uid, uid);
  const run = await submit(env, "fake", env.repoA);
  assert.equal(run.submitter?.kind, "local_user");
  assert.equal(run.submitter?.uid, uid);
  assert.equal((await getRun(env, run.id)).submitter?.uid, uid, "it survives in the stored record");
  assert.equal(run.owner?.id, "thor-operator", "the caller field is a separate, unauthenticated value");

  // A forged submitter in the body is refused or ignored; either way the recorded one is the socket owner's.
  const forged = { kind: "member", node: "thor" };
  const reply = await ok<{ run: Run }>(env, "POST", "/v1/runs", 201, "control-action#submit_response", submitBody("fake", env.repoB, { submitter: { kind: "local_user", uid: uid + 1 } })).catch(
    () => null,
  );
  if (reply !== null) assert.equal(reply.run.submitter?.uid, uid);
  else await refused(env, "POST", "/v1/runs", "invalid", submitBody("fake", env.repoB, { submitter: forged }));
  assert.equal((await getRun(env, run.id)).submitter?.kind, "local_user");
});

test("the daemon refuses to start with a socket directory that other users can reach", async (t) => {
  const env = makeEnv(t, [HANG]);
  mkdirSync(dirname(env.socket), { recursive: true, mode: 0o755 });
  const script = join(dirname(fileURLToPath(import.meta.url)), "child.js");
  const out = spawnSync(process.execPath, [script], { env: { ...process.env, ...env.vars }, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /mode 0700|accessible to other users/);
});

test("the socket is mode 0600 in a 0700 directory it created", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  assert.equal(statSync(env.socket).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(env.socket)).mode & 0o777, 0o700);
});

/** Listening TCP sockets owned by `pid`, from /proc (Linux). */
function listeningTcp(pid: number): string[] {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
    if (m?.[1]) inodes.add(m[1]);
  }
  const found: string[] = [];
  for (const table of ["tcp", "tcp6"]) {
    for (const line of readFileSync(`/proc/net/${table}`, "utf8").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[3] === "0A" && f[9] !== undefined && inodes.has(f[9])) found.push(`${table} ${f[1]}`);
    }
  }
  return found;
}

test("with no network transport the core opens no TCP port, and no route reads or writes the allow-list", async (t) => {
  const env = makeEnv(t, [HANG]);
  const daemon = await startDaemon(t, env);
  const allowlist = join(env.vars["XDG_CONFIG_HOME"] ?? "", "culture-agents", "allowlist.json");
  const digest = (): string => createHash("sha256").update(readFileSync(allowlist)).digest("hex");
  const before = digest();
  const run = await submit(env, "fake", env.repoA);
  await waitFor(() => listeningTcp(daemon.proc.pid ?? 0).length === 0, 2000, "no listening TCP");
  assert.deepEqual(listeningTcp(daemon.proc.pid ?? 0), []);
  // No route serves or accepts the allow-list, and the file is untouched by the routes that exist.
  for (const method of ["GET", "POST"]) {
    for (const path of ["/v1/allowlist", "/v1/allow-list", "/v1/config/allowlist"]) await refused(env, method, path, "not_found", method === "GET" ? undefined : { version: 1, entries: [] });
  }
  await ok(env, "GET", `/v1/runs/${run.id}`, 200, "run");
  await ok(env, "GET", "/v1/runs", 200, "run#run_list");
  assert.equal(digest(), before);
});
