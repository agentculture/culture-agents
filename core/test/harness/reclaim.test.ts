/** Sandboxes of finished runs are reclaimed: the registry asks the gateway, the run service names its finished runs. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadHarnessConfig } from "../../src/harness/index.js";
import { reclaimSandboxes } from "../../src/harness/reclaim.js";
import { emptyCatalog } from "../../src/runs/ports.js";
import { createRunService } from "../../src/runs/index.js";
import { followEvents } from "../../src/store/run-store.js";
import { spawnWorker } from "../../src/worker/spawn.js";
import type { RunSandboxes } from "../../src/sandbox/index.js";
import { fakeDriver, killAfter, newRun, stateDir } from "../worker/helpers.js";

test("reclaimSandboxes sweeps only the given run ids, on the configured gateway and prefix", async () => {
  const config = loadHarnessConfig({ CULTURE_AGENTS_GATEWAY_TLS_DIR: "/tls", CULTURE_AGENTS_SANDBOX_PREFIX: "t-", HOME: "/nonexistent" });
  const seen: unknown[] = [];
  const open = async (cfg: unknown, gateway: unknown) => {
    seen.push(cfg, gateway);
    return { sweep: async (keep: Iterable<string>, only?: Iterable<string>) => (seen.push([...keep], [...(only ?? [])]), ["r1"]) } as unknown as RunSandboxes;
  };
  assert.deepEqual(await reclaimSandboxes(config, ["r1", "r2"], open), ["r1"]);
  assert.deepEqual(seen, [{ image: config.image, providers: [], prefix: "t-" }, { gateway: config.gateway.endpoint, tlsDir: "/tls" }, [], ["r1", "r2"]]);
});

test("reclaimSandboxes does nothing without finished runs or without a gateway TLS directory", async () => {
  const fail = async (): Promise<RunSandboxes> => assert.fail("the gateway must not be contacted");
  const withTls = loadHarnessConfig({ CULTURE_AGENTS_GATEWAY_TLS_DIR: "/tls", HOME: "/nonexistent" });
  assert.deepEqual(await reclaimSandboxes(withTls, [], fail), []);
  assert.deepEqual(await reclaimSandboxes(loadHarnessConfig({ HOME: "/nonexistent" }), ["r1"], fail), []);
});

test("the run service asks to reclaim exactly its finished runs", async (t) => {
  const dir = stateDir(t);
  const done = newRun();
  const active = newRun();
  for (const [run, steps] of [[done, [{ op: "started" }, { op: "completed" }]], [active, [{ op: "started" }, { op: "hang" }]]] as const) {
    const worker = await spawnWorker({ stateDir: dir, run, driver: fakeDriver({ steps: [...steps] }), heartbeatMs: 50 });
    killAfter(t, worker.pid, worker.runDir);
    if (run === done) for await (const e of followEvents(worker.runDir, run.id, 0, { pollMs: 5, orphanCheckMs: 0, signal: AbortSignal.timeout(5000) })) void e;
  }
  const asked: string[][] = [];
  const catalog = { ...emptyCatalog(), reclaim: async (ids: string[]) => (asked.push(ids), ids) };
  const service = createRunService({ stateDir: dir, node: "spark", catalog, allowlist: () => ({ path: "", status: "missing", entries: [], detail: null }) });
  assert.deepEqual(await service.reclaim(), [done.id]);
  assert.deepEqual(asked, [[done.id]]);
  assert.deepEqual(await createRunService({ stateDir: dir, node: "spark", catalog: emptyCatalog(), allowlist: () => ({ path: "", status: "missing", entries: [], detail: null }) }).reclaim(), []);
});
