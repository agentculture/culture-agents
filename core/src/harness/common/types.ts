/**
 * Internal seams of the harness layer. A run driver (`run-driver.ts`) composes a `Workspace`
 * (where the harness works: an OpenShell sandbox, or a host temp clone for the stub) with a
 * `HarnessBackend` (how one harness is started, streamed, steered and interrupted). Contract
 * types only; nothing here names an AI SDK, OpenShell or vendor type.
 */
import type { ErrorBody, OutputData } from "../../contract/index.js";

/** One process seen in a workspace (`ps`), used for the after-cancel checks. */
export interface Proc {
  pid: number;
  ppid: number;
  args: string;
}

/** Commits brought back to the host. */
export interface Collected {
  branch: string;
  commit: string;
  /** Number of commits on the branch beyond the run's base commit. */
  commits: number;
  /** Those commits as full SHAs in the host repository, oldest first. */
  shas: string[];
}

/** Where a harness runs for one run. Every method is safe to call after `destroy` fails. */
export interface Workspace {
  /** Absolute path of the run's working tree, as the harness sees it. */
  readonly workdir: string;
  /** Live processes (empty where the workspace cannot list them). */
  processes(): Promise<Proc[]>;
  /** Force-kill processes by pid. */
  kill(pids: readonly number[]): Promise<void>;
  /** Commit every change in the working tree; returns the commit count beyond the base. */
  commitAll(message: string): Promise<number>;
  /** Bring the run's commits to the host branch `runs/<id>`; null when there are none. */
  collect(): Promise<Collected | null>;
  /** Release the workspace (delete the sandbox). Idempotent. */
  destroy(): Promise<void>;
}

export interface WorkspaceFactory<W extends Workspace = Workspace> {
  open(signal: AbortSignal): Promise<W>;
}

/** What a turn reports while it runs. */
export type TurnEvent = { type: "output"; data: OutputData } | { type: "error"; error: ErrorBody };

/** How a turn ended, as the harness's own authority reports it. */
export type TurnOutcome =
  | { kind: "completed"; summary?: string }
  | { kind: "failed"; error: ErrorBody }
  | { kind: "interrupted" };

export interface TurnHandle {
  /** Output while the turn runs; ends when the turn has ended. */
  readonly events: AsyncIterable<TurnEvent>;
  /** Resolves once the turn has ended (after `events` ends). */
  readonly outcome: Promise<TurnOutcome>;
  /** Deliver a user message into the running turn. Throws when the turn cannot take it. */
  steer(text: string): Promise<void>;
  /** Ask the harness to stop the turn. */
  interrupt(): Promise<void>;
}

export interface HarnessSession {
  startTurn(task: string): Promise<TurnHandle>;
  /** End the harness (its server or bridge); the workspace stays. Idempotent. */
  close(): Promise<void>;
}

/** Side channel for diagnostics a backend wants on the run's log. */
export type Sink = (event: TurnEvent) => void;

export interface HarnessBackend<W extends Workspace = Workspace> {
  open(workspace: W, signal: AbortSignal, sink: Sink): Promise<HarnessSession>;
}

/** What the driver observed about processes around a cancel (also kept for tests). */
export interface StopReport {
  /** New processes (not in the pre-harness baseline) right after the turn stopped. */
  afterInterrupt: Proc[];
  /** New processes after the harness itself was closed. */
  afterClose: Proc[];
  /** Pids the driver force-killed because they outlived the harness. */
  killed: number[];
  /** New processes after the kill (must be empty). */
  remaining: Proc[];
  /**
   * Why a listing above could not be taken, by field. A field named here is empty because the
   * check could not look, not because nothing was running.
   */
  listingFailed: { afterInterrupt?: string; afterClose?: string; remaining?: string };
  /** Whether the workspace was destroyed. */
  destroyed: boolean;
}
