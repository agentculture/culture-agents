import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { validate, type Run, type RunState } from "../../src/contract/index.js";
import { startDaemon, type Daemon } from "../../src/daemon/daemon.js";
import type { CommandRunner } from "../../src/sandbox/host-command.js";
import { runCommand } from "../../src/sandbox/host-command.js";
import { listBranches, removeBranches } from "../../src/runs/branches.js";
import { FakeRunService, fixture } from "../daemon/fake-service.js";
import { call, makeEnv, writeAllowlist, type Env } from "../daemon/harness.js";

const id = (suffix: string): string => `thor-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4${suffix}`;
const MERGED_DONE = id("D1");
const UNMERGED = id("D2");
const ACTIVE = id("D3");
const UNKNOWN = id("D4");
const UNREADABLE = id("D5");
const ABSENT = id("D6");
const ELSEWHERE = id("D7");
const CHECKED_OUT = id("D8");

let root: string;
let repo: string;
const states = new Map<string, { state: RunState; repo?: string } | "throw">();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } }).trim();
}
const exists = (branch: string): boolean => git(repo, "branch", "--list", branch) !== "";

async function lookup(runId: string): Promise<Run | null> {
  const entry = states.get(runId);
  if (entry === "throw") throw new Error("corrupt event log");
  if (entry === undefined) return null;
  return { ...fixture<Run>("valid/run/root.succeeded.json"), id: runId, state: entry.state, repo: entry.repo ?? repo };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "ca-branches-"));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: { PATH: process.env["PATH"] ?? "" } });
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  for (const run of [MERGED_DONE, ACTIVE, UNKNOWN, UNREADABLE, ABSENT, ELSEWHERE, CHECKED_OUT]) git(repo, "branch", `runs/${run}`);
  git(repo, "checkout", "-q", "-b", `runs/${UNMERGED}`);
  git(repo, "commit", "-q", "--allow-empty", "-m", "run work");
  git(repo, "checkout", "-q", "main");
  git(repo, "worktree", "add", "-q", join(root, "wt"), `runs/${CHECKED_OUT}`);
  repo = realpathSync(repo);
  states.set(MERGED_DONE, { state: "succeeded" });
  states.set(UNMERGED, { state: "failed" });
  states.set(ACTIVE, { state: "running" });
  states.set(UNKNOWN, { state: "unknown" });
  states.set(UNREADABLE, "throw");
  states.set(ELSEWHERE, { state: "succeeded", repo: "/somewhere/else" });
  states.set(CHECKED_OUT, { state: "succeeded" });
});
after(() => rmSync(root, { recursive: true, force: true }));

test("list shows every runs branch with its run's state and the evidence", async () => {
  const list = await listBranches({ repo, lookup });
  assert.equal(validate("branches", list).ok, true);
  const by = new Map(list.branches.map((b) => [b.run_id, b]));
  assert.equal(by.size, 8);
  assert.equal(by.get(MERGED_DONE)?.state, "succeeded");
  assert.equal(by.get(MERGED_DONE)?.merged_into, "main");
  assert.equal(by.get(UNMERGED)?.merged_into, null);
  assert.equal(by.get(ACTIVE)?.state, "running");
  assert.equal(by.get(UNREADABLE)?.state, null);
  assert.match(by.get(UNREADABLE)?.state_note ?? "", /cannot be read/);
  assert.match(by.get(ABSENT)?.state_note ?? "", /no run/);
  assert.match(by.get(ELSEWHERE)?.state_note ?? "", /another repository/);
});

test("a dry run reports what would go and deletes nothing", async () => {
  const result = await removeBranches({ repo, lookup }, true);
  assert.equal(validate("branches#remove_response", result).ok, true);
  assert.deepEqual(result.removed.map((b) => b.run_id).sort(), [CHECKED_OUT, MERGED_DONE].sort());
  assert.equal(exists(`runs/${MERGED_DONE}`), true);
});

test("removal deletes only a finished, reachable branch with git branch -d, and reports every skip", async () => {
  const seen: string[][] = [];
  const runner: CommandRunner = (file, args, options) => {
    seen.push([...args]);
    return runCommand(file, args, options);
  };
  const result = await removeBranches({ repo, lookup, runner }, false);
  assert.equal(validate("branches#remove_response", result).ok, true);
  assert.deepEqual(result.removed.map((b) => b.run_id), [MERGED_DONE]);
  assert.equal(exists(`runs/${MERGED_DONE}`), false);
  const reasons = new Map(result.skipped.map((s) => [s.run_id, s.reason]));
  assert.match(reasons.get(UNMERGED) ?? "", /no other ref/);
  assert.match(reasons.get(ACTIVE) ?? "", /active/);
  assert.match(reasons.get(UNKNOWN) ?? "", /unknown/);
  assert.match(reasons.get(UNREADABLE) ?? "", /cannot be read/);
  assert.match(reasons.get(ABSENT) ?? "", /no run/);
  assert.match(reasons.get(ELSEWHERE) ?? "", /another repository/);
  assert.match(reasons.get(CHECKED_OUT) ?? "", /git refused/, "git's own refusal is reported, not forced");
  for (const run of [UNMERGED, ACTIVE, UNKNOWN, UNREADABLE, ABSENT, ELSEWHERE, CHECKED_OUT]) assert.equal(exists(`runs/${run}`), true, run);
  const deletes = seen.filter((a) => a.includes("branch"));
  assert.ok(deletes.length >= 1);
  for (const a of deletes) {
    assert.ok(a.includes("-d"));
    assert.ok(!a.includes("-D") && !a.includes("--force") && !a.includes("-f"), a.join(" "));
  }
});

test("the core routes list and remove, and refuse a repository the allow-list does not name", async () => {
  const env: Env = makeEnv();
  const service = new FakeRunService();
  service.getRun = lookup;
  writeAllowlist(env, { version: 1, entries: [{ agent_id: "thor-culture-agents", harness: "claude-code", repo }] });
  const daemon: Daemon = await startDaemon({ service, node: "thor", env: env.vars, keepaliveMs: 100 });
  try {
    const listed = await call(env.socket, "GET", `/v1/branches?repo=${encodeURIComponent(repo)}`);
    assert.equal(listed.status, 200, listed.text);
    assert.equal(validate("branches", listed.json).ok, true);
    assert.equal((listed.json as { branches: unknown[] }).branches.length, 7);
    const dry = await call(env.socket, "POST", "/v1/branches/remove", { body: { repo, dry_run: true } });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(validate("branches#remove_response", dry.json).ok, true);
    const denied = await call(env.socket, "GET", `/v1/branches?repo=${encodeURIComponent(root)}`);
    assert.equal(denied.status, 403, denied.text);
    assert.equal((denied.json as { error: { code: string } }).error.code, "denied");
    const missing = await call(env.socket, "GET", "/v1/branches");
    assert.equal((missing.json as { error: { code: string } }).error.code, "invalid");
    const bad = await call(env.socket, "POST", "/v1/branches/remove", { body: { repo, extra: 1 } });
    assert.equal((bad.json as { error: { code: string } }).error.code, "invalid");
  } finally {
    await daemon.stop();
    env.cleanup();
  }
});

test("a remote-tracking copy of a run branch is never evidence that it was merged", async () => {
  const lone = id("E1");
  git(repo, "checkout", "-q", "-b", `runs/${lone}`);
  git(repo, "commit", "-q", "--allow-empty", "-m", "pushed work");
  git(repo, "checkout", "-q", "main");
  git(repo, "update-ref", `refs/remotes/origin/runs/${lone}`, `refs/heads/runs/${lone}`);
  states.set(lone, { state: "succeeded" });
  const { branches } = await listBranches({ repo, lookup });
  assert.equal(branches.find((b) => b.run_id === lone)?.merged_into, null);
  const res = await removeBranches({ repo, lookup }, false);
  assert.ok(res.skipped.some((s) => s.run_id === lone));
  assert.ok(exists(`runs/${lone}`), "the branch is still there");
});
