/**
 * Run branches of one repository: list them with their run's state, and remove the finished ones
 * that git shows reachable from another ref (contract/branches.json).
 *
 * Evidence is git's, not a guess: `git merge-base --is-ancestor <tip> <other ref>` must exit 0 for
 * some ref that is not itself a `runs/` branch. Deletion is `git branch -d`, never `-D`, so git's
 * own merge check stands behind ours; a refusal from git is reported as a skip. A branch whose
 * run is active, unknown, unreadable or absent is never touched.
 */
import { isActive, isRunId, type Branch, type Branches, type RemoveResponse, type Run, type RunState } from "../contract/index.js";
import { hostEnv, runCommand, type CommandRunner } from "../sandbox/host-command.js";

const PREFIX = "refs/heads/runs/";

/** What the branch code needs to know of one run; a rejection means the run cannot be read. */
export type RunLookup = (runId: string) => Promise<Run | null>;

export interface BranchOptions {
  /** Canonical repository path (what a run's `repo` holds). */
  repo: string;
  lookup: RunLookup;
  runner?: CommandRunner;
}

interface RunView {
  state: RunState | null;
  note: string | null;
}

async function git(options: BranchOptions, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return (options.runner ?? runCommand)("git", ["-C", options.repo, ...args], { env: hostEnv(), timeoutMs: 60_000 });
}

async function gitOrThrow(options: BranchOptions, args: string[]): Promise<string> {
  const res = await git(options, args);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${res.code}): ${res.stderr.trim()}`);
  return res.stdout;
}

async function viewRun(options: BranchOptions, runId: string): Promise<RunView> {
  try {
    const run = await options.lookup(runId);
    if (run === null) return { state: null, note: "no run with this id is known to the core" };
    if (run.repo !== options.repo) return { state: null, note: `the run belongs to another repository (${run.repo})` };
    return { state: run.state, note: null };
  } catch (err) {
    return { state: null, note: `the run cannot be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Why a branch whose run reads like this must not be deleted, or null when its run is finished. */
function runBlocker(view: RunView): string | null {
  if (view.state === null) return view.note ?? "the run is not known";
  if (isActive(view.state)) return `its run is active (${view.state})`;
  if (view.state === "unknown") return "its run's outcome is unknown, so its commits may not have been collected";
  return null;
}

/** Refs a run branch's commits may be reachable from: local branches that are not run branches, and remote-tracking refs. */
async function otherRefs(options: BranchOptions): Promise<string[]> {
  const out = await gitOrThrow(options, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  return out.split("\n").filter((r) => r !== "" && !r.startsWith(PREFIX) && !r.endsWith("/HEAD"));
}

const short = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, "");

async function mergedInto(options: BranchOptions, tip: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const res = await git(options, ["merge-base", "--is-ancestor", tip, ref]);
    if (res.code === 0) return short(ref);
  }
  return null;
}

/** Every `runs/<run id>` branch of the repository, with its run's state and the reachability evidence. */
export async function listBranches(options: BranchOptions): Promise<Branches> {
  const out = await gitOrThrow(options, ["for-each-ref", "--format=%(refname)%00%(objectname)", PREFIX.slice(0, -1)]);
  const refs = await otherRefs(options);
  const branches: Branch[] = [];
  for (const line of out.split("\n")) {
    const [ref, tip] = line.split("\0");
    if (!ref || !tip) continue;
    const name = ref.slice("refs/heads/".length);
    const runId = name.slice("runs/".length);
    if (!isRunId(runId)) continue; // not a branch this core made
    const view = await viewRun(options, runId);
    branches.push({ branch: name, run_id: runId, state: view.state, state_note: view.note, tip, merged_into: await mergedInto(options, tip, refs) });
  }
  return { repo: options.repo, branches };
}

/** Delete what may be deleted; with `dryRun` only report it. Every branch lands in `removed` or `skipped`. */
export async function removeBranches(options: BranchOptions, dryRun: boolean): Promise<RemoveResponse> {
  const { branches } = await listBranches(options);
  const result: RemoveResponse = { repo: options.repo, dry_run: dryRun, removed: [], skipped: [] };
  for (const b of branches) {
    const skip = (reason: string): void => void result.skipped.push({ branch: b.branch, run_id: b.run_id, state: b.state, reason });
    const blocker = runBlocker({ state: b.state, note: b.state_note });
    if (blocker !== null) skip(blocker);
    else if (b.merged_into === null) skip("git shows no other ref containing its commits (they would be lost)");
    else if (dryRun) result.removed.push(b);
    else {
      const res = await git(options, ["branch", "-d", "--", b.branch]);
      if (res.code === 0) result.removed.push(b);
      else skip(`git refused to delete it: ${(res.stderr || res.stdout).trim()}`);
    }
  }
  return result;
}
