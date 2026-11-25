/**
 * Run-store layout and low-level file helpers. Every run file is owner-only (0600) and every
 * run directory 0700, because harness output may contain secrets (spec: D1 stores them
 * without redaction). Records are replaced atomically (temp file + rename).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isRunId } from "../contract/index.js";

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/** File names inside `<stateDir>/runs/<run-id>/`. */
export const RUN_FILES = {
  /** The run record (contract `run.json` shape), a cache; state is derived from the event log. */
  record: "run.json",
  /** Append-only event log: one contract event per line, cursor 1, 2, 3, ... */
  events: "events.jsonl",
  /** The newest cursor in the event log, as a decimal integer. */
  cursor: "cursor",
  /** Worker identity: pid, process start time and boot id (liveness evidence). */
  worker: "worker.json",
  /** Worker heartbeat: the last time the worker proved it was alive (ISO timestamp). */
  heartbeat: "heartbeat",
  /** The worker's control socket (newline-delimited JSON). */
  socket: "control.sock",
  /** The driver selection the worker loads (module specifier and options). */
  driver: "driver.json",
  /** Where a completed run's commits landed: `{ branch, commits }` with full SHAs, oldest first. */
  collected: "collected.json",
  /** A sandbox kept after a completed turn's work could not be brought to the host: `{ sandbox, until }`. */
  retained: "retained.json",
  /** The worker's own stdout/stderr (diagnostics only, never parsed). */
  log: "worker.log",
} as const;

export type RunFile = keyof typeof RUN_FILES;

/**
 * The state directory: `$CULTURE_AGENTS_STATE_DIR`, else `$XDG_STATE_HOME/culture-agents`,
 * else `~/.local/state/culture-agents`.
 */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CULTURE_AGENTS_STATE_DIR"];
  if (override) return override;
  const xdg = env["XDG_STATE_HOME"];
  return join(xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".local", "state"), "culture-agents");
}

/** `<stateDir>/runs`. */
export function runsDir(stateDir: string): string {
  return join(stateDir, "runs");
}

/** `<stateDir>/runs/<run-id>`; the id is checked so it can never escape the runs directory. */
export function runDir(stateDir: string, runId: string): string {
  if (!isRunId(runId)) throw new RangeError(`invalid run id: ${JSON.stringify(runId)}`);
  return join(runsDir(stateDir), runId);
}

/** Path of one run file. */
export function runFile(dir: string, file: RunFile): string {
  return join(dir, RUN_FILES[file]);
}

/** mkdir -p with owner-only directories. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
}

/** fsync a directory so a rename or create inside it is durable. */
export function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

let tmpSeq = 0;

/**
 * Replace `path` atomically: write a 0600 temp file next to it, optionally fsync it, rename it
 * over the target, and (when `durable`) fsync the directory. A reader sees the old or the new
 * content, never a partial file.
 */
export function atomicWrite(path: string, content: string, durable = false): void {
  const tmp = `${path}.tmp-${process.pid}-${++tmpSeq}`;
  const fd = openSync(tmp, "wx", FILE_MODE);
  try {
    writeSync(fd, content);
    if (durable) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (durable) fsyncDir(dirname(path));
}

/** Like `atomicWrite` for a JSON value (one line, trailing newline). */
export function atomicWriteJson(path: string, value: unknown, durable = false): void {
  atomicWrite(path, `${JSON.stringify(value)}\n`, durable);
}

/** The current time as a contract timestamp (UTC, `Z`). */
export function nowIso(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}
