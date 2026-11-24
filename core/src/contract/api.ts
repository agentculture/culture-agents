import type { ErrorCode, RunState } from "./generated/index.js";
import { loadJson } from "./schemas.js";

/** The parts of `api.json` that this module reads. */
interface ApiIndex {
  api_version: string;
  errors: Record<ErrorCode, { http_status: number; exit_code: number; retryable: boolean | null }>;
  state_machine: {
    initial: RunState;
    active: RunState[];
    terminal: RunState[];
    transitions: Record<RunState, RunState[]>;
  };
}

export const api = loadJson("api.json") as ApiIndex;

/** The contract version this build speaks, from `api.json` (`MAJOR.MINOR`). */
export const apiVersion: string = api.api_version;

/** HTTP header every request carries (api.json `transport.version_header`). */
export const API_VERSION_HEADER = "Agents-Api-Version";

export interface ApiVersion {
  major: number;
  minor: number;
}

/** Parse `MAJOR.MINOR`; returns null for anything else. */
export function parseApiVersion(text: string): ApiVersion | null {
  const m = /^(\d+)\.(\d+)$/.exec(text);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/**
 * Compatibility rule: a client at `C.x` and a core at `S.y` are compatible exactly when
 * `C == S` and `y >= x`. An unparseable version is never compatible.
 */
export function isCompatible(clientVersion: string, serverVersion: string): boolean {
  const c = parseApiVersion(clientVersion);
  const s = parseApiVersion(serverVersion);
  return c !== null && s !== null && c.major === s.major && s.minor >= c.minor;
}

/** HTTP status for an error code (api.json `errors`). */
export function httpStatusFor(code: ErrorCode): number {
  return api.errors[code].http_status;
}

/** CLI exit code for an error code: 1 for a user error, 2 for an environment error. */
export function exitCodeFor(code: ErrorCode): number {
  return api.errors[code].exit_code;
}

/** Fixed `retryable` for a code; null when it varies (`conflict`). */
export function retryableFor(code: ErrorCode): boolean | null {
  return api.errors[code].retryable;
}

/** Every error code in api.json. */
export const errorCodes = Object.keys(api.errors) as ErrorCode[];
