/** Shared helpers for store and worker tests: temp state dirs, run records, process cleanup. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { buildRunId, buildSessionId, newUlid, type ActionRecord, type Run } from "../../src/contract/index.js";
import { checkLiveness } from "../../src/store/liveness.js";
import type { DriverSelection } from "../../src/worker/driver.js";
import type { FakeDriverOptions } from "../../src/worker/fake-driver.js";

export const AGENT = "spark-culture-agents";

export const FAKE_DRIVER_MODULE = fileURLToPath(new URL("../../src/worker/fake-driver.js", import.meta.url));
export const DAEMON_HELPER = fileURLToPath(new URL("./daemon-helper.js", import.meta.url));

export function fakeDriver(options: FakeDriverOptions): DriverSelection {
  return { module: FAKE_DRIVER_MODULE, options };
}

/** A fresh temp state dir, removed after the test (and any worker in it killed first). */
export function stateDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ca-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  const until = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
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
