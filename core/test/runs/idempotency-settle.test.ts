/**
 * Idempotency keys whose outcome is not known yet, and keys at start-up (review of pull request
 * 15). The run service runs in-process over the real store and real fake-driver workers, so a test
 * can make a steer slower than its (shortened) steer timeout and read the keys directory directly.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ActionRecord, Capabilities, ErrorBody, RunEvent } from "../../src/contract/index.js";
import { createRunService, type RunServiceOptions } from "../../src/runs/index.js";
import type { HarnessCatalog } from "../../src/runs/ports.js";
import { readLog } from "../../src/store/event-log.js";
import { runDir } from "../../src/store/files.js";
import { KeyIndex, keysDir, recoverKeys } from "../../src/store/idempotency.js";
import { listRunIds } from "../../src/store/run-store.js";
import { AGENT, CALLER, HANG, makeEnv, waitFor, type Env } from "./support.js";

const FAKE_DRIVER = fileURLToPath(new URL("../../src/worker/fake-driver.js", import.meta.url));
const yes = { supported: true, reason: null, caveats: [] };
const no = { supported: false as const, reason: "deferred", caveats: [] };
const capabilities: Capabilities = {
  harness: "fake",
  available: true,
  version: "0.0.0-test",
  transport: "scripted fake driver",
  capabilities: { submit: yes, stream: yes, steer: yes, cancel: yes, pause: no, resume: no, answer: no, continue_session: no, delegate: no, placement: no, reconnect: yes, worktree_isolation: no },
};

function service(env: Env, driver: Record<string, unknown> = {}, extra: Partial<RunServiceOptions> = {}): ReturnType<typeof createRunService> {
  const entry = { id: "fake", capabilities: () => Promise.resolve(capabilities), driver: { module: FAKE_DRIVER, options: { steps: HANG.steps, ...driver } } };
  const catalog: HarnessCatalog = { list: () => [entry], get: () => entry };
  return createRunService({ stateDir: env.stateDir, node: "thor", catalog, allowlist: () => ({ status: "ok", entries: [] }) as never, warn: () => undefined, ...extra });
}

const keyFile = (env: Env, scope: string, key: string) => join(keysDir(env.stateDir), `${scope}-${createHash("sha256").update(key).digest("hex")}.json`);
const logOf = (env: Env, id: string): RunEvent[] => readLog(runDir(env.stateDir, id), id).events;
const steers = (log: RunEvent[]) => log.filter((e) => e.kind === "run.control" && (e.data as { action: ActionRecord }).action.kind === "steer");
const echoes = (log: RunEvent[]) => log.filter((e) => e.kind === "run.output" && (e.data as { text: string }).text.startsWith("steer: "));
const refusal = (p: Promise<unknown>): Promise<ErrorBody> =>
  p.then(
    () => assert.fail("expected a refusal"),
    (e: { body: ErrorBody }) => e.body,
  );

async function running(svc: ReturnType<typeof createRunService>, env: Env, key?: string): Promise<string> {
  const made = await svc.submit({ agent_id: AGENT, harness: "fake", repo: env.repoA, task: "Do the thing.", caller: CALLER, ...(key !== undefined && { idempotency_key: key }) } as never);
  await waitFor(async () => (await svc.getRun(made.run.id))?.state === "running", 8000, "running");
  return made.run.id;
}

test("a steer slower than the steer timeout keeps its key reserved: a repeat is unavailable, never delivered again, then replayed", async (t) => {
  const env = makeEnv(t, [HANG]);
  const svc = service(env, { steerDelayMs: 1500 }, { worker: { steerTimeoutMs: 200 } });
  const id = await running(svc, env);
  const steer = { caller: CALLER, message: "go left", idempotency_key: "slow-1" };

  const first = await refusal(svc.steer(id, steer));
  assert.equal(first.code, "unavailable");
  assert.ok(existsSync(keyFile(env, "steer", "slow-1")), "the key of a steer whose outcome is unknown stays");
  const second = await refusal(svc.steer(id, steer));
  assert.equal(second.code, "unavailable");
  assert.equal(second.retry_after_ms, 500, "a repeat is told to retry");

  await waitFor(() => steers(logOf(env, id)).length > 0, 8000, "the first steer to be recorded");
  const third = await svc.steer(id, steer);
  assert.equal(third.replayed, true);
  assert.equal(third.action.id, (steers(logOf(env, id))[0]?.data as { action: ActionRecord }).action.id);
  await new Promise((resolve) => setTimeout(resolve, 1800)); // longer than one more delivery would take
  assert.equal(steers(logOf(env, id)).length, 1, "1 run.control steer");
  assert.equal(echoes(logOf(env, id)).length, 1, "the harness got the steer once");
  assert.equal(JSON.parse(readFileSync(keyFile(env, "steer", "slow-1"), "utf8")).state, "established");
  await svc.cancel(id, { caller: CALLER });
});

test("a steer the harness refused after the timeout releases its key once the log shows the refusal", async (t) => {
  const env = makeEnv(t, [HANG]);
  const svc = service(env, { steerDelayMs: 600, steerError: "no thanks" }, { worker: { steerTimeoutMs: 200 } });
  const id = await running(svc, env);
  const steer = { caller: CALLER, message: "go left", idempotency_key: "slow-refused" };
  assert.equal((await refusal(svc.steer(id, steer))).code, "unavailable");
  await waitFor(() => logOf(env, id).some((e) => e.kind === "run.error"), 8000, "the refusal in the log");
  // The repeat settles the key from the log (released) and is delivered afresh, refused again.
  assert.equal((await refusal(svc.steer(id, steer))).code, "unavailable");
  await svc.cancel(id, { caller: CALLER });
});

test("after a core crash during a delivery, start-up keeps the key of a live worker's action reserved", async (t) => {
  const env = makeEnv(t, [HANG]);
  const svc = service(env);
  const id = await running(svc, env);
  // What a core that died between writing the key and the worker's run.control leaves behind.
  const keys = new KeyIndex(env.stateDir);
  for (const scope of ["steer", "cancel"] as const) {
    const action: ActionRecord = { id: `${AGENT}.action.01JDQ5V7M2K8X9Y0Z1A2B3C4D${scope === "steer" ? "5" : "6"}` as never, run_id: id as never, kind: scope, caller: CALLER, requested_at: new Date().toISOString(), idempotency_key: `crash-${scope}`, outcome: "accepted", error: null };
    keys.put({ scope, key: `crash-${scope}`, digest: "sha256:x", run_id: id as never, state: "reserved", action, recorded_at: action.requested_at });
  }
  const report = recoverKeys(keys);
  assert.deepEqual(report.released, [], "nothing released while the worker may still deliver");
  assert.ok(existsSync(keyFile(env, "steer", "crash-steer")));
  assert.ok(existsSync(keyFile(env, "cancel", "crash-cancel")));
  await svc.cancel(id, { caller: CALLER });
});

test("a run the start-up scan cannot read keeps its submit key; a repeat after it reads again replays", async (t) => {
  const env = makeEnv(t, [HANG]);
  const first = service(env);
  const id = await running(first, env, "unreadable-1");
  const log = join(runDir(env.stateDir, id), "events.jsonl");
  const good = readFileSync(log);
  writeFileSync(log, Buffer.concat([good, Buffer.from("{not json}\n")])); // one read error during reconcile
  const second = service(env, {}, { reattachWaitMs: 2000 });
  second.reconcile();
  assert.ok(existsSync(keyFile(env, "submit", "unreadable-1")), "an unreadable run is not a run that left the store");
  writeFileSync(log, good);
  const again = await second.submit({ agent_id: AGENT, harness: "fake", repo: env.repoA, task: "Do the thing.", caller: CALLER, idempotency_key: "unreadable-1" } as never);
  assert.equal(again.replayed, true);
  assert.equal(again.run.id, id);
  assert.deepEqual(listRunIds(env.stateDir), [id], "1 run for 1 key");
});

test("start-up removes temp files a crash left in the keys directory", (t) => {
  const env = makeEnv(t, [HANG]);
  const keys = new KeyIndex(env.stateDir);
  keys.put({ scope: "submit", key: "k", digest: "sha256:x", run_id: `${AGENT}.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5` as never, state: "reserved", action: null, recorded_at: new Date().toISOString() });
  const stale = `${keyFile(env, "submit", "k")}.tmp-4242-7`;
  writeFileSync(stale, "{");
  service(env).reconcile();
  assert.equal(existsSync(stale), false, "the stale temp file is gone");
});
