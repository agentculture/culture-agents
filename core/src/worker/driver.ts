/**
 * The harness driver boundary of a worker. A driver runs one run's harness session and reports
 * what happened as driver events; the worker turns them into contract events, enforces the
 * deadline and owns the state machine. Harness-neutral: contract types only, no harness-runtime
 * or vendor-SDK type crosses this interface.
 */
import type { ErrorBody, OutputData, Run } from "../contract/index.js";

/** What a driver reports. The stream ends after its first outcome event. */
export type DriverEvent =
  /** The harness session started (the run moves to `running`). */
  | { type: "started" }
  /** Normalized harness output (a `run.output` event). */
  | { type: "output"; data: OutputData }
  /** A non-fatal error (a `run.error` event with `fatal: false`). */
  | { type: "error"; error: ErrorBody }
  /** Outcome: the harness reported its turn completed (`succeeded`). */
  | { type: "completed"; summary?: string; collected?: { branch: string; commits: string[] } }
  /** Outcome: an established failure (`run.error` fatal, then `failed`). */
  | { type: "failed"; error: ErrorBody }
  /** Outcome: the harness stopped after `cancel` (`cancelled` or `timed_out`, by what started the stop). */
  | { type: "stopped" };

/** What a driver is given when the worker creates it. */
export interface DriverContext {
  /** The run record as stored (task, repo, harness, deadline, ...). */
  run: Run;
  /** The run's directory; a driver may keep private files here (owner-only). */
  runDir: string;
  /** Options from the spawner's driver selection (`driver.json`), opaque to the worker. */
  options: unknown;
}

export interface Driver {
  /** Start the harness session and stream what happens. Called once. */
  start(): AsyncIterable<DriverEvent>;
  /** Deliver a steer message to the running harness as user input. */
  steer(message: string): Promise<void>;
  /** Ask the harness to stop; the driver reports `stopped` once it has. */
  cancel(reason: string): Promise<void>;
  /**
   * Force the harness down and release its resources. Called once at the end, and also when
   * the harness did not stop within the worker's cancel grace period.
   */
  dispose(): Promise<void>;
}

/** A driver module exports `createDriver` of this type. */
export type DriverFactory = (context: DriverContext) => Driver | Promise<Driver>;

/** Contents of `driver.json`: which module the worker loads and the options it passes. */
export interface DriverSelection {
  /** An absolute path or `file:` URL of an ES module exporting `createDriver`. */
  module: string;
  options?: unknown;
}
