/**
 * End to end through the real daemon binary (`dist/src/daemon/main.js`, the package's
 * `culture-agents-core` bin), started through a symlink as npm installs it, with the real harness
 * registry: the stub harness is enabled through the harness configuration file, a temp allow-list
 * names a temp git repository, and submit, attach, result, steer and cancel run over the real
 * socket. Every response is validated against the contract. No sandbox, gateway or model call.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { ActionRecord, Capabilities, OutputData, Run, RunEvent, StateData } from "../../src/contract/index.js";
import { AGENT, CALLER, attach, events, getRun, killWorkers, ok, refused, submitBody, waitFor, waitRun, type Env } from "../runs/support.js";

const BIN = fileURLToPath(new URL("../../src/daemon/main.js", import.meta.url));

interface BinEnv extends Env {
  configHome: string;
}

function makeBinEnv(t: TestContext, harnessConfig: unknown): BinEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ca-bin-")));
  const configHome = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(join(configHome, "culture-agents"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README"), "temp repo\n");
  git("add", "README");
  git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "one");
  writeFileSync(join(configHome, "culture-agents", "allowlist.json"), JSON.stringify({ version: 1, entries: [{ agent_id: AGENT, harness: "stub", repo }] }));
  writeFileSync(join(configHome, "culture-agents", "harness.json"), typeof harnessConfig === "string" ? harnessConfig : JSON.stringify(harnessConfig));
  writeFileSync(join(root, "server.yaml"), "server:\n  name: spark\n");
  const env: BinEnv = {
    root,
    configHome,
    socket: join(root, "run", "core.sock"),
    stateDir: join(root, "state"),
    repoA: repo,
    repoB: repo,
    vars: {
      CULTURE_AGENTS_SOCKET: join(root, "run", "core.sock"),
      CULTURE_AGENTS_STATE_DIR: join(root, "state"),
      CULTURE_SERVER_YAML: join(root, "server.yaml"),
      XDG_CONFIG_HOME: configHome,
      HOME: root,
    },
  };
  t.after(() => {
    killWorkers(env);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return env;
}

/** Start the bin through a symlink (as `node_modules/.bin/culture-agents-core` would be). */
function startBin(t: TestContext, env: BinEnv) {
  const link = join(env.root, "culture-agents-core");
  symlinkSync(BIN, link);
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith("CULTURE_AGENTS_") && key !== "OPENSHELL_LOCAL_TLS_DIR");
  const vars = { ...Object.fromEntries(inherited), ...env.vars };
  const proc = spawn(process.execPath, [link], { env: vars, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  t.after(() => void proc.kill("SIGKILL"));
  return { proc, stderr: () => err, exited };
}

const HERMETIC = { stub: true, dockerBin: "/nonexistent/docker", openshellBin: "/nonexistent/openshell" };
const states = (log: RunEvent[]) => log.filter((e) => e.kind === "run.state").map((e) => (e.data as StateData).to);
const outputs = (log: RunEvent[]) => log.filter((e) => e.kind === "run.output").map((e) => e.data as OutputData);

test("the daemon bin serves the real registry: the stub harness runs submit, attach, result, steer and cancel", { timeout: 60_000 }, async (t) => {
  const env = makeBinEnv(t, HERMETIC);
  const daemon = startBin(t, env);
  await Promise.race([
    waitFor(() => /listening/.test(daemon.stderr()), 10_000, "the daemon to listen"),
    daemon.exited.then((code) => assert.fail(`the daemon exited early (${String(code)}): ${daemon.stderr()}`)),
  ]);

  const harnesses = await ok<{ harnesses: Capabilities[] }>(env, "GET", "/v1/harnesses", 200, "capabilities#capabilities_list");
  assert.deepEqual(harnesses.harnesses.map((h) => h.harness).sort(), ["claude-code", "opencode", "stub"]);
  const stub = await ok<Capabilities>(env, "GET", "/v1/harnesses/stub", 200, "capabilities");
  assert.equal(stub.available, true);
  assert.equal(stub.capabilities.steer.supported, true);
  assert.equal(harnesses.harnesses.find((h) => h.harness === "claude-code")?.available, false, "no gateway or image here");

  // A run that finishes: submit, attach until terminal, result.
  const first = (await ok<{ run: Run }>(env, "POST", "/v1/runs", 201, "control-action#submit_response", { ...submitBody("stub", env.repoA), task: "files: a.txt, b.txt" })).run;
  assert.equal(first.state, "queued");
  const stream = await attach(env, first.id, 0);
  await stream.closed;
  assert.deepEqual(states(stream.events), ["queued", "running", "succeeded"]);
  assert.deepEqual(stream.events.map((e) => e.cursor), stream.events.map((_, i) => i + 1));
  const result = await ok<{ state: string; summary: string | null; branch: string | null; commits: string[] }>(env, "GET", `/v1/runs/${first.id}/result`, 200, "run#run_result");
  assert.equal(result.state, "succeeded");
  assert.match(result.summary ?? "", /stub wrote 2 file\(s\): a\.txt, b\.txt/);
  // The result names where the work landed: the branch and its commits, as the host repository has them.
  assert.equal(result.branch, `runs/${first.id}`);
  const onBranch = execFileSync("git", ["rev-list", "--reverse", `main..runs/${first.id}`], { cwd: env.repoA, encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(result.commits, onBranch);
  assert.equal(result.commits.length, 1);
  assert.equal((await getRun(env, first.id)).branch, `runs/${first.id}`);

  // A run that hangs: steer, then cancel.
  const second = (await ok<{ run: Run }>(env, "POST", "/v1/runs", 201, "control-action#submit_response", { ...submitBody("stub", env.repoA), task: "hang" })).run;
  await waitRun(env, second.id, (r) => r.state === "running", "running");
  const steer = await ok<{ action: ActionRecord }>(env, "POST", `/v1/runs/${second.id}/steer`, 202, "control-action#accepted_response", { caller: CALLER, message: "look again" });
  assert.equal(steer.action.outcome, "accepted");
  await waitFor(async () => outputs(await events(env, second.id)).some((o) => /steer acknowledged: look again/.test(o.text)), 5000, "the stub to take the steer");
  const cancel = await ok<{ action: ActionRecord }>(env, "POST", `/v1/runs/${second.id}/cancel`, 202, "control-action#accepted_response", { caller: CALLER, reason: "enough" });
  const ended = await waitRun(env, second.id, (r) => r.terminal, "terminal", 15_000);
  assert.equal(ended.state, "cancelled");
  const log = await events(env, second.id);
  assert.deepEqual(states(log), ["queued", "running", "cancelling", "cancelled"]);
  const controls = log.filter((e) => e.kind === "run.control").map((e) => (e.data as { action: ActionRecord }).action.id);
  assert.deepEqual(controls, [steer.action.id, cancel.action.id]);
  await ok(env, "GET", `/v1/runs/${second.id}/result`, 200, "run#run_result");
  await refused(env, "POST", `/v1/runs/${second.id}/cancel`, "conflict", { caller: CALLER });
  assert.equal((await getRun(env, second.id)).live_control, false);

  daemon.proc.kill("SIGTERM");
  assert.equal(await daemon.exited, 0);
});

test("a harness configuration error stops the daemon bin with exit 2 and one clear line, no stack trace", async (t) => {
  const env = makeBinEnv(t, { stub: true, sandboxPrefix: "Not Valid" });
  const daemon = startBin(t, env);
  assert.equal(await daemon.exited, 2);
  const err = daemon.stderr();
  assert.match(err, /culture-agents core: cannot start: harness configuration: sandboxPrefix must be/);
  assert.doesNotMatch(err, /^\s+at /m, "no stack trace");
  assert.equal(err.trim().split("\n").length, 1);

  const broken = makeBinEnv(t, "{ not json");
  const again = startBin(t, broken);
  assert.equal(await again.exited, 2);
  assert.match(again.stderr(), /harness configuration: harness config .* is invalid/);
  assert.doesNotMatch(again.stderr(), /^\s+at /m);
});

test("the run service stays free of harness imports; only the daemon's adapter connects the registry", () => {
  const src = fileURLToPath(new URL("../../../src/", import.meta.url));
  for (const file of readdirSync(join(src, "runs"))) {
    assert.doesNotMatch(readFileSync(join(src, "runs", file), "utf8"), /from "\.\.\/harness\//, `runs/${file}`);
  }
  assert.doesNotMatch(readFileSync(join(src, "daemon", "main.ts"), "utf8"), /^import .*harness/m, "main.ts loads the registry only in its bin target");
});
