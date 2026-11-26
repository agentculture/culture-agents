/**
 * t8: two runs in one repository run to completion side by side. Each `runs/<id>` branch holds only
 * its own commits, the host checkout and index are byte-identical before and after, and no git
 * worktree exists. Also the concurrent-fetch check (spec s44): results fetched into one repository
 * at the same moment, with the host's refs packed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

import { StubWorkspaceFactory } from "../../src/harness/stub/workspace.js";
import { hostEnv } from "../../src/sandbox/host-command.js";
import { commitedRepo, makeEnv, ok, startDaemon, submitBody, waitRun, type FakeHarness } from "./support.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: hostEnv() }).trim();
const STUB: FakeHarness = { id: "stub", steps: [], stub: true };

/** Every file of the checkout and of `.git` that a write to the checkout or index would change, byte for byte. */
function hostSnapshot(repo: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(repo, path);
      if (rel === ".git") continue;
      if (statSync(path).isDirectory()) walk(path);
      else out.set(rel, readFileSync(path).toString("base64"));
    }
  };
  walk(repo);
  for (const file of ["index", "HEAD", "config"]) {
    const path = join(repo, ".git", file);
    out.set(`.git/${file}`, existsSync(path) ? readFileSync(path).toString("base64") : "<absent>");
  }
  out.set("refs/heads/main", git(repo, "rev-parse", "refs/heads/main"));
  return out;
}

const treeFiles = (repo: string, ref: string) => git(repo, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean).sort();
const revs = (repo: string, range: string) => git(repo, "rev-list", range).split("\n").filter(Boolean);

test("2 runs in 1 repository complete; each runs branch holds only its own commits; the host checkout and index are unchanged; no worktree", async (t) => {
  const env = makeEnv(t, [STUB]);
  const repo = env.repoA;
  writeFileSync(join(repo, "README.md"), "host file\n");
  git(repo, "add", "README.md");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "tracked file");
  writeFileSync(join(repo, "untracked.txt"), "operator's own work in progress\n");
  const base = git(repo, "rev-parse", "HEAD");
  const before = hostSnapshot(repo);
  await startDaemon(t, env);

  const submitted = await Promise.all(
    [
      { task: "files: a1.txt, a2.txt" },
      { task: "files: b1.txt, b2.txt" },
    ].map(async ({ task }) => (await ok<{ run: { id: string } }>(env, "POST", "/v1/runs", 201, "control-action#submit_response", submitBody("stub", repo, { task }))).run.id),
  );
  const [one, two] = submitted as [string, string];
  for (const id of submitted) assert.equal((await waitRun(env, id, (r) => r.terminal, `${id} terminal`, 30_000)).state, "succeeded");

  type Result = { branch: string | null; commits: string[] };
  const r1 = await ok<Result>(env, "GET", `/v1/runs/${one}/result`, 200, "run#run_result");
  const r2 = await ok<Result>(env, "GET", `/v1/runs/${two}/result`, 200, "run#run_result");
  assert.equal(r1.branch, `runs/${one}`);
  assert.equal(r2.branch, `runs/${two}`);
  // Each branch: exactly the commits its run reported, on top of the base, and none of the other's.
  assert.deepEqual(revs(repo, `${base}..refs/heads/runs/${one}`).reverse(), r1.commits);
  assert.deepEqual(revs(repo, `${base}..refs/heads/runs/${two}`).reverse(), r2.commits);
  assert.ok(r1.commits.length > 0 && r2.commits.length > 0);
  assert.deepEqual(r1.commits.filter((c) => r2.commits.includes(c)), []);
  assert.deepEqual(treeFiles(repo, `runs/${one}`), ["README.md", "a1.txt", "a2.txt"]);
  assert.deepEqual(treeFiles(repo, `runs/${two}`), ["README.md", "b1.txt", "b2.txt"]);

  // The host checkout, index, HEAD and main branch are byte-identical.
  assert.deepEqual(hostSnapshot(repo), before);
  // No git worktree exists: only the main checkout is listed, and git keeps no worktree metadata.
  const worktrees = git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));
  assert.deepEqual(worktrees, [`worktree ${repo}`]);
  assert.equal(existsSync(join(repo, ".git", "worktrees")), false);
});

test("concurrent-fetch check: results fetched into one repository at the same moment, with packed refs, all land intact", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ca-fetch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  commitedRepo(repo);
  const identity = { name: "culture-agents run", email: "runs@culture-agents.invalid" };
  const ids = ["a", "b", "c", "d", "e", "f"].map((s) => `thor-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D${s.toUpperCase()}`);
  const spaces = await Promise.all(ids.map((id) => new StubWorkspaceFactory(id, repo, { ref: "HEAD", identity }).open(new AbortController().signal)));
  t.after(() => Promise.all(spaces.map((ws) => ws.destroy())));
  const before = hostSnapshot(repo);
  for (let round = 0; round < 6; round += 1) {
    await Promise.all(spaces.map((ws, i) => {
      writeFileSync(join(ws.workdir, `f${i}-${round}.txt`), `${i} ${round}\n`);
      return ws.commitAll(`round ${round}`);
    }));
    if (round % 2 === 0) git(repo, "pack-refs", "--all"); // runs/<id> refs live in packed-refs from here on
    const collected = await Promise.all(spaces.map((ws) => ws.collect()));
    for (const [i, ws] of spaces.entries()) {
      assert.equal(collected[i]?.commit, git(ws.workdir, "rev-parse", "HEAD"), `round ${round}: run ${i} fetched its own head`);
      assert.equal(git(repo, "rev-parse", `refs/heads/runs/${ids[i] ?? ""}`), git(ws.workdir, "rev-parse", "HEAD"));
    }
  }
  for (const [i, id] of ids.entries()) {
    const files = treeFiles(repo, `runs/${id}`).filter((f) => f.endsWith(".txt"));
    assert.ok(files.every((f) => f.startsWith(`f${i}-`)), `runs/${id} holds only its own files`);
    assert.equal(files.length, 6);
  }
  git(repo, "fsck", "--no-progress");
  assert.deepEqual(hostSnapshot(repo), before);
});
