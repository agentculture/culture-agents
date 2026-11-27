/**
 * Where publishing lives, and what a broker that is down costs the core: nothing.
 *
 * - only the core's publish module loads the MQTT client, and no worker can reach it;
 * - the MQTT client is one exact-pinned dependency, in package.json and the lockfile alike;
 * - a real core whose configured broker is down runs a run to the same terminal state and the same
 *   log as a core with no broker configured, and none of its calls waits on the broker.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { RunEvent } from "../../src/contract/index.js";
import { BROKER_URL_ENV, POSITION_FILE } from "../../src/publish/index.js";
import { runDir } from "../../src/store/files.js";
import { events, getRun, makeEnv, startDaemon, submit, waitFor, waitRun, type FakeHarness } from "../runs/support.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // dist/test/publish
const SRC = resolve(HERE, "../../src");
const CORE = resolve(HERE, "../../..");

/** Every module specifier a compiled file imports, statically or with `import()`. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map((m) => m[1] as string);
}

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return name.endsWith(".js") ? [path] : [];
  });
}

/** Every file reachable from `entry` through relative imports, and every package it names on the way. */
function closure(entries: string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  }
  return { files, packages };
}

test("only the publish module's transport loads the MQTT client", () => {
  const users = jsFiles(SRC).filter((file) => importsOf(file).some((spec) => spec === "mqtt" || spec.startsWith("mqtt/")));
  assert.deepEqual(users.map((f) => relative(SRC, f)), ["publish/transport.js"]);
});

test("workers open no broker connection: nothing a worker or a harness driver loads reaches the publish module or the MQTT client", () => {
  // The worker entry point, everything beside it, and every harness driver a worker loads by module path.
  const entries = [...jsFiles(join(SRC, "worker")), ...jsFiles(join(SRC, "harness")), ...jsFiles(join(SRC, "sandbox")), ...jsFiles(join(SRC, "store"))];
  assert.ok(entries.includes(join(SRC, "worker", "main.js")));
  const reached = closure(entries);
  const publish = [...reached.files].filter((f) => relative(SRC, f).startsWith("publish"));
  assert.deepEqual(publish, [], "no worker-side module imports the publish module");
  assert.ok(![...reached.packages].some((p) => p === "mqtt" || p.startsWith("mqtt/")), "no worker-side module imports the MQTT client");
  // The check can see such an import: the daemon entry point does reach both.
  const daemon = closure([join(SRC, "daemon", "main.js")]);
  assert.ok(daemon.files.has(join(SRC, "publish", "transport.js")) && daemon.packages.has("mqtt"));
});

test("the MQTT client is one exact-pinned dependency, the same in package.json and the lockfile", () => {
  const pkg = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const lock = JSON.parse(readFileSync(join(CORE, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
  const exact = /^\d+\.\d+\.\d+$/;
  assert.match(pkg.dependencies["mqtt"] ?? "", exact, "an exact version, no ^ or ~");
  for (const [name, version] of Object.entries(pkg.dependencies)) assert.match(version, exact, `${name} is an exact pin`);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@ai-openshell/sdk", "@ai-sdk/harness", "@ai-sdk/harness-claude-code", "ajv", "mqtt"], "mqtt is the one dependency added for publishing");
  assert.equal(lock.packages[""]?.dependencies?.["mqtt"], pkg.dependencies["mqtt"]);
  assert.equal(lock.packages["node_modules/mqtt"]?.version, pkg.dependencies["mqtt"]);
});

/** A loopback port with nothing listening on it. */
function closedPort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

const QUICK: FakeHarness = {
  id: "fake-quick",
  steps: [{ op: "started" }, { op: "output", data: { channel: "text", text: "Working" } }, { op: "sleep", ms: 300 }, { op: "output", data: { channel: "tool_result", text: "ok" } }, { op: "completed", summary: "done" }],
};

/** One run on a fresh real core; returns what a caller can observe, and how long the slowest call took. */
async function runOnce(t: TestContext, brokerUrl: string | null): Promise<{ state: string; log: unknown[]; slowestMs: number; stderr: string; positionFile: boolean; exit: number | null }> {
  const env = makeEnv(t, [QUICK]);
  if (brokerUrl !== null) env.vars[BROKER_URL_ENV] = brokerUrl;
  const daemon = await startDaemon(t, env);
  let slowestMs = 0;
  const timed = async <T>(call: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    const value = await call();
    slowestMs = Math.max(slowestMs, Date.now() - started);
    return value;
  };
  const run = await timed(() => submit(env, "fake-quick", env.repoA));
  await waitFor(async () => (await timed(() => getRun(env, run.id))).state === "succeeded", 10_000, "the run to succeed");
  const ended = await waitRun(env, run.id, (r) => r.terminal, "terminal");
  const log = (await timed(() => events(env, run.id))).map((e: RunEvent) => ({ cursor: e.cursor, kind: e.kind, data: e.data }));
  // Give a publisher time for several rounds against the dead port before the core is asked to stop.
  if (brokerUrl !== null) await waitFor(() => /broker is not taking run events/.test(daemon.stderr()), 10_000, "the outage line");
  const positionFile = existsSync(join(runDir(env.stateDir, run.id), POSITION_FILE));
  daemon.proc.kill("SIGTERM");
  const stopped = Date.now();
  const exit = (await daemon.exited).code;
  slowestMs = Math.max(slowestMs, Date.now() - stopped);
  return { state: ended.state, log, slowestMs, stderr: daemon.stderr(), positionFile, exit };
}

test("with the broker down a run reaches the same terminal state and the same log, and no call to the core waits on it", async (t) => {
  const plain = await runOnce(t, null);
  const down = await runOnce(t, `mqtt://127.0.0.1:${await closedPort()}`);

  assert.equal(plain.state, "succeeded");
  assert.equal(down.state, plain.state);
  assert.deepEqual(down.log, plain.log, "the same events, in the same order, with the same data");
  assert.equal(down.log.length, 5);
  assert.ok(down.slowestMs < 3000, `the slowest call with the broker down took ${down.slowestMs} ms`);
  assert.equal(down.exit, 0, "the core stops cleanly with the broker down");
  assert.equal(plain.exit, 0);

  assert.doesNotMatch(plain.stderr, /broker/, "with no address configured the core says nothing of a broker");
  assert.match(down.stderr, /publishing run events to the broker at mqtt:\/\/127\.0\.0\.1:\d+ \(CULTURE_AGENTS_BROKER_URL\)/);
  assert.equal(down.stderr.split("\n").filter((l) => /broker is not taking run events/.test(l)).length, 1, "the outage is said once");
  assert.equal(down.positionFile, false, "nothing was recorded as published");
  assert.equal(plain.positionFile, false, "a core without a broker writes no position");
});
