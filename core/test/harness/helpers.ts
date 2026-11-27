/** Shared helpers for the harness tests: temp host repos, run records, fakes, event collection. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { buildRunId, buildSessionId, newUlid, type Run } from "../../src/contract/index.js";
import { hostEnv } from "../../src/sandbox/host-command.js";
import type { DriverEvent } from "../../src/worker/driver.js";

export const AGENT = "thor-culture-agents";

/** git by absolute path, from fixed system directories only: never whatever a writable PATH entry offers. */
export const GIT = ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/bin/git"].find((path) => existsSync(path)) ?? "/usr/bin/git";

/** A temp host repo on `main` with one commit and an uncommitted operator file. */
export function hostRepo(t: TestContext): { dir: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "ca-harness-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "host");
  execFileSync(GIT, ["init", "-q", "-b", "main", dir], { env: hostEnv() });
  const git = (...args: string[]) => execFileSync(GIT, args, { cwd: dir, encoding: "utf8", env: hostEnv() }).trim();
  writeFileSync(join(dir, "README"), "host\n");
  git("add", "README");
  git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "one");
  writeFileSync(join(dir, "operator-wip.txt"), "uncommitted operator work\n");
  return { dir, git };
}

export function newRun(repo: string, task: string, harness = "stub"): Run {
  const ulid = newUlid();
  const now = new Date().toISOString();
  return {
    id: buildRunId(AGENT, ulid),
    agent_id: AGENT,
    session_id: buildSessionId(AGENT, ulid),
    harness,
    repo,
    task,
    owner: { kind: "operator", id: "thor-operator" },
    idempotency_key: null,
    deadline: null,
    state: "queued",
    state_reason: null,
    terminal: false,
    created_at: now,
    updated_at: now,
    started_at: null,
    ended_at: null,
    cursor: 1,
    live_control: true,
    worker_pid: null,
    branch: null,
  };
}

export const outputs = (events: DriverEvent[], channel?: string) =>
  events.flatMap((e) => (e.type === "output" && (channel === undefined || e.data.channel === channel) ? [e.data] : []));

/** Drain a driver's stream, calling `onEvent` for each event (it may steer or cancel). */
export async function drive(
  stream: AsyncIterable<DriverEvent>,
  onEvent: (event: DriverEvent, seen: DriverEvent[]) => void | Promise<void> = () => undefined,
): Promise<DriverEvent[]> {
  const seen: DriverEvent[] = [];
  for await (const event of stream) {
    seen.push(event);
    await onEvent(event, seen);
  }
  return seen;
}

export const lastEvent = (events: DriverEvent[]) => events.at(-1);

/** Files on `runs/<id>` in the host repo, or null when the branch does not exist. */
export function branchFiles(git: (...a: string[]) => string, runId: string): string[] | null {
  try {
    return git("ls-tree", "--name-only", `runs/${runId}`).split("\n").filter(Boolean);
  } catch {
    return null;
  }
}
