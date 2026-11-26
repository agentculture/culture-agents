/**
 * The commit a run starts from, resolved once when the submit is accepted (README, order of checks
 * for runs.submit). The worker builds the sandbox from this commit, not from whatever the host's
 * HEAD is by the time the sandbox is ready. The repository is only read.
 */
import { invalid } from "../daemon/errors.js";
import { hostEnv, runCommand, type CommandRunner } from "../sandbox/host-command.js";
import type { Run } from "../contract/index.js";

type Options = { sandbox?: { ref?: unknown }; ref?: unknown } | null | undefined;

/** The ref a driver was configured to start from (`HEAD` unless its options name another). */
export function startRef(options: unknown): string {
  const o = options as Options;
  const ref = o?.sandbox?.ref ?? o?.ref;
  return typeof ref === "string" && ref !== "" ? ref : "HEAD";
}

/** Resolve `ref` of `repo` to a full commit, or refuse the submit with `invalid` (field `repo`). */
export async function resolveBaseCommit(repo: string, ref: string, runner: CommandRunner = runCommand): Promise<NonNullable<Run["base_commit"]>> {
  const res = await runner("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { cwd: repo, env: hostEnv() });
  const sha = res.stdout.trim();
  if (res.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
    throw invalid(`Repository ${repo} has no commit to start from: ${ref} does not resolve to a commit (a repository with no commits, or a ref that does not exist); commit once, then submit again.`, "repo");
  }
  return sha;
}
