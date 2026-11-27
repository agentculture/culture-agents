#!/usr/bin/env node
import { homedir } from "node:os";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createFleet, prepareFleet } from "../fleet/index.js";
import { startPublishing } from "../publish/index.js";
import { prepareTrace, startTracing } from "../trace/index.js";
import { createRunService, emptyCatalog, type HarnessCatalog } from "../runs/index.js";
import { defaultStateDir } from "../store/files.js";
import { retentionFromEnv, pruneFinishedRuns } from "../store/retention.js";
import type { SubmitFault } from "../runs/keys.js";
import { cleanupStore } from "../store/startup.js";
import { loadAllowlist } from "./allowlist.js";
import { loadLimits, loadQuestionLimit } from "./limits.js";
import { startDaemon, type DaemonOptions } from "./daemon.js";
import { unavailable } from "./errors.js";
import { acquireStateLock, LockHeldError, type HeldLock } from "./lock.js";
import { takeSecrets } from "./secrets.js";
import { resolveAllowlistPath, resolveServerYamlPath } from "./paths.js";
import type { RunService } from "./ports.js";
import type { Limits } from "../contract/index.js";

/** `server.name` from the local `server.yaml` (README: identifiers); no YAML dependency, one key. */
export function readNodeName(env: Record<string, string | undefined> = process.env): string | null {
  let text: string;
  try {
    text = readFileSync(resolveServerYamlPath(env), "utf8");
  } catch {
    return null;
  }
  const block = /^server:\s*\n((?:[ \t]+.*\n?)+)/m.exec(text);
  const name = block ? /^[ \t]+name:\s*["']?([a-z0-9]{1,32})["']?\s*$/m.exec(block[1] ?? "") : null;
  return name?.[1] ?? null;
}

export interface MainOptions extends Partial<Omit<DaemonOptions, "service">> {
  stderr?: (line: string) => void;
  /** Harness catalog of the built-in run service (unused when a service is passed). Default: empty. */
  harnessCatalog?: () => HarnessCatalog;
  /** Run store directory of the built-in run service. Default: `defaultStateDir(env)`. */
  stateDir?: string;
  /** Fault injection at each step of a submit of the built-in run service (tests only). */
  submitFault?: SubmitFault;
  /** The operator's limits. Default: read from the core's config file at start (limits.ts); a bad one stops startup with exit 2. */
  limits?: Limits;
  /** The time limit of each operator question, in ms. Default: read from the core's config file (12 hours when unset, never more). */
  questionLimitMs?: number;
  /** How often sandboxes of finished runs are reclaimed. Default: 5 minutes. */
  reclaimIntervalMs?: number;
  /**
   * Install process-level `uncaughtException` and `unhandledRejection` handlers for the life of
   * `main` (the bin does). Either one is logged, the daemon is stopped as on SIGTERM and `main`
   * resolves to 2. Off by default, so a host process keeps its own handlers.
   */
  fatalHandlers?: boolean;
  /** Variables to take out of the environment at start. Default: `INJECTED_SECRETS` (secrets.ts). */
  secretNames?: readonly string[];
  /** How long a stop after a fatal error may take before `main` gives up waiting. Default: 5 s. */
  fatalStopTimeoutMs?: number;
}

/** Process-level failures, turned into one promise. `dispose` removes the handlers. */
function watchFatal(err: (line: string) => void): { fatal: Promise<void>; dispose: () => void } {
  let signal: () => void = () => undefined;
  const fatal = new Promise<void>((resolve) => (signal = resolve));
  const handler = (what: string) => (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // One line first; the stack follows for whoever reads the core's stderr. No client sees either.
    err(`culture-agents core: fatal: ${what}: ${message.split("\n")[0] ?? ""}; stopping (workers keep running).`);
    if (error instanceof Error && error.stack) err(error.stack);
    signal();
  };
  const onException = handler("uncaught exception");
  const onRejection = handler("unhandled promise rejection");
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  return {
    fatal,
    dispose: () => {
      process.off("uncaughtException", onException);
      process.off("unhandledRejection", onRejection);
    },
  };
}

/**
 * Run the daemon until SIGTERM or SIGINT, then clean up. Resolves to the process exit code: 0 after a
 * clean stop, 2 for an environment error (another instance running, no node name, bind failure) or,
 * with `fatalHandlers`, after an uncaught exception or unhandled rejection. Workers are separate
 * detached processes: no path through here signals them.
 */
export async function main(service?: RunService, options: MainOptions = {}): Promise<number> {
  const err =
    options.stderr ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  if (!options.fatalHandlers) return serve(service, options, err, null);
  const watch = watchFatal(err);
  try {
    return await serve(service, options, err, watch.fatal);
  } finally {
    watch.dispose();
  }
}

/**
 * SIGTERM and SIGINT as one promise. Installed before the daemon reports that it is listening, so a
 * signal sent the moment a client sees that report is a stop, not the default action that ends the
 * process by signal. `dispose` removes the handlers.
 */
function watchStop(): { stopped: Promise<void>; dispose: () => void } {
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return {
    stopped,
    dispose: () => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    },
  };
}

async function serve(service: RunService | undefined, options: MainOptions, err: (line: string) => void, fatal: Promise<void> | null): Promise<number> {
  const stop = watchStop();
  try {
    return await serveUntilStopped(service, options, err, fatal, stop.stopped);
  } finally {
    stop.dispose();
  }
}

type Log = (line: string) => void;
type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;
type Daemon = Awaited<ReturnType<typeof startDaemon>>;

/** The operator's limits for the built-in run service; null when they cannot be read (reported). */
function readOperatorLimits(service: RunService | undefined, options: MainOptions, env: Env, err: Log): { limits: Limits | undefined; questionLimitMs: number | undefined } | null {
  let limits: Limits | undefined;
  let questionLimitMs: number | undefined;
  try {
    limits = service ? undefined : (options.limits ?? loadLimits(env));
    questionLimitMs = service ? undefined : (options.questionLimitMs ?? loadQuestionLimit(env));
  } catch (e) {
    err(`culture-agents core: cannot start: limits configuration: ${(e as Error).message}`);
    return null;
  }
  return { limits, questionLimitMs };
}

/** The state lock, then the startup sweep of the store; null when the lock cannot be taken (reported). */
async function claimStore(stateDir: string, err: Log): Promise<HeldLock | null> {
  let stateLock: HeldLock;
  try {
    stateLock = await acquireStateLock(stateDir); // before anything reads or settles the store
  } catch (e) {
    err(`culture-agents core: cannot start: ${(e as Error).message}`);
    return null;
  }
  try {
    const swept = cleanupStore(stateDir, err);
    if (swept.removedRuns.length + swept.removedTemps.length > 0) err(`culture-agents core: startup cleanup removed ${swept.removedRuns.length} run directories without a first event and ${swept.removedTemps.length} temporary files`);
  } catch (e) {
    err(`culture-agents core: startup cleanup failed, continuing: ${(e as Error).message}`);
  }
  return stateLock;
}

/** The daemon, listening; null when it cannot start (reported, the state lock released). */
async function startOrReport(options: MainOptions, service: RunService, node: string, stateLock: HeldLock | null, err: Log): Promise<Daemon | null> {
  try {
    return await startDaemon({ ...options, service, node });
  } catch (e) {
    await stateLock?.release();
    err(e instanceof LockHeldError ? `culture-agents core: ${e.message}` : `culture-agents core: cannot start: ${(e as Error).message}`);
    return null;
  }
}

/** The built-in run service over the store in `stateDir`. */
function builtInRuns(
  options: MainOptions,
  o: { stateDir: string; node: string; allowlistPath: string; env: Env; limits: Limits | undefined; questionLimitMs: number | undefined },
): ReturnType<typeof createRunService> {
  const { stateDir, node, allowlistPath, env, limits, questionLimitMs } = o;
  return createRunService({ stateDir, node, catalog: (options.harnessCatalog ?? emptyCatalog)(), allowlist: () => loadAllowlist(allowlistPath), ...(limits && { limits }), ...(questionLimitMs !== undefined && { worker: { questionLimitMs } }), env, ...(options.submitFault && { submitFault: options.submitFault }) });
}

function reconcileRuns(runs: ReturnType<typeof createRunService> | null, err: Log): void {
  try {
    runs?.reconcile(); // after the lock: this core is now the only one settling orphaned runs
  } catch (e) {
    err(`culture-agents core: startup reconciliation failed (runs settle when read): ${(e as Error).message}`);
  }
}

/**
 * Sandboxes of finished runs that their workers could not delete, finished run directories past
 * the retention period, and expired idempotency keys: once now, then periodically. Returns what
 * stops the timers.
 */
function startHousekeeping(runs: ReturnType<typeof createRunService> | null, stateDir: string, env: Env, intervalMs: number, err: Log): () => void {
  const reclaim = (): void => {
    runs?.reclaim().then(
      (ids) => ids.length > 0 && err(`culture-agents core: reclaimed the sandbox of ${ids.length} finished run(s): ${ids.join(", ")}`),
      (e: unknown) => err(`culture-agents core: could not reclaim sandboxes of finished runs: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  // Finished run directories past the retention period (CULTURE_AGENTS_RUN_RETENTION_DAYS, default 30, off or 0 keeps all).
  const prune = (): void => {
    if (!runs) return;
    try {
      const ids = pruneFinishedRuns(stateDir, { retentionMs: retentionFromEnv(env) });
      if (ids.length > 0) err(`culture-agents core: removed ${ids.length} finished run directory(ies) past retention: ${ids.join(", ")}`);
      runs.pruneExpiredKeys(); // idempotency keys past their retention, or of runs that left the store
    } catch (e) {
      err(`culture-agents core: could not prune finished runs: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  reclaim();
  prune();
  const reclaimTimer = setInterval(reclaim, intervalMs);
  const pruneTimer = setInterval(prune, intervalMs);
  pruneTimer.unref();
  reclaimTimer.unref();
  return () => {
    clearInterval(reclaimTimer);
    clearInterval(pruneTimer);
  };
}

/** After a fatal error the stop is best effort and bounded: the process exits 2 either way. */
async function finishAfterFatal(stopping: Promise<void>, timeoutMs: number, err: Log): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  const stopped = await Promise.race([
    stopping.then(
      () => true,
      (e: unknown) => {
        err(`culture-agents core: could not stop cleanly: ${e instanceof Error ? e.message : String(e)}`);
        return true;
      },
    ),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
  ]);
  clearTimeout(timer);
  if (!stopped) err("culture-agents core: the stop did not finish in time; exiting anyway.");
  return 2;
}

async function serveUntilStopped(
  service: RunService | undefined,
  options: MainOptions,
  err: (line: string) => void,
  fatal: Promise<void> | null,
  signalled: Promise<void>,
): Promise<number> {
  const node = options.node ?? readNodeName(options.env ?? process.env);
  if (!node) {
    err(`culture-agents core: no node name; set server.name in ${resolveServerYamlPath(options.env ?? process.env)} or ${join(homedir(), ".culture", "server.yaml")}.`);
    return 2;
  }
  const env = options.env ?? process.env;
  // Before any worker, host command or sandbox exists: secrets leave the environment for memory.
  takeSecrets(env, options.secretNames);
  // The trace keys leave the environment at the same point, before the socket listens (no host command can inherit them).
  const traceConfig = prepareTrace(env, err);
  // The fleet transport is off unless configured; a configured one with a bad key or trust list stops the core here.
  const fleetConfig = prepareFleet(env, err);
  if (fleetConfig === undefined) return 2;
  const allowlistPath = options.allowlistPath ?? resolveAllowlistPath(env);
  const stateDir = options.stateDir ?? defaultStateDir(env);
  const operator = readOperatorLimits(service, options, env, err);
  if (operator === null) return 2;
  const { limits, questionLimitMs } = operator;
  let stateLock: HeldLock | null = null;
  if (!service) {
    stateLock = await claimStore(stateDir, err);
    if (stateLock === null) return 2;
  }
  const runs = service ? null : builtInRuns(options, { stateDir, node, allowlistPath, env, limits, questionLimitMs });
  // The member list exists before the socket listens, so the local route reads it; nothing is announced or heard until `start`.
  const runService = service ?? (runs as RunService);
  const fleet = fleetConfig ? createFleet(fleetConfig, node, err, {}, { service: runService, allowlist: () => loadAllowlist(allowlistPath), now: options.now ?? (() => new Date()) }) : null;
  const daemon = await startOrReport({ ...options, ...(fleet && { members: () => fleet.members.view(), remote: fleet.remote }) }, runService, node, stateLock, err);
  if (daemon === null) return 2;
  if (fleet && !(await fleet.start())) {
    await daemon.stop();
    await stateLock?.release();
    return 2;
  }
  reconcileRuns(runs, err);
  // Run events also go to the events broker when one is configured. Never awaited by a request, never needed by a run.
  const publishing = runs ? await startPublishing({ stateDir, node, env, log: err }) : null;
  // Run traces go to Langfuse when an endpoint is configured; same rules: never awaited by a request, never needed by a run.
  const tracing = runs ? startTracing({ stateDir, node, env, log: err, config: traceConfig }) : null;
  const stopHousekeeping = startHousekeeping(runs, stateDir, env, options.reclaimIntervalMs ?? 300_000, err);
  const state = daemon.allowlistState();
  err(`culture-agents core: listening on ${daemon.paths.socket} (pid ${process.pid}); allow-list ${state.status}, ${state.entries.length} entries`);
  const code = await new Promise<number>((resolve) => {
    void signalled.then(() => resolve(0));
    void fatal?.then(() => resolve(2));
  });
  stopHousekeeping();
  const stopping = (async () => {
    await fleet?.stop();
    await publishing?.stop();
    await tracing?.stop();
    await daemon.stop();
    await stateLock?.release();
  })();
  if (code === 0) {
    await stopping;
    return 0;
  }
  return finishAfterFatal(stopping, options.fatalStopTimeoutMs ?? 5000, err);
}

/** Placeholder until the run logic is wired: every call says so, with `unavailable`. */
export const unwiredService: RunService = (() => {
  const no = (): never => {
    throw unavailable("The run service is not wired into this core build yet.");
  };
  return {
    submit: no,
    listRuns: no,
    getRun: no,
    readEvents: no,
    streamEvents: no,
    getResult: no,
    steer: no,
    cancel: no,
    answer: no,
    recordRefusal: no,
    listAgents: no,
    getAgent: no,
    listHarnesses: no,
    getHarness: no,
  };
})();

/** Whether this module is the process entry point, also when started through a symlink (an npm `bin`). */
function isBinTarget(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * The bin target (`culture-agents-core`, or `node dist/src/daemon/main.js`): the run service over the
 * real harness registry. A harness configuration error stops startup with exit 2 and one line.
 */
async function bin(): Promise<number> {
  let catalog: HarnessCatalog;
  try {
    const { loadRegistryCatalog } = await import("./harness-catalog.js");
    catalog = loadRegistryCatalog(process.env);
  } catch (e) {
    process.stderr.write(`culture-agents core: cannot start: harness configuration: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  return main(undefined, { harnessCatalog: () => catalog, fatalHandlers: true });
}

if (isBinTarget()) {
  let code: number;
  try {
    code = await bin();
  } catch (e) {
    process.stderr.write(`culture-agents core: ${e instanceof Error ? e.message : String(e)}\n`);
    code = 2;
  }
  process.exit(code);
}
