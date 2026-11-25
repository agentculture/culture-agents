// Working-tree handoff (decided in docs/d0/decisions.md): the repository enters
// the sandbox as a git bundle and is cloned there; the host fetches the run's
// commits straight from the sandbox over SSH into `runs/<id>`.
//
// The host repository is only ever read (rev-parse, symbolic-ref) and fetched
// into (one non-forced refspec onto runs/<id>). No command here checks out,
// resets, switches, merges, commits, or writes the host working tree or the
// host's current branch. The bundle is built in a throwaway bare repository
// that borrows the host's objects through `objects/info/alternates`, so not
// even a temporary ref is written to the host.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { hostEnv, runCommand, type CommandRunner } from "./host-command.js";
import { runBranch } from "./naming.js";
import { shellQuote } from "./run-sandbox.js";
import type { RunSandbox } from "./types.js";

/** Where the bundle lands inside the sandbox, relative to its home. */
export const SANDBOX_BUNDLE = ".culture-agents/run.bundle";
export const DEFAULT_WORKDIR = "work";

export class HandoffError extends Error {
  override readonly name = "HandoffError";
}

export interface PrepareOptions {
  /** Path to the host repository (any worktree of it). Read only. */
  readonly hostRepo: string;
  /** Branch name or commit to start the run from. */
  readonly ref: string;
  readonly runId: string;
  /** Clone directory name under the sandbox home (default `work`). */
  readonly workdir?: string;
  /** Commit identity configured in the sandbox clone (not the operator's). */
  readonly identity?: { readonly name: string; readonly email: string };
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
}

export interface PreparedTree {
  /** Branch checked out in the sandbox clone: `runs/<id>`. */
  readonly branch: string;
  /** Commit the run starts from. */
  readonly baseCommit: string;
  /** Absolute path of the clone inside the sandbox. */
  readonly path: string;
}

export interface CollectOptions {
  readonly hostRepo: string;
  readonly runId: string;
  /** Absolute clone path inside the sandbox (from prepare); default `<home>/work`. */
  readonly remotePath?: string;
  /** `openshell` CLI used for `sandbox ssh-config` (default: `openshell` on PATH). */
  readonly openshellBin?: string;
  /** Gateway name passed as `-g` to the CLI, when not the CLI's default. */
  readonly gatewayName?: string;
  /** The commit the run started from; when given, the result lists the commits after it. */
  readonly baseCommit?: string;
  readonly runner?: CommandRunner;
}

export interface CollectedTree {
  readonly branch: string;
  /** Tip of `runs/<id>` in the host repository after the fetch. */
  readonly commit: string;
  /** Commits after `baseCommit` on the branch, oldest first; empty when no base was given. */
  readonly commits: string[];
}

async function git(
  runner: CommandRunner,
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<string> {
  const res = await runner("git", args, { cwd, env: env ?? hostEnv() });
  if (res.code !== 0) {
    throw new HandoffError(`git ${args.join(" ")} failed (exit ${res.code}): ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}

/** Bundle `ref` of the host repo, upload it, and clone it as `runs/<id>` inside the sandbox. */
export async function prepare(sandbox: RunSandbox, options: PrepareOptions): Promise<PreparedTree> {
  const runner = options.runner ?? runCommand;
  const branch = runBranch(options.runId);
  const host = options.hostRepo;
  options.signal?.throwIfAborted();
  const base = await git(runner, host, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${options.ref}^{commit}`,
  ]);
  const commonDir = await git(runner, host, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

  const stage = await mkdtemp(join(tmpdir(), "culture-agents-bundle-"));
  try {
    const bare = join(stage, "stage.git");
    const bundlePath = join(stage, "run.bundle");
    await git(runner, stage, ["init", "--bare", "--quiet", bare]);
    await writeFile(join(bare, "objects", "info", "alternates"), `${join(commonDir, "objects")}\n`);
    await git(runner, bare, ["update-ref", `refs/heads/${branch}`, base]);
    await git(runner, bare, ["bundle", "create", bundlePath, `refs/heads/${branch}`]);
    const bytes = await readFile(bundlePath);
    const digest = createHash("sha256").update(bytes).digest("hex");

    options.signal?.throwIfAborted();
    await sandbox.writeFile(SANDBOX_BUNDLE, bytes, options.signal ? { signal: options.signal } : {});
    const path = posix.join(sandbox.home, options.workdir ?? DEFAULT_WORKDIR);
    const b = shellQuote(posix.join(sandbox.home, SANDBOX_BUNDLE));
    const w = shellQuote(path);
    const identity = options.identity
      ? `git config user.name ${shellQuote(options.identity.name)} && ` +
        `git config user.email ${shellQuote(options.identity.email)} && `
      : "";
    // A bundle made from a branch carries no HEAD, so the clone names the branch.
    const script =
      `set -e; echo ${shellQuote(`${digest}  ${posix.join(sandbox.home, SANDBOX_BUNDLE)}`)} | sha256sum -c --quiet; ` +
      `rm -rf ${w}; git clone --quiet -b ${shellQuote(branch)} ${b} ${w}; cd ${w}; ` +
      `git remote remove origin; ${identity}rm -f ${b}; git rev-parse HEAD`;
    const res = await sandbox.exec(script, options.signal ? { signal: options.signal } : {});
    const head = Buffer.from(res.stdout).toString("utf8").trim().split("\n").pop();
    if (res.exitCode !== 0 || head !== base) {
      throw new HandoffError(
        `clone in sandbox failed (exit ${res.exitCode}, head ${head ?? "?"}): ` +
          Buffer.from(res.stderr).toString("utf8").trim(),
      );
    }
    return { branch, baseCommit: base, path };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Parse the `Host` alias from `openshell sandbox ssh-config` output. */
export function sshHostAlias(config: string): string {
  const match = /^Host\s+(\S+)\s*$/m.exec(config);
  if (!match?.[1]) throw new HandoffError("openshell ssh-config printed no Host entry");
  return match[1];
}

/** Fetch `runs/<id>` from the sandbox over OpenShell's SSH into the host repo. */
export async function collect(sandbox: RunSandbox, options: CollectOptions): Promise<CollectedTree> {
  const runner = options.runner ?? runCommand;
  const branch = runBranch(options.runId);
  const host = options.hostRepo;
  const target = `refs/heads/${branch}`;

  const head = await runner("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: host, env: hostEnv() });
  if (head.code === 0 && head.stdout.trim() === target) {
    throw new HandoffError(`host repository has ${branch} checked out; refusing to fetch into it`);
  }

  const cli = options.openshellBin ?? "openshell";
  const gw = options.gatewayName ? ["-g", options.gatewayName] : [];
  const cfg = await runner(cli, [...gw, "sandbox", "ssh-config", sandbox.name], { env: hostEnv() });
  if (cfg.code !== 0) throw new HandoffError(`openshell sandbox ssh-config failed: ${cfg.stderr.trim()}`);
  const alias = sshHostAlias(cfg.stdout);

  const dir = await mkdtemp(join(tmpdir(), "culture-agents-ssh-"));
  try {
    const cfgPath = join(dir, "ssh_config");
    await writeFile(cfgPath, cfg.stdout, { mode: 0o600 });
    const remotePath = options.remotePath ?? posix.join(sandbox.home, DEFAULT_WORKDIR);
    const env = hostEnv({ GIT_SSH_COMMAND: `ssh -F ${shellQuote(cfgPath)}`, GIT_SSH_VARIANT: "ssh" });
    // Non-forced refspec: a runs/<id> that has diverged is refused, not overwritten.
    await git(
      runner,
      host,
      [
        "-c", "gc.auto=0",
        "-c", "maintenance.auto=false",
        "-c", "protocol.allow=never",
        "-c", "protocol.ssh.allow=always",
        "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules",
        "--end-of-options",
        `ssh://${alias}${remotePath}`,
        `${target}:${target}`,
      ],
      env,
    );
    const commit = await git(runner, host, ["rev-parse", "--verify", "--quiet", target]);
    if (options.baseCommit) {
      // The sandbox is not trusted: the branch it hands back must continue the commit the run started from.
      const descends = await runner("git", ["merge-base", "--is-ancestor", options.baseCommit, target], { cwd: host, env: hostEnv() });
      if (descends.code !== 0) {
        await runner("git", ["update-ref", "-d", target, commit], { cwd: host, env: hostEnv() });
        throw new HandoffError(`${branch} from the sandbox does not descend from the run's base commit ${options.baseCommit}; the branch was not kept`);
      }
    }
    const listed = options.baseCommit ? await git(runner, host, ["rev-list", "--reverse", `${options.baseCommit}..${target}`]) : "";
    return { branch, commit, commits: listed.split("\n").filter(Boolean) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
