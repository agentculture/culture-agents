/** t8: the operator's limits are read from the core's config file; none applies by default. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { LimitsConfigError, loadLimits } from "../../src/daemon/limits.js";
import { HANG, makeEnv, startDaemon, writeLimits } from "../runs/support.js";

function configHome(t: TestContext, file?: unknown): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "ca-limits-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "culture-agents"));
  if (file !== undefined) writeFileSync(join(root, "culture-agents", "harness.json"), typeof file === "string" ? file : JSON.stringify(file));
  return { XDG_CONFIG_HOME: root, HOME: root };
}

test("no config file, or a file without limits, means no limit", (t) => {
  assert.deepEqual(loadLimits(configHome(t)), { runs_per_repository: null, runs_per_host: null });
  assert.deepEqual(loadLimits(configHome(t, { stub: true })), { runs_per_repository: null, runs_per_host: null });
  assert.deepEqual(loadLimits(configHome(t, { limits: { runsPerRepository: null } })), { runs_per_repository: null, runs_per_host: null });
});

test("configured limits are read from the file, including one named by CULTURE_AGENTS_HARNESS_CONFIG", (t) => {
  assert.deepEqual(loadLimits(configHome(t, { limits: { runsPerRepository: 2, runsPerHost: 8 } })), { runs_per_repository: 2, runs_per_host: 8 });
  const home = configHome(t);
  const explicit = join(home["XDG_CONFIG_HOME"] as string, "other.json");
  writeFileSync(explicit, JSON.stringify({ limits: { runsPerHost: 3 } }));
  assert.deepEqual(loadLimits({ ...home, CULTURE_AGENTS_HARNESS_CONFIG: explicit }), { runs_per_repository: null, runs_per_host: 3 });
});

test("a limit that is not a positive whole number, or an unknown limit key, is a configuration error", (t) => {
  for (const bad of [0, -1, 1.5, "2", true, {}]) {
    assert.throws(() => loadLimits(configHome(t, { limits: { runsPerRepository: bad } })), LimitsConfigError, JSON.stringify(bad));
  }
  assert.throws(() => loadLimits(configHome(t, { limits: { runsPerAgent: 1 } })), /runsPerAgent/);
  assert.throws(() => loadLimits(configHome(t, { limits: [1] })), LimitsConfigError);
  assert.throws(() => loadLimits(configHome(t, "{not json")), LimitsConfigError);
});

test("the daemon refuses to start with an unusable limit and names it", async (t) => {
  const env = makeEnv(t, [HANG]);
  writeLimits(env, { runsPerHost: 0 });
  await assert.rejects(startDaemon(t, env), /runsPerHost/);
});
