/**
 * Support for run-service tests: a private temp tree, the real daemon (child.js) over a real Unix
 * socket, the real store and real worker processes running the fake driver. Every response is
 * validated against the contract. Cleanup kills every daemon and worker and removes the tree.
 */
import { execFileSync } from "node:child_process";
import { hostEnv } from "../../src/sandbox/host-command.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { apiVersion, validate, type ErrorBody, type Run, type RunEvent, type SchemaName } from "../../src/contract/index.js";
import { runDir } from "../../src/store/files.js";
import { checkLiveness } from "../../src/store/liveness.js";
import { listRunIds } from "../../src/store/run-store.js";
import { pollUntil } from "../../src/util/sequence.js";
import type { FakeStep } from "../../src/worker/fake-driver.js";

export const AGENT = "thor-culture-agents";
export const CALLER = { kind: "operator", id: "thor-operator" } as const;

/** One fake harness: steps the fake driver plays, and whether steer is declared supported. */
export interface FakeHarness {
  id: string;
  steps: FakeStep[];
  steer?: boolean;
  /** Report `answer` supported (the stub driver and the fake driver's `ask` step can ask). */
  ask?: boolean;
  /** Run the real stub harness driver (a host temp clone, commits collected into `runs/<id>`) instead of the fake driver; `steps` is then unused. */
  stub?: boolean;
}

export const HANG: FakeHarness = { id: "fake", steps: [{ op: "started" }, { op: "output", data: { channel: "text", text: "Working" } }, { op: "hang" }] };
export const NO_STEER: FakeHarness = { ...HANG, id: "fake-nosteer", steer: false };
export const TIMED: FakeHarness = {
  id: "fake-timed",
  steps: [{ op: "started" }, { op: "sleep", ms: 2500 }, { op: "output", data: { channel: "text", text: "done" } }, { op: "completed" }],
};

export interface Env {
  root: string;
  socket: string;
  stateDir: string;
  repoA: string;
  repoB: string;
  vars: Record<string, string>;
}

/** A temp tree with two repositories allow-listed for every given harness. Removed after the test. */
export function makeEnv(t: TestContext, harnesses: FakeHarness[] | null): Env {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ca-runs-")));
  const env: Env = {
    root,
    socket: join(root, "run", "core.sock"),
    stateDir: join(root, "state"),
    repoA: join(root, "repo-a"),
    repoB: join(root, "repo-b"),
    vars: {},
  };
  const configHome = join(root, "config");
  for (const dir of [env.repoA, env.repoB, join(configHome, "culture-agents")]) mkdirSync(dir, { recursive: true });
  for (const dir of [env.repoA, env.repoB]) commitedRepo(dir);
  const ids = (harnesses ?? [HANG]).map((h) => h.id);
  const entries = ids.flatMap((harness) => [env.repoA, env.repoB].map((repo) => ({ agent_id: AGENT, harness, repo })));
  writeFileSync(join(configHome, "culture-agents", "allowlist.json"), JSON.stringify({ version: 1, entries }));
  env.vars = { CULTURE_AGENTS_SOCKET: env.socket, XDG_CONFIG_HOME: configHome, CULTURE_AGENTS_STATE_DIR: env.stateDir };
  if (harnesses !== null) env.vars["FAKE_CATALOG"] = JSON.stringify(harnesses);
  t.after(() => {
    killWorkers(env);
    rmSync(root, { recursive: true, force: true });
  });
  return env;
}

/** SIGKILL every live worker recorded in the store. */
export function killWorkers(env: Env): void {
  for (const id of listRunIds(env.stateDir)) {
    const live = checkLiveness(runDir(env.stateDir, id));
    if (!live.alive || live.pid === null) continue;
    try {
      process.kill(live.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export interface Daemon {
  proc: ChildProcess;
  stderr(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Start the real daemon (child.js) and wait until it listens. Killed after the test. */
export async function startDaemon(t: TestContext, env: Env): Promise<Daemon> {
  const script = join(dirname(fileURLToPath(import.meta.url)), "child.js");
  const proc = spawn(process.execPath, [script], { env: { ...process.env, ...env.vars }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => {
    proc.kill("SIGKILL");
  });
  const daemon = { proc, stderr: () => err, exited };
  await Promise.race([
    waitFor(() => /listening/.test(err), 10_000, "daemon to listen"),
    exited.then((x) => {
      throw new Error(`daemon exited early (${String(x.code)}): ${err}`);
    }),
  ]);
  return daemon;
}

export async function killDaemon(daemon: Daemon): Promise<void> {
  daemon.proc.kill("SIGKILL");
  assert.equal((await daemon.exited).signal, "SIGKILL");
}

export interface Reply {
  status: number;
  json: unknown;
}

function send(socket: string, method: string, path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Agents-Api-Version": apiVersion };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const req = request({ socketPath: socket, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function assertValid(schema: SchemaName, value: unknown): void {
  const result = validate(schema, value);
  assert.ok(result.ok, `response validates against ${schema}: ${JSON.stringify(result.ok ? null : result.issues[0])}`);
}

/** A request expected to succeed with `status`; the body must validate against `schema`. */
export async function ok<T>(env: Env, method: string, path: string, status: number, schema: SchemaName, body?: unknown): Promise<T> {
  const reply = await send(env.socket, method, path, body);
  assert.equal(reply.status, status, `${method} ${path}: ${JSON.stringify(reply.json)}`);
  assertValid(schema, reply.json);
  return reply.json as T;
}

/** A request expected to be refused with `code`; the body must validate against `error.json`. */
export async function refused(env: Env, method: string, path: string, code: ErrorBody["code"], body?: unknown): Promise<ErrorBody> {
  const reply = await send(env.socket, method, path, body);
  assertValid("error", reply.json);
  const error = (reply.json as { error: ErrorBody }).error;
  assert.equal(error.code, code, `${method} ${path}: ${JSON.stringify(error)}`);
  return error;
}

export function submitBody(harness: string, repo: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { agent_id: AGENT, harness, repo, task: "Do the thing.", caller: CALLER, ...extra };
}

export async function submit(env: Env, harness: string, repo: string): Promise<Run> {
  return (await ok<{ run: Run }>(env, "POST", "/v1/runs", 201, "control-action#submit_response", submitBody(harness, repo))).run;
}

export const getRun = (env: Env, id: string): Promise<Run> => ok<Run>(env, "GET", `/v1/runs/${id}`, 200, "run");

export async function events(env: Env, id: string): Promise<RunEvent[]> {
  return (await ok<{ events: RunEvent[] }>(env, "GET", `/v1/runs/${id}/events?limit=5000`, 200, "event#event_page")).events;
}

/** Poll the run until `predicate` holds. */
export async function waitRun(env: Env, id: string, predicate: (run: Run) => boolean, what: string, ms = 8000): Promise<Run> {
  let last: Run | undefined;
  const reached = async (): Promise<boolean> => {
    last = await getRun(env, id);
    return predicate(last);
  };
  try {
    await waitFor(reached, ms, what);
  } catch (err) {
    const state = (last as Run | undefined)?.state ?? "none";
    throw new Error(`${err instanceof Error ? err.message : String(err)} (last state ${state})`, { cause: err });
  }
  return last as unknown as Run;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  if (!(await pollUntil(predicate, { everyMs: 20, timeoutMs: ms }))) throw new Error(`timed out waiting for ${what}`);
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface Attach {
  events: RunEvent[];
  /** Resolves when the server closes the stream. */
  closed: Promise<void>;
  close(): void;
}

/** Open `runs.attach` and collect SSE events (each validated against `event.json`). */
export function attach(env: Env, id: string, after: number): Promise<Attach> {
  return new Promise((resolve, reject) => {
    const out: RunEvent[] = [];
    const req = request({ socketPath: env.socket, method: "GET", path: `/v1/runs/${id}/attach?after=${after}`, headers: { "Agents-Api-Version": apiVersion } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`attach answered ${String(res.statusCode)}`));
      let buf = "";
      const closed = new Promise<void>((done) => res.on("end", done));
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          if (data === undefined) continue;
          const event = JSON.parse(data.slice(6)) as RunEvent;
          assertValid("event", event);
          assert.ok(frame.includes(`id: ${event.cursor}\n`) && frame.includes(`event: ${event.kind}\n`), "SSE framing");
          out.push(event);
        }
      });
      resolve({ events: out, closed, close: () => req.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Make `dir` a git repository with one commit (a submit resolves its base commit when accepted). */
export function commitedRepo(dir: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: hostEnv() });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "one");
}

/** Write the core's config file (`harness.json` under the env's config home) with these limits; the daemon reads it at start. */
export function writeLimits(env: Env, limits: Record<string, unknown>): void {
  writeFileSync(join(env.vars["XDG_CONFIG_HOME"] as string, "culture-agents", "harness.json"), JSON.stringify({ limits }));
}
