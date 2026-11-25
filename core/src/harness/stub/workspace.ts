/**
 * The stub's workspace: a throwaway clone of the host repository in the system temp dir, on
 * branch `runs/<id>`. Collect fetches that branch back into the host repository with the same
 * guarantees as the sandbox handoff: the host is only read and fetched into (one non-forced
 * refspec onto `runs/<id>`); its checkout, branch and status never change. No sandbox, no
 * vendor package: git on the host only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostEnv, runCommand } from "../../sandbox/host-command.js";
import type { Collected, Proc, Workspace, WorkspaceFactory } from "../common/types.js";

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runCommand("git", args, { cwd, env: hostEnv() });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${res.code}): ${res.stderr.trim()}`);
  return res.stdout.trim();
}

export interface StubWorkspaceSettings {
  ref: string;
  identity: { name: string; email: string };
}

export class StubWorkspace implements Workspace {
  private destroyed: Promise<void> | null = null;

  constructor(
    readonly workdir: string,
    private readonly root: string,
    private readonly hostRepo: string,
    private readonly branch: string,
    private readonly baseCommit: string,
  ) {}

  async processes(): Promise<Proc[]> {
    return [];
  }

  async kill(): Promise<void> {
    // The stub starts no process (see `processes`), so there is never anything to kill.
  }

  async commitAll(message: string): Promise<number> {
    await git(this.workdir, ["add", "-A"]);
    const staged = await runCommand("git", ["diff", "--cached", "--quiet"], { cwd: this.workdir, env: hostEnv() });
    if (staged.code !== 0) await git(this.workdir, ["commit", "-q", "--no-verify", "-m", message]);
    return Number(await git(this.workdir, ["rev-list", "--count", `${this.baseCommit}..HEAD`]));
  }

  async collect(): Promise<Collected | null> {
    const count = Number(await git(this.workdir, ["rev-list", "--count", `${this.baseCommit}..HEAD`]));
    if (count === 0) return null;
    const target = `refs/heads/${this.branch}`;
    const head = await runCommand("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: this.hostRepo, env: hostEnv() });
    if (head.code === 0 && head.stdout.trim() === target) throw new Error(`host repository has ${this.branch} checked out`);
    await git(this.hostRepo, ["-c", "gc.auto=0", "fetch", "--no-tags", "--no-write-fetch-head", "--end-of-options", this.workdir, `${target}:${target}`]);
    const shas = (await git(this.hostRepo, ["rev-list", "--reverse", `${this.baseCommit}..${target}`])).split("\n").filter(Boolean);
    return { branch: this.branch, commit: await git(this.hostRepo, ["rev-parse", "--verify", target]), commits: count, shas };
  }

  destroy(): Promise<void> {
    this.destroyed ??= rm(this.root, { recursive: true, force: true });
    return this.destroyed;
  }
}

export class StubWorkspaceFactory implements WorkspaceFactory<StubWorkspace> {
  constructor(
    private readonly runId: string,
    private readonly hostRepo: string,
    private readonly settings: StubWorkspaceSettings,
  ) {}

  async open(signal: AbortSignal): Promise<StubWorkspace> {
    signal.throwIfAborted();
    const base = await git(this.hostRepo, ["rev-parse", "--verify", "--end-of-options", `${this.settings.ref}^{commit}`]);
    const branch = `runs/${this.runId}`;
    const root = await mkdtemp(join(tmpdir(), "culture-agents-stub-"));
    try {
      const workdir = join(root, "work");
      await git(root, ["clone", "-q", "--no-checkout", "--", this.hostRepo, workdir]);
      await git(workdir, ["checkout", "-q", "-b", branch, base]);
      await git(workdir, ["remote", "remove", "origin"]);
      await git(workdir, ["config", "user.name", this.settings.identity.name]);
      await git(workdir, ["config", "user.email", this.settings.identity.email]);
      signal.throwIfAborted();
      return new StubWorkspace(workdir, root, this.hostRepo, branch, base);
    } catch (err) {
      await rm(root, { recursive: true, force: true });
      throw err;
    }
  }
}
