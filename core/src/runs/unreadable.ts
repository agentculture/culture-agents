/**
 * The run directories the core cannot read, named for the `runs.unreadable` route. It reads and
 * never writes: nothing is settled, summarised, rewritten or removed, and a directory of a newer
 * store version is read for its version file only (`showRunAt` checks the version first).
 */
import { type RunId, type UnreadableRun, type UnreadableRunList } from "../contract/index.js";
import { runDir } from "../store/files.js";
import { readLog } from "../store/event-log.js";
import { listRunIds, readRecord, showRunAt } from "../store/run-store.js";
import { readStoreVersion, STORE_SCHEMA_VERSION } from "../store/version.js";

const MAX_DETAIL = 500;

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const one = text.length > 0 ? text : "no reason was given";
  return one.length > MAX_DETAIL ? `${one.slice(0, MAX_DETAIL - 1)}…` : one;
}

function newerVersion(dir: string): boolean {
  try {
    return readStoreVersion(dir) > STORE_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

/** Which part of the directory failed: decided by reading again, version first, then the record, then the log. */
function reasonOf(dir: string, id: RunId): UnreadableRun["reason"] {
  if (newerVersion(dir)) return "newer_version";
  try {
    readStoreVersion(dir);
  } catch {
    return "other";
  }
  try {
    readRecord(dir);
  } catch {
    return "corrupt_record";
  }
  try {
    readLog(dir, id);
  } catch {
    return "unreadable_log";
  }
  return "other";
}

/** Every unreadable run directory, by run id, descending. `readFile` is the store's reader (tests inject one). */
export function listUnreadableRuns(stateDir: string, readFile?: (path: string) => Buffer): UnreadableRunList {
  const runs: UnreadableRun[] = [];
  for (const id of listRunIds(stateDir)) {
    const dir = runDir(stateDir, id);
    try {
      showRunAt(dir, { controllable: false, settle: false, ...(readFile && { readFile }) });
    } catch (err) {
      runs.push({ run_id: id, reason: reasonOf(dir, id), detail: message(err) });
    }
  }
  runs.sort((a, b) => (a.run_id < b.run_id ? 1 : -1));
  return { count: runs.length, runs };
}
