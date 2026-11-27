/**
 * A run's commits across hosts (contract 3.3, spec c39 and h28; docs/d2/run-bundles.md): the
 * executing core serves a finished run's branch as a git bundle over the fleet transport, and the
 * calling core passes it on through its control socket, so the caller's CLI fetches the branch into
 * its own checkout. No shell, account or SSH on the executing host is involved.
 *
 * - **Only that run's ref.** The bundle is `git bundle create <file> refs/heads/runs/<id> ^<base>`:
 *   one ref, the run's branch, and only the commits after the run's base commit, which is the
 *   bundle's one prerequisite. No other branch, tag or commit of the executing host travels.
 * - **Only to a caller allowed to read the run.** Over the fleet transport, only the member that
 *   submitted the run (serve-runs.ts checks this before anything of the run is read); on the
 *   control socket, its owner, the local operator. Result and logs follow the same rule.
 * - **Not redacted, but marked.** Logs, attach and the bundle cross hosts as the executing core
 *   stored them. Each cross-host response of these carries `Agents-Content-Sensitivity: unredacted`,
 *   an HTTP header, so no schema gained a field (the design record's note on t26).
 * - **Bounded.** A bundle is at most 64 MiB, and its one call to the member has 60 s (every other
 *   call between cores keeps 5 s). A larger bundle is refused on the executing core before it is sent.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Run, RunResult } from "../contract/index.js";
import { ControlError, notFound, unsupported } from "../daemon/errors.js";
import { hostEnv, runCommand, type CommandRunner } from "../sandbox/host-command.js";
import type { Remote } from "./remote.js";

/** The MINOR that added a remote run's result, logs and bundle: a member that announced less does not serve them. */
export const REMOTE_RESULTS_SINCE = "3.3";
export const REMOTE_RESULTS_WHAT = "a remote run's result, logs and bundle";
export const BUNDLE_CONTENT_TYPE = "application/x-git-bundle";
export const SENSITIVITY_HEADER = "Agents-Content-Sensitivity";
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const BUNDLE_TIMEOUT_MS = 60_000;

/** Mark a cross-host response whose content is the executing core's, unredacted. */
export function markUnredacted(res: ServerResponse): void {
  res.setHeader(SENSITIVITY_HEADER, "unredacted");
}

/** Whether `bytes` begins as a git bundle (version 2 or 3) does. */
export function isBundle(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 16).toString("latin1");
  return head === "# v2 git bundle\n" || head === "# v3 git bundle\n";
}

function sendBundle(res: ServerResponse, bytes: Buffer): void {
  markUnredacted(res);
  res.writeHead(200, { "Content-Type": BUNDLE_CONTENT_TYPE, "Content-Length": bytes.length });
  res.end(bytes);
}

/** The bundle of a finished run's branch in its repository: one ref, the commits after its base. */
export async function makeRunBundle(run: Run, result: RunResult, node: string, runner: CommandRunner = runCommand): Promise<Buffer> {
  const none = notFound(`Run ${run.id} on ${node} has no commits to fetch.`, { run_id: run.id });
  if (result.branch === null || result.commits.length === 0) throw none;
  if (run.base_commit === undefined) throw new ControlError("internal", `Run ${run.id} has no recorded base commit.`);
  const dir = await mkdtemp(join(tmpdir(), "culture-agents-bundle-"));
  try {
    const file = join(dir, "run.bundle");
    // Both revisions are checked identifiers (a run id and a 40-hex commit id), never options.
    const made = await runner("git", ["-C", run.repo, "bundle", "create", "--quiet", file, `refs/heads/${result.branch}`, `^${run.base_commit}`], { env: hostEnv(), timeoutMs: BUNDLE_TIMEOUT_MS });
    if (made.code !== 0) {
      if (/empty bundle/i.test(made.stderr)) throw none;
      process.stderr.write(`culture-agents core: git bundle create for run ${run.id} failed (exit ${made.code}): ${made.stderr.trim().slice(0, 500)}\n`);
      throw new ControlError("internal", `git could not bundle run ${run.id} on ${node}.`);
    }
    if ((await stat(file)).size > MAX_BUNDLE_BYTES) {
      throw unsupported("placement", `The bundle of run ${run.id} on ${node} is larger than 64 MiB, the most one fetch across hosts carries; its operator can hand the branch over another way.`);
    }
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Executing core: the bundle of a run the caller may read (checked before this is called). */
export async function serveRunBundle(run: Run, result: RunResult, node: string, res: ServerResponse): Promise<void> {
  sendBundle(res, await makeRunBundle(run, result, node));
}

/** Calling core: read a run's bundle from the member that executes it and pass it on unchanged. */
export async function relayRunBundle(remote: Remote, node: string, runId: string, res: ServerResponse): Promise<void> {
  const bytes = await remote.fetchBytes(node, {
    path: `/v1/fleet/runs/${encodeURIComponent(runId)}/bundle`,
    maxBytes: MAX_BUNDLE_BYTES,
    timeoutMs: BUNDLE_TIMEOUT_MS,
    since: REMOTE_RESULTS_SINCE,
    what: REMOTE_RESULTS_WHAT,
    accept: isBundle,
  });
  sendBundle(res, bytes);
}
