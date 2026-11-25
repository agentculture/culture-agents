/** Shared helpers for store and worker tests: temp state dirs, run records, process cleanup. */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { buildRunId, buildSessionId, newUlid, type ActionRecord, type Run } from "../../src/contract/index.js";
import { checkLiveness, readWorkerIdentity } from "../../src/store/liveness.js";
import { pollUntil } from "../../src/util/sequence.js";
import type { DriverSelection } from "../../src/worker/driver.js";
import type { FakeDriverOptions } from "../../src/worker/fake-driver.js";

export const AGENT = "spark-culture-agents";

export const FAKE_DRIVER_MODULE = fileURLToPath(new URL("../../src/worker/fake-driver.js", import.meta.url));
export const DAEMON_HELPER = fileURLToPath(new URL("./daemon-helper.js", import.meta.url));

export function fakeDriver(options: FakeDriverOptions): DriverSelection {
  return { module: FAKE_DRIVER_MODULE, options };
}

/**
 * A fresh temp state dir, removed after the test. A worker that just reached its terminal event may
 * still be removing its socket and closing files, so removal retries ENOTEMPTY briefly.
 */
export function stateDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ca-store-"));
  // Hooks run in registration order, so this one runs before `killAfter`: stop the store's workers
  // here first, or a worker still writing its heartbeat makes the removal fail (ENOTEMPTY).
  t.after(async () => {
    const pids: number[] = [];
    try {
      for (const run of readdirSync(join(dir, "runs"))) {
        const runDir = join(dir, "runs", run);
        const pid = checkLiveness(runDir).alive ? readWorkerIdentity(runDir)?.pid : undefined;
        if (pid !== undefined && pid !== process.pid) pids.push(pid); // a test may record itself as the worker
      }
    } catch {
      // no runs directory: nothing was spawned
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    const deadline = Date.now() + 5000;
    await pollUntil(() => !pids.some(processExists) || Date.now() >= deadline, { everyMs: 20 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return dir;
}

/** SIGKILL `pid` after the test if it is still the process we started. */
export function killAfter(t: TestContext, pid: number, runDir?: string): void {
  t.after(() => {
    if (runDir !== undefined && !checkLiveness(runDir).alive) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  });
}

/** A valid new run record: queued, cursor 1, no worker. */
export function newRun(overrides: Partial<Run> = {}): Run {
  const ulid = newUlid();
  const now = new Date().toISOString();
  return {
    id: buildRunId(AGENT, ulid),
    agent_id: AGENT,
    session_id: buildSessionId(AGENT, ulid),
    harness: "fake",
    repo: "/srv/repos/demo",
    task: "Do the thing.",
    owner: { kind: "operator", id: "spark-operator" },
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
    ...overrides,
  };
}

export function action(run: Run, kind: ActionRecord["kind"], outcome: ActionRecord["outcome"] = "accepted"): ActionRecord {
  return {
    id: `${run.agent_id}.act.${newUlid()}`,
    run_id: run.id,
    kind,
    caller: { kind: "operator", id: "spark-operator" },
    requested_at: new Date().toISOString(),
    idempotency_key: null,
    outcome,
    error: null,
  };
}

/** Poll `predicate` until it holds; fails after `timeoutMs`. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, what = "condition"): Promise<void> {
  if (!(await pollUntil(predicate, { everyMs: 10, timeoutMs }))) throw new Error(`timed out waiting for ${what}`);
}

/** Whether a process with this pid exists (and is not a zombie). */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return true;
}
