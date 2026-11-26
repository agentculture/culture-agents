/**
 * The submit-time limit check (contract README, order of checks step 7). No limit applies unless
 * the operator configured one (daemon/limits.ts); a submit past a configured limit is refused with
 * `limit_reached` naming the limit, its value and the active count, and nothing is queued.
 *
 * Counted as active: every run in an active state (`isActive`), including a run whose worker
 * survived a core restart, and every run that cannot be read but whose worker may be alive (an
 * unreadable record counts against every repository). The repository limit is checked first.
 */
import { isActive, type Limit, type Limits } from "../contract/index.js";
import { ControlError } from "../daemon/errors.js";
import { scanRuns, unreadableLiveRuns, type ScanOptions } from "./scan.js";

/** No limit configured. */
export const NO_LIMITS: Limits = { runs_per_repository: null, runs_per_host: null };

/** Throw `limit_reached` when a configured limit has no room for one more run in `repo`. Reads nothing when no limit is configured. */
export function checkLimits(limits: Limits, scan: ScanOptions, repo: string): void {
  const perRepo = limits.runs_per_repository;
  const perHost = limits.runs_per_host;
  if (perRepo === null && perHost === null) return;
  const active = scanRuns(scan).filter((run) => isActive(run.state));
  const unreadable = unreadableLiveRuns(scan);
  if (perRepo !== null) {
    const count = active.filter((run) => run.repo === repo).length + unreadable.filter((run) => run.repo === null || run.repo === repo).length;
    if (count >= perRepo) refuse({ name: "runs_per_repository", value: perRepo, active: count, repo }, `Repository ${repo} has ${count} active runs and the configured limit runs_per_repository is ${perRepo}; nothing was queued, retry when a run ends.`);
  }
  if (perHost !== null) {
    const count = active.length + unreadable.length;
    if (count >= perHost) refuse({ name: "runs_per_host", value: perHost, active: count }, `This host has ${count} active runs and the configured limit runs_per_host is ${perHost}; nothing was queued, retry when a run ends or submit elsewhere.`);
  }
}

function refuse(limit: Limit, message: string): never {
  throw new ControlError("limit_reached", message, { limit });
}
