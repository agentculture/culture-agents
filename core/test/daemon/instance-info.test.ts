/**
 * What a second instance reads about the running one: retried briefly, because the holder writes
 * its info file just after taking the lock.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readInstanceInfo, writeInstanceInfo } from "../../src/daemon/lock.js";
import { resolvePaths } from "../../src/daemon/paths.js";

/** A pid no process has: above the kernel's largest. */
const DEAD_PID = 2 ** 30;

function scratch(t: { after: (fn: () => void) => void }): ReturnType<typeof resolvePaths> {
  const dir = mkdtempSync(join(tmpdir(), "culture-agents-info-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return resolvePaths({ CULTURE_AGENTS_SOCKET: join(dir, "core.sock") });
}

test("readInstanceInfo returns the info of a live instance on the first read", async (t) => {
  const paths = scratch(t);
  const info = { pid: process.pid, api_version: "2.0", socket: paths.socket };
  writeInstanceInfo(paths, info);
  assert.deepEqual(await readInstanceInfo(paths, 1, 1), info);
});

test("readInstanceInfo gives up with null after its attempts: no file, a dead pid, or a partial file", async (t) => {
  const paths = scratch(t);
  assert.equal(await readInstanceInfo(paths, 3, 1), null);
  writeInstanceInfo(paths, { pid: DEAD_PID, api_version: "2.0", socket: paths.socket });
  assert.equal(await readInstanceInfo(paths, 3, 1), null);
  writeFileSync(paths.info, '{"pid": ');
  assert.equal(await readInstanceInfo(paths, 3, 1), null);
});

test("readInstanceInfo keeps reading until the holder has written its file", async (t) => {
  const paths = scratch(t);
  const info = { pid: process.pid, api_version: "2.0", socket: paths.socket };
  const pending = readInstanceInfo(paths, 200, 5);
  setTimeout(() => writeInstanceInfo(paths, info), 30);
  assert.deepEqual(await pending, info);
});
