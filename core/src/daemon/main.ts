#!/usr/bin/env node
import { homedir } from "node:os";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRunService, emptyCatalog, type HarnessCatalog } from "../runs/index.js";
import { defaultStateDir } from "../store/files.js";
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
  /** How often sandboxes of finished runs are reclaimed. Default: 5 minutes. */
  reclaimIntervalMs?: number;
}

/**
 * Run the daemon until SIGTERM or SIGINT, then clean up. Resolves to the process exit code: 0 after a
 * clean stop, 2 for an environment error (another instance running, no node name, bind failure).
 */
export async function main(service?: RunService, options: MainOptions = {}): Promise<number> {
  const err = options.stderr ?? ((line: string) => void process.stderr.write(`${line}\n`));
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
  const runs = service ? null : createRunService({ stateDir, node, catalog: (options.harnessCatalog ?? emptyCatalog)(), allowlist: () => loadAllowlist(allowlistPath) });
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
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once("SIGTERM", done);
    process.once("SIGINT", done);
  });
  clearInterval(reclaimTimer);
  await daemon.stop();
  await stateLock?.release();
  return 0;
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
  return main(undefined, { harnessCatalog: () => catalog });
}

if (isBinTarget()) {
  bin().then((code) => process.exit(code), (e: unknown) => {
    process.stderr.write(`culture-agents core: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  });
}
