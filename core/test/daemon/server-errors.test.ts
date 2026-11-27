/** The daemon's servers after `listen`: a late `error` event is logged, and a failed bind leaves the umask alone. */
import assert from "node:assert/strict";
import { Server } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { startDaemon } from "../../src/daemon/daemon.js";
import { FakeRunService } from "./fake-service.js";
import { makeEnv } from "./harness.js";

/** The process umask, read without changing it. */
function currentUmask(): number {
  const mask = process.umask(0o022);
  process.umask(mask);
  return mask;
}

type Listen = (this: Server, ...args: unknown[]) => Server;

/** Wrap `net.Server.prototype.listen` for one test (the HTTP server inherits it). */
function wrapListen(t: TestContext, wrap: (real: Listen) => Listen): void {
  const real = Server.prototype.listen as unknown as Listen;
  Server.prototype.listen = wrap(real) as unknown as typeof Server.prototype.listen;
  t.after(() => {
    Server.prototype.listen = real as unknown as typeof Server.prototype.listen;
  });
}

test("an error event on either listening server is logged in one line and never thrown", async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const servers: Server[] = [];
  wrapListen(t, (real) => function (this: Server, ...args: unknown[]) {
    servers.push(this);
    return real.apply(this, args);
  });
  const daemon = await startDaemon({ service: new FakeRunService(), node: "thor", env: env.vars });
  t.after(() => daemon.stop());
  assert.equal(servers.length, 2, "the instance lock socket and the control socket server");

  const lines: string[] = [];
  const write = t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  // With no `error` listener, `emit` throws its argument: that would be an uncaught exception in the core.
  for (const server of servers) assert.doesNotThrow(() => server.emit("error", new Error("late failure")));
  write.mock.restore();
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /^culture-agents core: the instance lock socket reported an error: late failure\n$/);
  assert.match(lines[1] ?? "", /^culture-agents core: the control socket server reported an error: late failure\n$/);
});

test("a socket path over the limit is refused with a clear error and the umask is unchanged", async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const before = currentUmask();
  const socket = join(env.root, "run", `${"s".repeat(120)}.sock`);
  await assert.rejects(
    startDaemon({ service: new FakeRunService(), node: "thor", env: { ...env.vars, CULTURE_AGENTS_SOCKET: socket } }),
    (e: Error) => /at most 107 bytes/.test(e.message) && e.message.includes("CULTURE_AGENTS_SOCKET") && e.message.includes(socket),
  );
  assert.equal(currentUmask(), before);
});

test("a listen that throws instead of emitting an error still restores the umask and releases the lock", async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const before = currentUmask();
  let fail = true;
  wrapListen(t, (real) => function (this: Server, ...args: unknown[]) {
    // The control socket is bound by path string; the instance lock passes an options object.
    if (fail && typeof args[0] === "string") throw Object.assign(new Error("listen EINVAL: invalid argument"), { code: "EINVAL" });
    return real.apply(this, args);
  });
  await assert.rejects(startDaemon({ service: new FakeRunService(), node: "thor", env: env.vars }), /EINVAL/);
  assert.equal(currentUmask(), before, "the umask is not left at 0177");
  fail = false;
  const daemon = await startDaemon({ service: new FakeRunService(), node: "thor", env: env.vars });
  await daemon.stop();
});
