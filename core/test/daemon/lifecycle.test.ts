import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { apiVersion } from "../../src/contract/index.js";
import { call, makeEnv, spawnDaemon, waitFor, type Child, type Env } from "./harness.js";

const envs: Env[] = [];
const children: Child[] = [];
function fresh(): Env {
  const env = makeEnv();
  envs.push(env);
  return env;
}
function start(env: Env): Child {
  const child = spawnDaemon(env);
  children.push(child);
  return child;
}
async function ready(env: Env, child: Child): Promise<void> {
  await Promise.race([
    waitFor(() => existsSync(env.socket)).then(async () => {
      await waitFor(() => /listening/.test(child.stderr()));
    }),
    child.exited.then((x) => {
      throw new Error(`daemon exited early (${x.code}): ${child.stderr()}`);
    }),
  ]);
}

after(() => {
  for (const c of children) c.proc.kill("SIGKILL");
  for (const e of envs) e.cleanup();
});

test("the socket is mode 0600 inside a 0700 directory and /v1/version reports the contract's API version", async () => {
  const env = fresh();
  const child = start(env);
  await ready(env, child);
  assert.equal(statSync(env.socket).mode & 0o777, 0o600);
  assert.equal(statSync(env.socket).isSocket(), true);
  assert.equal(statSync(dirname(env.socket)).mode & 0o777, 0o700);
  const reply = await call(env.socket, "GET", "/v1/version", { version: null });
  assert.equal(reply.status, 200);
  assert.equal((reply.json as { api_version: string }).api_version, apiVersion);
  const info = JSON.parse(readFileSync(`${env.socket}.pid`, "utf8")) as { pid: number; api_version: string };
  assert.equal(info.pid, child.proc.pid);
  assert.equal(info.api_version, apiVersion);
});

test("a second start exits 2 and names the running instance's pid", async () => {
  const env = fresh();
  const first = start(env);
  await ready(env, first);
  const second = start(env);
  const exit = await second.exited;
  assert.equal(exit.code, 2);
  assert.match(second.stderr(), new RegExp(`already running \\(pid ${first.proc.pid}`));
  // The first is unharmed.
  assert.equal((await call(env.socket, "GET", "/v1/version")).status, 200);
});

test("after kill -9 a new start succeeds with no manual cleanup", async () => {
  const env = fresh();
  const first = start(env);
  await ready(env, first);
  first.proc.kill("SIGKILL");
  assert.equal((await first.exited).signal, "SIGKILL");
  // The dead core left its socket and info file behind; nothing else was cleaned up.
  assert.equal(existsSync(env.socket), true);
  const second = start(env);
  await ready(env, second);
  const reply = await call(env.socket, "GET", "/v1/version");
  assert.equal(reply.status, 200);
  const info = JSON.parse(readFileSync(`${env.socket}.pid`, "utf8")) as { pid: number };
  assert.equal(info.pid, second.proc.pid);
  assert.equal(statSync(env.socket).mode & 0o777, 0o600);
});

test("SIGTERM stops cleanly: exit 0, socket and info file removed, a new instance can start", async () => {
  const env = fresh();
  const first = start(env);
  await ready(env, first);
  first.proc.kill("SIGTERM");
  assert.equal((await first.exited).code, 0);
  assert.equal(existsSync(env.socket), false);
  assert.equal(existsSync(`${env.socket}.pid`), false);
  const second = start(env);
  await ready(env, second);
  second.proc.kill("SIGINT");
  assert.equal((await second.exited).code, 0);
});

test("a regular file at the socket path is never removed", async () => {
  const env = fresh();
  mkdirSync(dirname(env.socket), { recursive: true });
  writeFileSync(env.socket, "not a socket");
  const child = start(env);
  const exit = await child.exited;
  assert.equal(exit.code, 2);
  assert.match(child.stderr(), /not a socket/);
  assert.equal(readFileSync(env.socket, "utf8"), "not a socket");
});

for (const [signal, what] of [
  ["SIGUSR2", /fatal: uncaught exception: boom from a callback/],
  ["SIGUSR1", /fatal: unhandled promise rejection: rejected and never handled/],
] as const) {
  test(`a fatal error (${signal} in the test child) is logged, the daemon stops cleanly and exits 2`, async () => {
    const env = fresh();
    const first = start(env);
    await ready(env, first);
    first.proc.kill(signal);
    const exit = await first.exited;
    assert.equal(exit.code, 2, first.stderr());
    assert.equal(first.stderr().split("\n").filter((line) => /culture-agents core: fatal:/.test(line)).length, 1);
    assert.match(first.stderr(), what);
    assert.equal(existsSync(env.socket), false, "the socket was removed");
    assert.equal(existsSync(`${env.socket}.pid`), false, "the info file was removed");
    const second = start(env);
    await ready(env, second);
    assert.equal((await call(env.socket, "GET", "/v1/version")).status, 200);
  });
}

test("a socket path longer than a Unix socket allows is refused with exit 2, naming the limit and the variable", async () => {
  const env = fresh();
  env.vars["CULTURE_AGENTS_SOCKET"] = join(env.root, "run", `${"s".repeat(120)}.sock`);
  const child = start(env);
  const exit = await child.exited;
  assert.equal(exit.code, 2);
  assert.match(child.stderr(), /cannot start: the control socket path is \d+ bytes, but a Unix socket path can be at most 107 bytes/);
  assert.match(child.stderr(), /CULTURE_AGENTS_SOCKET/);
  assert.doesNotMatch(child.stderr(), /EINVAL/);
});
