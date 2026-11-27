/** t7: the commit a run starts from is resolved when the submit is accepted and recorded on the run. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SandboxWorkspaceFactory, type SandboxDeps, type SandboxSettings } from "../../src/harness/common/sandbox-workspace.js";
import { StubWorkspaceFactory } from "../../src/harness/stub/workspace.js";
import { hostEnv } from "../../src/sandbox/host-command.js";
import type { PreparedTree } from "../../src/sandbox/worktree.js";
import { HANG, commitedRepo, getRun, makeEnv, refused, startDaemon, submit, submitBody } from "./support.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: hostEnv() }).trim();
const commit = (cwd: string, msg: string) => git(cwd, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", msg);

test("the run record holds the HEAD of accept time, and it does not move with the host", async (t) => {
  const env = makeEnv(t, [HANG]);
  await startDaemon(t, env);
  const before = git(env.repoA, "rev-parse", "HEAD");
  const run = await submit(env, "fake", env.repoA);
  assert.equal(run.base_commit, before);
  commit(env.repoA, "two");
  assert.notEqual(git(env.repoA, "rev-parse", "HEAD"), before);
  assert.equal((await getRun(env, run.id)).base_commit, before);
});

test("a stub run builds from the recorded commit although the host HEAD moved before the sandbox was ready", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ca-base-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  commitedRepo(repo);
  const recorded = git(repo, "rev-parse", "HEAD");
  commit(repo, "moved after the submit"); // the host HEAD moves before the worker opens its workspace
  const moved = git(repo, "rev-parse", "HEAD");
  const ws = await new StubWorkspaceFactory("thor-a.run.01X", repo, { ref: recorded, identity: { name: "n", email: "e@e.invalid" } }).open(new AbortController().signal);
  t.after(() => ws.destroy());
  assert.equal(git(ws.workdir, "rev-parse", "HEAD"), recorded);
  assert.notEqual(recorded, moved);
});

test("a sandbox run asks the bundle for the recorded commit, not the configured ref", async () => {
  const asked: string[] = [];
  const sandbox = { name: "s", home: "/sandbox", destroy: async () => undefined, stop: async () => undefined } as never;
  const deps: SandboxDeps = {
    openRunSandboxes: async () => ({ create: async () => sandbox, destroy: async () => undefined }) as never,
    prepare: async (_sb, o) => {
      asked.push(o.ref);
      throw new Error("stop here");
    },
    collect: async () => {
      throw new Error("unused");
    },
  };
  const settings = { gateway: { endpoint: "x" }, image: "i", providers: [], sandboxPrefix: "p-", ref: "HEAD", identity: { name: "n", email: "e@e.invalid" } } as unknown as SandboxSettings;
  const recorded = "a".repeat(40);
  await assert.rejects(new SandboxWorkspaceFactory("r", "/host", settings, deps, recorded).open(new AbortController().signal), /stop here/);
  assert.deepEqual(asked, [recorded]);
  void (undefined as PreparedTree | undefined);
});

test("a repository with no commits is refused at submit with a typed error and no run is created", async (t) => {
  const env = makeEnv(t, [HANG]);
  rmSync(join(env.repoB, ".git"), { recursive: true, force: true });
  git(env.repoB, "init", "-q", "-b", "main"); // no commits: HEAD is unborn
  await startDaemon(t, env);
  const body = await refused(env, "POST", "/v1/runs", "invalid", submitBody("fake", env.repoB));
  assert.equal(body.field, "repo");
  assert.match(body.message, /no commit/);
});

test("a repository whose HEAD cannot be resolved is refused at submit", async (t) => {
  const env = makeEnv(t, [HANG]);
  git(env.repoB, "symbolic-ref", "HEAD", "refs/heads/does-not-exist");
  await startDaemon(t, env);
  await refused(env, "POST", "/v1/runs", "invalid", submitBody("fake", env.repoB));
});
