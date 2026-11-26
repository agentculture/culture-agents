#!/usr/bin/env node
import { homedir } from "node:os";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startPublishing } from "../publish/index.js";
import { createRunService, emptyCatalog, type HarnessCatalog } from "../runs/index.js";
import { defaultStateDir } from "../store/files.js";
import type { SubmitFault } from "../runs/keys.js";
import { cleanupStore } from "../store/startup.js";
import { loadAllowlist } from "./allowlist.js";
import { startDaemon, type DaemonOptions } from "./daemon.js";
import { unavailable } from "./errors.js";
import { acquireStateLock, LockHeldError, type HeldLock } from "./lock.js";
import { resolveAllowlistPath, resolveServerYamlPath } from "./paths.js";
import type { RunService } from "./ports.js";

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
  /** How often sandboxes of finished runs are reclaimed. Default: 5 minutes. */
  reclaimIntervalMs?: number;
  /**
   * Install process-level `uncaughtException` and `unhandledRejection` handlers for the life of
   * `main` (the bin does). Either one is logged, the daemon is stopped as on SIGTERM and `main`
   * resolves to 2. Off by default, so a host process keeps its own handlers.
   */
  fatalHandlers?: boolean;
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
  const allowlistPath = options.allowlistPath ?? resolveAllowlistPath(env);
  const stateDir = options.stateDir ?? defaultStateDir(env);
  let stateLock: HeldLock | null = null;
  if (!service) {
    try {
      stateLock = await acquireStateLock(stateDir); // before anything reads or settles the store
    } catch (e) {
      err(`culture-agents core: cannot start: ${(e as Error).message}`);
      return 2;
    }
  }
  if (!service) {
    try {
      const swept = cleanupStore(stateDir, err);
      if (swept.removedRuns.length + swept.removedTemps.length > 0) err(`culture-agents core: startup cleanup removed ${swept.removedRuns.length} run directories without a first event and ${swept.removedTemps.length} temporary files`);
    } catch (e) {
      err(`culture-agents core: startup cleanup failed, continuing: ${(e as Error).message}`);
    }
  }
  const runs = service ? null : createRunService({ stateDir, node, catalog: (options.harnessCatalog ?? emptyCatalog)(), allowlist: () => loadAllowlist(allowlistPath), ...(options.submitFault && { submitFault: options.submitFault }) });
  let daemon;
  try {
    daemon = await startDaemon({ ...options, service: service ?? (runs as RunService), node });
  } catch (e) {
    await stateLock?.release();
    err(e instanceof LockHeldError ? `culture-agents core: ${e.message}` : `culture-agents core: cannot start: ${(e as Error).message}`);
    return 2;
  }
  try {
    runs?.reconcile(); // after the lock: this core is now the only one settling orphaned runs
  } catch (e) {
    err(`culture-agents core: startup reconciliation failed (runs settle when read): ${(e as Error).message}`);
  }
  // Run events also go to the events broker when one is configured. Never awaited by a request, never needed by a run.
  const publishing = runs ? await startPublishing({ stateDir, node, env, log: err }) : null;
  // Sandboxes of finished runs that their workers could not delete: at startup, then periodically.
  const reclaim = (): void => {
    runs?.reclaim().then(
      (ids) => ids.length > 0 && err(`culture-agents core: reclaimed the sandbox of ${ids.length} finished run(s): ${ids.join(", ")}`),
      (e: unknown) => err(`culture-agents core: could not reclaim sandboxes of finished runs: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  reclaim();
  const reclaimTimer = setInterval(reclaim, options.reclaimIntervalMs ?? 300_000);
  reclaimTimer.unref();
  const state = daemon.allowlistState();
  err(`culture-agents core: listening on ${daemon.paths.socket} (pid ${process.pid}); allow-list ${state.status}, ${state.entries.length} entries`);
  const code = await new Promise<number>((resolve) => {
    void signalled.then(() => resolve(0));
    void fatal?.then(() => resolve(2));
  });
  clearInterval(reclaimTimer);
  const stopping = (async () => {
    await publishing?.stop();
    await daemon.stop();
    await stateLock?.release();
  })();
  if (code === 0) {
    await stopping;
    return 0;
  }
  // After a fatal error the stop is best effort and bounded: the process exits 2 either way.
  let timer: NodeJS.Timeout | undefined;
  const stopped = await Promise.race([
    stopping.then(
      () => true,
      (e: unknown) => {
        err(`culture-agents core: could not stop cleanly: ${e instanceof Error ? e.message : String(e)}`);
        return true;
      },
    ),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), options.fatalStopTimeoutMs ?? 5000))),
  ]);
  clearTimeout(timer);
  if (!stopped) err("culture-agents core: the stop did not finish in time; exiting anyway.");
  return 2;
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
