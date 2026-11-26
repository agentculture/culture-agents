/**
 * Startup cleanup of the run store, run before the core answers anything: a run directory with
 * no first event was never established (the submit that made it was not acknowledged), and a
 * temporary file is the leftover of an atomic write that did not finish. A directory with at
 * least one event is kept, and so is one whose worker is alive or whose liveness cannot be read
 * (such a directory is left entirely alone).
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { runDir, runFile, runsDir } from "./files.js";
import { checkLiveness } from "./liveness.js";
import { listRunIds } from "./run-store.js";

export interface CleanupReport {
  removedRuns: string[];
  removedTemps: string[];
}

/** `atomicWrite`'s temporary names: `<file>.tmp-<pid>-<n>`. */
export function isTempName(name: string): boolean {
  return /\.tmp-\d+-\d+$/.test(name);
}

function hasFirstEvent(dir: string): boolean {
  try {
    return readFileSync(runFile(dir, "events"), "utf8").includes("\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function sweepTemps(dir: string, report: CleanupReport): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.filter(isTempName)) {
    rmSync(join(dir, name), { force: true });
    report.removedTemps.push(join(dir, name));
  }
}

export function cleanupStore(stateDir: string, warn: (line: string) => void = () => {}): CleanupReport {
  const report: CleanupReport = { removedRuns: [], removedTemps: [] };
  sweepTemps(runsDir(stateDir), report);
  for (const id of listRunIds(stateDir)) {
    const dir = runDir(stateDir, id);
    try {
      // A live worker may be mid-write (a temporary file in use), so it keeps the whole directory.
      if (checkLiveness(dir).alive) continue;
      if (!hasFirstEvent(dir)) {
        rmSync(dir, { recursive: true, force: true });
        report.removedRuns.push(id);
        continue;
      }
    } catch (err) {
      warn(`culture-agents core: run ${id} kept at startup, it cannot be checked: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    sweepTemps(dir, report);
  }
  return report;
}
