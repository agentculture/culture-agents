import assert from "node:assert/strict";
import { test } from "node:test";

import { resolvePaths, resolveSocketPath } from "../../src/daemon/paths.js";

test("the socket path: the override, then the runtime directory, then the per-user state directory", () => {
  const home = { HOME: "/home/u" };
  assert.deepEqual(resolveSocketPath({ CULTURE_AGENTS_SOCKET: "/x/y.sock", XDG_RUNTIME_DIR: "/run/u" }), { path: "/x/y.sock", overridden: true });
  assert.equal(resolveSocketPath({ XDG_RUNTIME_DIR: "/run/u", ...home }).path, "/run/u/culture-agents/core.sock");
  assert.equal(resolveSocketPath(home).path, "/home/u/.local/state/culture-agents/core.sock");
  assert.equal(resolveSocketPath({ XDG_RUNTIME_DIR: "", ...home }).path, "/home/u/.local/state/culture-agents/core.sock");
  assert.equal(resolveSocketPath({ XDG_STATE_HOME: "/s", ...home }).path, "/s/culture-agents/core.sock");
  assert.equal(resolveSocketPath({ XDG_STATE_HOME: "relative", ...home }).path, "/home/u/.local/state/culture-agents/core.sock");
});

test("the fallback is never under a shared directory, and the lock and info files sit beside the socket", () => {
  const paths = resolvePaths({ HOME: "/home/u" });
  assert.ok(!paths.socket.startsWith("/tmp"));
  assert.equal(paths.dir, "/home/u/.local/state/culture-agents");
  assert.equal(paths.lock, `${paths.socket}.lock`);
  assert.equal(paths.info, `${paths.socket}.pid`);
  assert.equal(paths.overridden, false);
});
