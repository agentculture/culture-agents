/**
 * Starting a run's worker and reaching it later.
 *
 * `spawnWorker` resolves only after the durability condition holds: the worker's identity
 * (pid), its event log with event 1 (`null` -> `queued`) and its cursor are on disk, owner-only,
 * and its control socket answers. Only then may the daemon acknowledge the submit (README,
 * order of checks for runs.submit, step 7).
 *
 * `reconnectWorker` finds a surviving worker after a daemon restart and reports whether its
 * control socket answers. It never signals or terminates the worker.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ActionRecord, Run, RunId } from "../contract/index.js";
import { readCursorFile, readLog } from "../store/event-log.js";
import { FILE_MODE, runDir, runFile, type RunFile } from "../store/files.js";
import { checkLiveness, readWorkerIdentity, type Liveness } from "../store/liveness.js";
import { createRun } from "../store/run-store.js";
import { ControlUnavailableError, controlRequest, type ControlReply, type ControlRequest } from "./control.js";
import { settleFromLog } from "./delivery.js";
import type { DriverSelection } from "./driver.js";

/** The compiled worker entry point. */
export const WORKER_ENTRY = fileURLToPath(new URL("./main.js", import.meta.url));

/** Live control of one worker over its control socket. */
export class WorkerControl {
  constructor(
    readonly runDir: string,
    private readonly timeoutMs = 2000,
  ) {}

  ping(): Promise<ControlReply> {
    return controlRequest(this.runDir, { op: "ping" }, this.timeoutMs);
  }
  steer(action: ActionRecord, message: string): Promise<ControlReply> {
    return this.deliver({ op: "steer", action, message }, "run.control");
  }
  cancel(action: ActionRecord, reason?: string): Promise<ControlReply> {
    const req = reason === undefined ? { op: "cancel" as const, action } : { op: "cancel" as const, action, reason };
    return this.deliver(req, "run.control");
  }
  /** Have the worker record a refusal the core decided (`run.refused`). */
  refuse(action: ActionRecord): Promise<ControlReply> {
    return this.deliver({ op: "refuse", action }, "run.refused");
  }

  /** Send an action; with no reply, settle its outcome from the run's log (see `settleFromLog`). */
  private async deliver(request: ControlRequest & { action: ActionRecord }, recordedAs: "run.control" | "run.refused"): Promise<ControlReply> {
    try {
      return await controlRequest(this.runDir, request, this.timeoutMs);
    } catch (err) {
      if (err instanceof ControlUnavailableError) return settleFromLog(this.runDir, request.action, recordedAs, err);
      throw err;
    }
  }
}

export interface SpawnWorkerOptions {
  stateDir: string;
  /** The new run's record, in state `queued` with cursor 1 and no worker yet. */
  run: Run;
  driver: DriverSelection;
  /** How long to wait for the durability condition. Default 10 000 ms. */
  readyTimeoutMs?: number;
  heartbeatMs?: number;
  cancelGraceMs?: number;
  /** Environment of the worker process. Default: this process's environment. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnedWorker {
  runId: RunId;
  runDir: string;
  pid: number;
  control: WorkerControl;
}

/** The worker did not reach the durability condition; nothing may be acknowledged. */
export class WorkerSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerSpawnError";
  }
}

const DURABLE_FILES: RunFile[] = ["record", "events", "cursor", "worker"];

/** Whether pid, event 1 and cursor are on disk for `pid`; throws if a file is not owner-only. */
function filesDurable(dir: string, runId: RunId, pid: number): boolean {
  if (readWorkerIdentity(dir)?.pid !== pid) return false;
  const first = readLog(dir, runId).events[0];
  if (first?.cursor !== 1) return false;
  if ((readCursorFile(dir) ?? 0) < 1) return false;
  for (const file of DURABLE_FILES) {
    const mode = statSync(runFile(dir, file)).mode & 0o777;
    if (mode !== FILE_MODE) throw new WorkerSpawnError(`${file} has mode ${mode.toString(8)}, not 600`);
  }
  return true;
}

async function controlReady(dir: string, pid: number): Promise<boolean> {
  try {
    const reply = await controlRequest(dir, { op: "ping" }, 500);
    return reply.ok && reply.pid === pid;
  } catch (err) {
    if (err instanceof ControlUnavailableError) return false;
    throw err;
  }
}

/** Create the run, start its worker detached, and resolve once the worker's files are durable. */
export async function spawnWorker(options: SpawnWorkerOptions): Promise<SpawnedWorker> {
  const { stateDir, run } = options;
  if (run.state !== "queued" || run.worker_pid !== null) throw new RangeError("a new run must be queued with no worker");
  const dir = createRun(stateDir, run);
  writeFileSync(runFile(dir, "driver"), `${JSON.stringify(options.driver)}\n`, { mode: FILE_MODE, flag: "wx" });
  const args = [WORKER_ENTRY, "--state-dir", stateDir, "--run-id", run.id];
  if (options.heartbeatMs !== undefined) args.push("--heartbeat-ms", String(options.heartbeatMs));
  if (options.cancelGraceMs !== undefined) args.push("--cancel-grace-ms", String(options.cancelGraceMs));
  const logFd = openSync(runFile(dir, "log"), "a", FILE_MODE);
  let exited: string | null = null;
  const child = (() => {
    try {
      // detached: own session and process group, so the daemon's death or terminal does not reach it.
      return spawn(process.execPath, args, {
        cwd: dir,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: options.env ?? process.env,
      });
    } finally {
      closeSync(logFd);
    }
  })();
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => (exited = signal ?? `exit ${String(code)}`);
  child.once("exit", onExit);
  child.once("error", (err) => (exited = err.message));
  child.unref();
  const pid = child.pid;
  try {
    if (pid === undefined) throw new WorkerSpawnError(`the worker could not be started: ${exited ?? "no pid"}`);
    const deadline = Date.now() + (options.readyTimeoutMs ?? 10_000);
    for (;;) {
      // Durable on disk, and either controllable or already finished (a very short run may end
      // before the first ping; its files still hold, so the submit may be acknowledged).
      const ended = exited !== null;
      if (filesDurable(dir, run.id, pid) && (ended || (await controlReady(dir, pid)))) break;
      if (ended) throw new WorkerSpawnError(`the worker exited before its run was durable (${exited}); see ${runFile(dir, "log")}`);
      if (Date.now() > deadline) throw new WorkerSpawnError(`the worker did not make its run durable in time; see ${runFile(dir, "log")}`);
      await delay(5);
    }
  } catch (err) {
    if (pid !== undefined && exited === null) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    throw err;
  } finally {
    child.off("exit", onExit);
  }
  return { runId: run.id, runDir: dir, pid, control: new WorkerControl(dir) };
}

export type Reconnect =
  | { live: true; liveness: Liveness; control: WorkerControl }
  | { live: false; liveness: Liveness; reason: string };

/**
 * Reach a surviving worker's control socket. `live: false` (with the reason) when the worker is
 * not alive or does not answer. Note: in API 1.0 a restarted core still reports such a run with
 * `live_control: false` (README: after a core restart); this only establishes reachability.
 */
export async function reconnectWorker(stateDir: string, runId: RunId, timeoutMs = 1000): Promise<Reconnect> {
  const dir = runDir(stateDir, runId);
  const liveness = checkLiveness(dir);
  if (!liveness.alive) return { live: false, liveness, reason: liveness.reason };
  const control = new WorkerControl(dir, timeoutMs);
  try {
    const reply = await control.ping();
    if (reply.ok && reply.pid === liveness.pid) return { live: true, liveness, control };
    return { live: false, liveness, reason: reply.ok ? "a different process answered the control socket" : reply.error.message };
  } catch (err) {
    return { live: false, liveness, reason: err instanceof Error ? err.message : String(err) };
  }
}
