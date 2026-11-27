/**
 * Startup cleanup of the run store, run before the core answers anything: a run directory with
 * no first event was never established (the submit that made it was not acknowledged), and a
 * temporary file is the leftover of an atomic write that did not finish. A directory with at
 * least one event is kept, and so is one whose worker is alive or whose liveness cannot be read
 * (such a directory is left entirely alone).
 *
 * Nothing inside a directory this core cannot read by version (a newer store schema, or a version
 * file that is not one) is modified or removed. A run entry that is a symlink is never followed,
 * and only regular files are removed as temporary files, so the sweep never leaves the state
 * directory. One entry that cannot be handled is reported and the sweep goes on.
 */
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { runDir, runFile, runsDir } from "./files.js";
import { checkLiveness } from "./liveness.js";
import { listRunIds } from "./run-store.js";
import { assertReadableVersion } from "./version.js";

export interface CleanupReport {
  removedRuns: string[];
  removedTemps: string[];
}

type Warn = (line: string) => void;

/** `atomicWrite`'s temporary names: `<file>.tmp-<pid>-<n>`. */
export function isTempName(name: string): boolean {
  return /\.tmp-\d+-\d+$/.test(name);
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function hasFirstEvent(dir: string): boolean {
  try {
    return readFileSync(runFile(dir, "events"), "utf8").includes("\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Remove one temp-named entry when it is a regular file; anything else is reported and kept. */
function removeTemp(path: string, report: CleanupReport, warn: Warn): void {
  try {
    if (!lstatSync(path).isFile()) {
      warn(`culture-agents core: ${path} kept at startup, it has a temporary name but is not a regular file`);
      return;
    }
    rmSync(path, { force: true });
    report.removedTemps.push(path);
  } catch (err) {
    warn(`culture-agents core: ${path} kept at startup, it cannot be removed: ${message(err)}`);
  }
}

function sweepTemps(dir: string, report: CleanupReport, warn: Warn): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.filter(isTempName)) removeTemp(join(dir, name), report, warn);
}

/** What start-up does with one run directory: leave it alone, remove it, or sweep its temp files. */
function decide(dir: string): "keep" | "remove" | "sweep" {
  // A symlink is not a run directory this core made; it is never followed.
  if (!lstatSync(dir).isDirectory()) throw new Error("it is not a directory (a symlink is never followed)");
  // A directory this core cannot read by version is never touched (this throws when the version file is damaged).
  assertReadableVersion(dir);
  // A live worker may be mid-write (a temporary file in use), so it keeps the whole directory.
  if (checkLiveness(dir).alive) return "keep";
  return hasFirstEvent(dir) ? "sweep" : "remove";
}

export function cleanupStore(stateDir: string, warn: Warn = () => {}): CleanupReport {
  const report: CleanupReport = { removedRuns: [], removedTemps: [] };
  sweepTemps(runsDir(stateDir), report, warn);
  for (const id of listRunIds(stateDir)) {
    const dir = runDir(stateDir, id);
    try {
      const action = decide(dir);
      if (action === "remove") {
        rmSync(dir, { recursive: true, force: true });
        report.removedRuns.push(id);
      } else if (action === "sweep") {
        sweepTemps(dir, report, warn);
      }
    } catch (err) {
      warn(`culture-agents core: run ${id} kept at startup, it cannot be checked: ${message(err)}`);
    }
  }
  return report;
}
