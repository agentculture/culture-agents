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
 */
import type { Limits } from "../contract/index.js";
import { configPath, HarnessConfigError, readConfigFile } from "../harness/config.js";
import { NO_LIMITS } from "../runs/limits.js";

export { NO_LIMITS };

const KEYS = { runsPerRepository: "runs_per_repository", runsPerHost: "runs_per_host" } as const;

export class LimitsConfigError extends Error {
  override readonly name = "LimitsConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadLimits(env: Env = process.env): Limits {
  const path = configPath(env);
  let file: Record<string, unknown> | null;
  try {
    file = readConfigFile(path, Boolean(env["CULTURE_AGENTS_HARNESS_CONFIG"]));
  } catch (err) {
    if (err instanceof HarnessConfigError) throw new LimitsConfigError(err.message);
    throw err;
  }
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
