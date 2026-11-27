/**
 * The operator's limits on concurrent runs, read from the core's config file (the harness config
 * file, harness/config.ts: `$XDG_CONFIG_HOME/culture-agents/harness.json`, or the file named by
 * `CULTURE_AGENTS_HARNESS_CONFIG`). Limits come from this file only, never from a request or the
 * environment; none applies unless one is configured (contract README: limits).
 *
 * ```json
 * { "limits": { "runsPerRepository": 2, "runsPerHost": 8 } }
 * ```
 *
 * Each value is a whole number of at least 1, or null/absent for no limit. Anything else, and any
 * other key under `limits`, is a configuration error: the core refuses to start rather than run
 * with a limit the operator did not mean.
 *
 * The time limit of an operator question comes from the same file (contract README, "Operator
 * questions"): 12 hours unless the operator configures less, and never more.
 *
 * ```json
 * { "questions": { "limitSeconds": 3600 } }
 * ```
 */
import type { Limits } from "../contract/index.js";
import { configPath, HarnessConfigError, readConfigFile } from "../harness/config.js";
import { NO_LIMITS } from "../runs/limits.js";
import { QUESTION_LIMIT_MS } from "../store/questions.js";

export { NO_LIMITS };

const KEYS = { runsPerRepository: "runs_per_repository", runsPerHost: "runs_per_host" } as const;

export class LimitsConfigError extends Error {
  override readonly name = "LimitsConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

function readFile(env: Env): { path: string; file: Record<string, unknown> | null } {
  const path = configPath(env);
  try {
    return { path, file: readConfigFile(path, Boolean(env["CULTURE_AGENTS_HARNESS_CONFIG"])) };
  } catch (err) {
    if (err instanceof HarnessConfigError) throw new LimitsConfigError(err.message);
    throw err;
  }
}

/** The question limit in ms: 12 hours when unset; a configured value must be 1 to 43200 seconds. */
export function loadQuestionLimit(env: Env = process.env): number {
  const { path, file } = readFile(env);
  const section = file?.["questions"];
  if (section === undefined || section === null) return QUESTION_LIMIT_MS;
  if (typeof section !== "object" || Array.isArray(section)) throw new LimitsConfigError(`questions in ${path} must be an object`);
  const max = QUESTION_LIMIT_MS / 1000;
  for (const [key, value] of Object.entries(section)) {
    if (key !== "limitSeconds") throw new LimitsConfigError(`questions.${key} in ${path} is not a known setting (known: limitSeconds)`);
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
      throw new LimitsConfigError(`questions.limitSeconds in ${path} must be a whole number from 1 to ${max} (12 hours, the most a question may wait), or null for 12 hours`);
    }
    return value * 1000;
  }
  return QUESTION_LIMIT_MS;
}

export function loadLimits(env: Env = process.env): Limits {
  const { path, file } = readFile(env);
  const section = file?.["limits"];
  if (section === undefined || section === null) return { ...NO_LIMITS };
  if (typeof section !== "object" || Array.isArray(section)) throw new LimitsConfigError(`limits in ${path} must be an object`);
  const limits: Limits = { ...NO_LIMITS };
  for (const [key, value] of Object.entries(section)) {
    if (!(key in KEYS)) throw new LimitsConfigError(`limits.${key} in ${path} is not a known limit (known: ${Object.keys(KEYS).join(", ")})`);
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new LimitsConfigError(`limits.${key} in ${path} must be a whole number of at least 1, or null for no limit`);
    }
    limits[KEYS[key as keyof typeof KEYS]] = value;
  }
  return limits;
}
