import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CommandOptions, CommandRunner } from "../../src/sandbox/host-command.js";
import { runCommand } from "../../src/sandbox/host-command.js";
import { createRunSandboxes } from "../../src/sandbox/run-sandboxes.js";
import { collect, HandoffError, prepare, sshHostAlias } from "../../src/sandbox/worktree.js";
import { FakeOpenShell, TEST_POLICY, must } from "./fake-openshell.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HOST = "/host/repo";
const SSH_CONFIG = "Host openshell-t-abc.default\n    User sandbox\n    ProxyCommand openshell ssh-proxy --name t-abc\n";

interface Recorded {
  file: string;
  args: readonly string[];
  options: CommandOptions;
}

/** Host git subcommands allowed to run inside the host repository. */
const HOST_READ_OR_FETCH = new Set(["rev-parse", "symbolic-ref", "fetch"]);
const FORBIDDEN = /^(checkout|switch|reset|restore|merge|rebase|pull|stash|clean|commit|add|rm|worktree|branch|update-ref|push|am|cherry-pick)$/;

function subcommand(args: readonly string[]): string {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "";
}

function recorder(overrides: (r: Recorded) => { code: number; stdout: string; stderr: string } | undefined = () => undefined) {
  const calls: Recorded[] = [];
  const runner: CommandRunner = async (file, args, options = {}) => {
    const rec = { file, args, options };
    calls.push(rec);
    const custom = overrides(rec);
    if (custom) return custom;
    const sub = subcommand(args);
    if (file === "openshell") return { code: 0, stdout: SSH_CONFIG, stderr: "" };
    if (sub === "rev-parse" && args.includes("--git-common-dir")) return { code: 0, stdout: `${HOST}/.git\n`, stderr: "" };
    if (sub === "rev-parse") return { code: 0, stdout: `${SHA}\n`, stderr: "" };
    if (sub === "symbolic-ref") return { code: 0, stdout: "refs/heads/main\n", stderr: "" };
    if (sub === "init") mkdirSync(join(must(args.at(-1)), "objects", "info"), { recursive: true });
    if (sub === "bundle") writeFileSync(must(args[2]), "# v2 git bundle\nfake-bundle-bytes");
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

function assertHostUntouched(calls: Recorded[]): void {
  for (const c of calls) {
    if (c.file !== "git") continue;
    assert.ok(!c.args.includes("-C"), `no -C redirection: ${c.args.join(" ")}`);
    const sub = subcommand(c.args);
    if (c.options.cwd?.includes("culture-agents-bundle-")) {
      // The throwaway staging repo: the only place a ref is written.
      assert.ok(["init", "update-ref", "bundle"].includes(sub), `staging repo runs ${sub}`);
      continue;
    }
    assert.doesNotMatch(sub, FORBIDDEN, `forbidden host-side git ${sub}`);
    if (c.options.cwd === HOST) {
      assert.ok(HOST_READ_OR_FETCH.has(sub), `only read/fetch in the host repo, got ${sub}`);
      assert.equal(c.options.env?.["GIT_DIR"], undefined);
      assert.equal(c.options.env?.["GIT_WORK_TREE"], undefined);
    }
    if (sub === "fetch") {
      const refspec = must(c.args.at(-1));
      assert.equal(refspec, "refs/heads/runs/r1:refs/heads/runs/r1", "non-forced fetch onto runs/<id> only");
    }
  }
}

async function sandboxWithClone(stdout = `${SHA}\n`, exitCode = 0) {
  const fake = new FakeOpenShell({
    onExec: (_n, script) =>
      script.startsWith("set -e;") ? { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from("boom") } : undefined,
  });
  const sandboxes = createRunSandboxes({ image: "i", prefix: "t-" }, { client: fake, policy: TEST_POLICY });
  return { fake, sb: await sandboxes.create("r1") };
}

test("prepare bundles in a throwaway repo, uploads, verifies and clones runs/<id>", async () => {
  const { calls, runner } = recorder();
  const { fake, sb } = await sandboxWithClone();
  const tree = await prepare(sb, { hostRepo: HOST, ref: "main", runId: "r1", runner, identity: { name: "run r1", email: "r1@runs.invalid" } });
  assert.deepEqual(tree, { branch: "runs/r1", baseCommit: SHA, path: "/sandbox/work" });

  const seq = calls.map((c) => `${c.options.cwd === HOST ? "host" : "stage"}:${subcommand(c.args)}`);
  assert.deepEqual(seq, ["host:rev-parse", "host:rev-parse", "stage:init", "stage:update-ref", "stage:bundle"]);
  assert.deepEqual(must(calls[0]).args, ["rev-parse", "--verify", "--quiet", "--end-of-options", "main^{commit}"]);
  assert.deepEqual(must(calls[3]).args, ["update-ref", "refs/heads/runs/r1", SHA]);
  assert.deepEqual(must(calls[4]).args.slice(-1), ["refs/heads/runs/r1"]);
  assertHostUntouched(calls);

  const uploaded = must(fake.sandboxes.get(sb.name)).files.get("/sandbox/.culture-agents/run.bundle");
  assert.equal(uploaded?.toString(), "# v2 git bundle\nfake-bundle-bytes");
  const clone = must(fake.execs.find((e) => e.script.startsWith("set -e;"))).script;
  assert.match(clone, /sha256sum -c --quiet/);
  assert.match(clone, /git clone --quiet -b 'runs\/r1' '\/sandbox\/\.culture-agents\/run\.bundle' '\/sandbox\/work'/);
  assert.match(clone, /git remote remove origin/);
  assert.match(clone, /git config user\.name 'run r1'/);
});

test("prepare fails loudly when the clone does not land on the base commit", async () => {
  const { runner } = recorder();
  const { sb } = await sandboxWithClone("deadbeef\n");
  await assert.rejects(prepare(sb, { hostRepo: HOST, ref: "main", runId: "r1", runner }), HandoffError);
  const failing = await sandboxWithClone("", 128);
  await assert.rejects(prepare(failing.sb, { hostRepo: HOST, ref: "main", runId: "r1", runner }), /exit 128/);
});

test("collect fetches runs/<id> over OpenShell's ssh config without touching the host tree", async () => {
  const { calls, runner } = recorder();
  const { sb } = await sandboxWithClone();
  const out = await collect(sb, { hostRepo: HOST, runId: "r1", runner, gatewayName: "openshell", openshellBin: "openshell" });
  assert.deepEqual(out, { branch: "runs/r1", commit: SHA });
  const cli = must(calls.find((c) => c.file === "openshell"));
  assert.deepEqual(cli.args, ["-g", "openshell", "sandbox", "ssh-config", sb.name]);
  const fetch = must(calls.find((c) => subcommand(c.args) === "fetch"));
  assert.equal(fetch.options.cwd, HOST);
  assert.ok(fetch.args.includes("ssh://openshell-t-abc.default/sandbox/work"));
  for (const flag of ["--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--end-of-options"]) {
    assert.ok(fetch.args.includes(flag), flag);
  }
  assert.match(fetch.options.env?.["GIT_SSH_COMMAND"] ?? "", /^ssh -F '.*culture-agents-ssh-.*\/ssh_config'$/);
  assert.equal(fetch.options.env?.["SSH_AUTH_SOCK"], undefined);
  assert.equal(fetch.options.env?.["GH_TOKEN"], undefined);
  assertHostUntouched(calls);
});

test("collect refuses when the host has runs/<id> checked out", async () => {
  const { calls, runner } = recorder((r) =>
    subcommand(r.args) === "symbolic-ref" ? { code: 0, stdout: "refs/heads/runs/r1\n", stderr: "" } : undefined,
  );
  const { sb } = await sandboxWithClone();
  await assert.rejects(collect(sb, { hostRepo: HOST, runId: "r1", runner }), /checked out/);
  assert.equal(calls.some((c) => subcommand(c.args) === "fetch"), false);
});

test("collect surfaces a refused (non-fast-forward) fetch", async () => {
  const { runner } = recorder((r) =>
    subcommand(r.args) === "fetch" ? { code: 1, stdout: "", stderr: "! [rejected] (non-fast-forward)" } : undefined,
  );
  const { sb } = await sandboxWithClone();
  await assert.rejects(collect(sb, { hostRepo: HOST, runId: "r1", runner }), /non-fast-forward/);
});

test("sshHostAlias reads the Host line", () => {
  assert.equal(sshHostAlias(SSH_CONFIG), "openshell-t-abc.default");
  assert.throws(() => sshHostAlias("User x\n"), HandoffError);
});

test("with real git, prepare leaves the host repo's branch, status and refs unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ca-wt-unit-"));
  try {
    const host = join(dir, "host");
    const g = (...args: string[]) => execFileSync("git", args, { cwd: host, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", "-b", "main", host]);
    writeFileSync(join(host, "a.txt"), "one\n");
    g("add", "a.txt");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two");
    writeFileSync(join(host, "dirty.txt"), "untracked\n");
    const before = { head: g("symbolic-ref", "HEAD"), status: g("status", "--porcelain"), refs: g("for-each-ref") };

    const { fake, sb } = await sandboxWithClone(`${g("rev-parse", "HEAD~1")}\n`);
    const tree = await prepare(sb, { hostRepo: host, ref: "HEAD~1", runId: "r1", runner: runCommand });
    assert.equal(tree.baseCommit, g("rev-parse", "HEAD~1"));
    assert.deepEqual({ head: g("symbolic-ref", "HEAD"), status: g("status", "--porcelain"), refs: g("for-each-ref") }, before);

    // The uploaded bundle is a real bundle carrying only runs/r1 at the base commit.
    const bundle = join(dir, "got.bundle");
    writeFileSync(bundle, must(must(fake.sandboxes.get(sb.name)).files.get("/sandbox/.culture-agents/run.bundle")));
    execFileSync("git", ["clone", "-q", "-b", "runs/r1", bundle, join(dir, "clone")]);
    const cloned = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(dir, "clone"), encoding: "utf8" }).trim();
    assert.equal(cloned, tree.baseCommit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
