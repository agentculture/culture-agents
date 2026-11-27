/**
 * Idempotent submit, steer and cancel over the real daemon, the real store and real workers
 * (plan t6). Keys live in `<stateDir>/keys/`; a restart is a SIGKILL of the core and a new one.
 * A submit is killed at each of its steps through the child's SUBMIT_FAULT injection point.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

import { apiVersion, type ActionRecord, type Run, type RunEvent } from "../../src/contract/index.js";
import { runDir } from "../../src/store/files.js";
import { checkLiveness } from "../../src/store/liveness.js";
import { listRunIds } from "../../src/store/run-store.js";
import { CALLER, HANG, events, killDaemon, makeEnv, ok, refused, startDaemon, submitBody, waitFor, waitRun, type Env } from "./support.js";

type Submitted = { run: Run; replayed?: boolean };
type Accepted = { action: ActionRecord; replayed?: boolean };

const keyFile = (env: Env, scope: string, key: string) => join(env.stateDir, "keys", `${scope}-${createHash("sha256").update(key).digest("hex")}.json`);
const post = <T>(env: Env, path: string, status: number, schema: "control-action#submit_response" | "control-action#accepted_response", body: unknown) =>
  ok<T>(env, "POST", path, status, schema, body);
const controls = (log: RunEvent[], kind: string) => log.filter((e) => e.kind === "run.control" && (e.data as { action: ActionRecord }).action.kind === kind);

test("a repeated submit key returns the first run and creates nothing; a changed request is conflict; both hold after a restart", async (t) => {
  const env = makeEnv(t, [HANG]);
  const first = await startDaemon(t, env);
  const body = submitBody("fake", env.repoA, { idempotency_key: "step-1" });
  const made = await post<Submitted>(env, "/v1/runs", 201, "control-action#submit_response", body);
  assert.equal(made.replayed, undefined);
  const entry = JSON.parse(readFileSync(keyFile(env, "submit", "step-1"), "utf8")) as { digest: string; run_id: string; state: string };
  assert.equal(entry.run_id, made.run.id);
  assert.equal(entry.state, "established");
  assert.match(entry.digest, /^sha256:[0-9a-f]{64}$/);

  // Field order does not matter; the same request is replayed, not busy.
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  const again = await post<Submitted>(env, "/v1/runs", 201, "control-action#submit_response", reordered);
  assert.equal(again.replayed, true);
  assert.equal(again.run.id, made.run.id);
  assert.deepEqual(listRunIds(env.stateDir), [made.run.id], "nothing was created");

  const changed = await refused(env, "POST", "/v1/runs", "conflict", { ...body, task: "Something else." });
  assert.equal(changed.idempotency_key, "step-1");
  assert.equal(changed.run_id, made.run.id);
  assert.equal(changed.retryable, false);

  await waitRun(env, made.run.id, (r) => r.state === "running", "running");
  await killDaemon(first);
  await startDaemon(t, env);
  const replayed = await post<Submitted>(env, "/v1/runs", 201, "control-action#submit_response", body);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.run.id, made.run.id);
  assert.equal(replayed.run.state, "running", "the first run as it is now");
  const after = await refused(env, "POST", "/v1/runs", "conflict", { ...body, repo: env.repoB });
  assert.equal(after.run_id, made.run.id);
  assert.deepEqual(listRunIds(env.stateDir), [made.run.id]);
  await post(env, `/v1/runs/${made.run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
});

test("steer and cancel sent 2 times with 1 key each take effect once in the event log, also after a restart", async (t) => {
  const env = makeEnv(t, [HANG]);
  const first = await startDaemon(t, env);
  const run = (await post<Submitted>(env, "/v1/runs", 201, "control-action#submit_response", submitBody("fake", env.repoA))).run;
  await waitRun(env, run.id, (r) => r.state === "running", "running");

  const steer = { caller: CALLER, message: "go left", idempotency_key: "steer-1" };
  const s1 = await post<Accepted>(env, `/v1/runs/${run.id}/steer`, 202, "control-action#accepted_response", steer);
  const s2 = await post<Accepted>(env, `/v1/runs/${run.id}/steer`, 202, "control-action#accepted_response", steer);
  assert.equal(s1.replayed, undefined);
  assert.equal(s2.replayed, true);
  assert.equal(s2.action.id, s1.action.id);
  assert.equal(controls(await events(env, run.id), "steer").length, 1, "1 steer effect");
  const otherSteer = await refused(env, "POST", `/v1/runs/${run.id}/steer`, "conflict", { ...steer, message: "go right" });
  assert.equal(otherSteer.idempotency_key, "steer-1");
  assert.equal(otherSteer.run_id, run.id);

  await killDaemon(first);
  await startDaemon(t, env);
  await waitRun(env, run.id, (r) => r.live_control, "live control after reattach");
  const s3 = await post<Accepted>(env, `/v1/runs/${run.id}/steer`, 202, "control-action#accepted_response", steer);
  assert.equal(s3.replayed, true);
  assert.equal(s3.action.id, s1.action.id);
  assert.equal(controls(await events(env, run.id), "steer").length, 1, "still 1 steer effect after the restart");

  const cancel = { caller: CALLER, reason: "done", idempotency_key: "cancel-1" };
  const c1 = await post<Accepted>(env, `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", cancel);
  const c2 = await post<Accepted>(env, `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", cancel);
  assert.equal(c2.replayed, true);
  assert.equal(c2.action.id, c1.action.id);
  await waitRun(env, run.id, (r) => r.terminal, "terminal");
  const c3 = await post<Accepted>(env, `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", cancel);
  assert.equal(c3.replayed, true, "a repeat after the run ended is still the first answer, not conflict");
  const log = await events(env, run.id);
  assert.equal(controls(log, "cancel").length, 1, "1 cancel effect");
  assert.equal(log.filter((e) => e.kind === "run.refused").length, 0);
  const otherCancel = await refused(env, "POST", `/v1/runs/${run.id}/cancel`, "conflict", { ...cancel, reason: "changed" });
  assert.equal(otherCancel.idempotency_key, "cancel-1");
});

test("a refused steer does not use up its key", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const run = (await post<Submitted>(env, "/v1/runs", 201, "control-action#submit_response", submitBody("fake", env.repoA))).run;
  await post(env, `/v1/runs/${run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  await waitRun(env, run.id, (r) => r.terminal, "terminal");
  const steer = { caller: CALLER, message: "late", idempotency_key: "steer-late" };
  await refused(env, "POST", `/v1/runs/${run.id}/steer`, "conflict", steer);
  assert.equal(existsSync(keyFile(env, "steer", "steer-late")), false, "the refusal released the key");
  const again = await refused(env, "POST", `/v1/runs/${run.id}/steer`, "conflict", steer);
  assert.equal(again.idempotency_key, undefined, "a state conflict, not a key conflict");
});

test("the daemon prunes keys on its housekeeping interval, not only at start", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, { ...env, vars: { ...env.vars, RECLAIM_INTERVAL_MS: "100" } });
  const made = await post<Submitted>(env, "/v1/runs", 201, "control-action#submit_response", submitBody("fake", env.repoA, { idempotency_key: "housekeep-1" }));
  await post(env, `/v1/runs/${made.run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
  await waitRun(env, made.run.id, (r) => r.terminal, "terminal");
  assert.ok(existsSync(keyFile(env, "submit", "housekeep-1")));
  rmSync(runDir(env.stateDir, made.run.id), { recursive: true, force: true }); // the run left the store
  await waitFor(() => !existsSync(keyFile(env, "submit", "housekeep-1")), 3000, "the key of a run that left the store to be pruned");
});

/** A POST that tolerates the core dying under it. */
function postBlind(env: Env, path: string, body: unknown): Promise<void> {
  return new Promise((resolve) => {
    const req = request({ socketPath: env.socket, method: "POST", path, headers: { "Agents-Api-Version": apiVersion, "Content-Type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", () => resolve());
    req.end(JSON.stringify(body));
  });
}

/** Every run directory whose worker is alive. */
const liveWorkers = (env: Env) => listRunIds(env.stateDir).filter((id) => checkLiveness(runDir(env.stateDir, id)).alive);

for (const step of ["after-key", "after-run-dir", "after-spawn"] as const) {
  test(`a submit killed ${step}: after restart a repeat gives exactly 1 run, no worker runs unlisted, an unestablished key is released`, async (t) => {
    const env = makeEnv(t, [HANG]);
    const faulty = await startDaemon(t, { ...env, vars: { ...env.vars, SUBMIT_FAULT: step } });
    const key = `crash-${step}`;
    const body = submitBody("fake", env.repoA, { idempotency_key: key });
    await postBlind(env, "/v1/runs", body);
    assert.equal((await faulty.exited).signal, "SIGKILL", "the core died at the injection point");
    assert.ok(existsSync(keyFile(env, "submit", key)), "the key was on disk before anything else");
    const dirs = listRunIds(env.stateDir);
    assert.equal(dirs.length, step === "after-key" ? 0 : 1, "the run directory comes after the key");

    await startDaemon(t, env);
    const established = step === "after-spawn";
    assert.equal(existsSync(keyFile(env, "submit", key)), established, established ? "the established key is kept" : "the key whose run was never established is released");
    if (!established) assert.deepEqual(listRunIds(env.stateDir), [], "the run directory without a first event was removed");

    const repeat = await post<Submitted>(env, "/v1/runs", 201, "control-action#submit_response", body);
    assert.equal(repeat.replayed, established ? true : undefined);
    if (established) assert.equal(repeat.run.id, dirs[0]);
    const listed = (await ok<{ runs: Run[] }>(env, "GET", "/v1/runs", 200, "run#run_list")).runs.map((r) => r.id);
    assert.deepEqual(listed, [repeat.run.id], "exactly 1 run");
    assert.deepEqual(listRunIds(env.stateDir), [repeat.run.id]);
    for (const id of liveWorkers(env)) assert.ok(listed.includes(id), `live worker of ${id} is listed`);
    const third = await post<Submitted>(env, "/v1/runs", 201, "control-action#submit_response", body);
    assert.equal(third.replayed, true);
    assert.equal(third.run.id, repeat.run.id);
    assert.deepEqual(readdirSync(join(env.stateDir, "keys")).length, 1);
    await post(env, `/v1/runs/${repeat.run.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER });
    await waitRun(env, repeat.run.id, (r) => r.terminal, "terminal");
  });
}
