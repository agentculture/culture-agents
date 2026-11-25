/**
 * Worker liveness evidence. A worker records its pid together with its process start time
 * (`/proc/<pid>/stat` field 22, clock ticks since boot) and the kernel boot id. A worker is
 * alive only when a process with that pid exists now, is not a zombie, and has the same start
 * time on the same boot. A reused pid has a different start time, so it is never mistaken for
 * the worker. The heartbeat is reported as supporting evidence; it never makes a dead worker
 * alive and never makes a live (but slow or stopped) worker dead (README: a worker that is
 * alive is never reported as `unknown`).
 *
 * Platform: Linux `/proc`. Without `/proc` the identity cannot be checked; the fallback is
 * `kill(pid, 0)` plus a fresh heartbeat, and the result says it is weaker.
 */
import { readFileSync } from "node:fs";

import { atomicWrite, atomicWriteJson, nowIso, runFile } from "./files.js";

/** Contents of `worker.json`. */
export interface WorkerIdentity {
  pid: number;
  /** `/proc/<pid>/stat` start time (clock ticks after boot), or null without `/proc`. */
  start_time: string | null;
  /** `/proc/sys/kernel/random/boot_id`, or null without `/proc`. */
  boot_id: string | null;
  started_at: string;
}

export interface Liveness {
  alive: boolean;
  /** The recorded worker pid, or null when no worker was ever recorded. */
  pid: number | null;
  /** How the verdict was reached, for diagnostics. */
  reason: string;
  /** The worker's last heartbeat, if any. */
  heartbeat_at: string | null;
}

interface ProcStat {
  state: string;
  startTime: string;
}

/**
 * The liveness evidence could not be read (for example EMFILE, ENFILE, ENOMEM, EIO, EACCES), so the
 * worker is neither known alive nor known dead. Callers must not settle the run on this read: a
 * request fails, and a follower checks again on its next tick.
 */
export class LivenessUnknownError extends Error {
  override readonly name = "LivenessUnknownError";
  constructor(what: string, cause: unknown) {
    super(`worker liveness cannot be established: ${what}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** Error codes that mean "this file or process does not exist" (a `/proc` entry that vanishes mid-read gives ESRCH). */
const ABSENT = new Set(["ENOENT", "ESRCH", "ENOTDIR"]);

/** Read a file; null only when it does not exist. Any other failure is `LivenessUnknownError`. */
function readIfPresent(path: string, what: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (ABSENT.has((err as NodeJS.ErrnoException).code ?? "")) return null;
    throw new LivenessUnknownError(what, err);
  }
}

/**
 * Parse `/proc/<pid>/stat`; null when the process does not exist or `/proc` is unavailable. A read
 * that fails for any other reason throws `LivenessUnknownError`: it says nothing about the process.
 */
export function readProcStat(pid: number): ProcStat | null {
  const raw = readIfPresent(`/proc/${pid}/stat`, `reading /proc/${pid}/stat`);
  if (raw === null) return null;
  // comm (field 2) is parenthesised and may contain spaces or parens: split after the last ')'.
  const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  // rest[0] is field 3 (state); field 22 (starttime) is rest[19].
  const state = rest[0];
  const startTime = rest[19];
  if (state === undefined || startTime === undefined) return null;
  return { state, startTime };
}

function readBootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

/** The identity of a process (normally the calling worker itself). */
export function identityOf(pid: number = process.pid, clock: () => number = Date.now): WorkerIdentity {
  return { pid, start_time: readProcStat(pid)?.startTime ?? null, boot_id: readBootId(), started_at: nowIso(clock) };
}

/** Write `worker.json` durably (part of the acknowledgement guarantee). */
export function writeWorkerIdentity(dir: string, identity: WorkerIdentity): void {
  atomicWriteJson(runFile(dir, "worker"), identity, true);
}

/**
 * The recorded worker; null when none was recorded (no `worker.json`) or the file does not hold a
 * worker identity. A file that exists but cannot be read throws `LivenessUnknownError`.
 */
export function readWorkerIdentity(dir: string): WorkerIdentity | null {
  const text = readIfPresent(runFile(dir, "worker"), "reading the worker identity");
  if (text === null) return null;
  let value: Partial<WorkerIdentity> | null;
  try {
    value = JSON.parse(text) as Partial<WorkerIdentity> | null;
  } catch {
    return null; // written atomically, so never a half-written file: this is not a worker record
  }
  if (value === null || typeof value !== "object" || !Number.isInteger(value.pid) || (value.pid as number) < 1) return null;
  return {
    pid: value.pid as number,
    start_time: typeof value.start_time === "string" ? value.start_time : null,
    boot_id: typeof value.boot_id === "string" ? value.boot_id : null,
    started_at: typeof value.started_at === "string" ? value.started_at : "",
  };
}

/** Record a heartbeat (not fsynced: it is evidence for a live process, not for a crash). */
export function writeHeartbeat(dir: string, clock: () => number = Date.now): void {
  atomicWrite(runFile(dir, "heartbeat"), `${nowIso(clock)}\n`);
}

/** The last heartbeat; null when none was written. An unreadable heartbeat throws `LivenessUnknownError`. */
export function readHeartbeat(dir: string): string | null {
  const text = readIfPresent(runFile(dir, "heartbeat"), "reading the worker heartbeat")?.trim() ?? "";
  return text === "" ? null : text;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LivenessOptions {
  /** Fallback only (no `/proc`): a heartbeat older than this means dead. Default 10 s. */
  heartbeatStaleMs?: number;
  clock?: () => number;
}

/**
 * Decide whether the run's recorded worker is alive now. `alive: false` is returned only on
 * evidence that the worker is gone; when the evidence cannot be read this throws
 * `LivenessUnknownError` instead, so a transient read failure never reads as a dead worker.
 */
export function checkLiveness(dir: string, options: LivenessOptions = {}): Liveness {
  const identity = readWorkerIdentity(dir);
  const heartbeat_at = readHeartbeat(dir);
  if (identity === null) return { alive: false, pid: null, reason: "no worker recorded", heartbeat_at };
  const { pid } = identity;
  const verdict = (alive: boolean, reason: string): Liveness => ({ alive, pid, reason, heartbeat_at });
  if (identity.start_time !== null) {
    const stat = readProcStat(pid);
    if (stat === null) return verdict(false, "no process with the recorded pid");
    if (stat.state === "Z" || stat.state === "X") return verdict(false, "the recorded pid is a dead (zombie) process");
    if (stat.startTime !== identity.start_time) return verdict(false, "the recorded pid belongs to a different process (pid reused)");
    const boot = readBootId();
    if (identity.boot_id !== null && boot !== null && boot !== identity.boot_id) {
      return verdict(false, "the host rebooted since the worker started");
    }
    return verdict(true, "pid and process start time match the recorded worker");
  }
  // Weaker fallback without /proc: the pid exists and the heartbeat is fresh.
  if (!pidExists(pid)) return verdict(false, "no process with the recorded pid");
  const stale = options.heartbeatStaleMs ?? 10_000;
  const now = (options.clock ?? Date.now)();
  const fresh = heartbeat_at !== null && now - Date.parse(heartbeat_at) <= stale;
  return fresh
    ? verdict(true, "pid exists and heartbeat is fresh (no /proc identity check)")
    : verdict(false, "pid exists but no fresh heartbeat and no /proc identity check");
}
