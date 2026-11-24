import { readFileSync, realpathSync } from "node:fs";

import { validate, type Allowlist, type SubmitRequest } from "../contract/index.js";

/** Why the list is what it is, for a future `doctor` check. */
export type AllowlistStatus = "ok" | "missing" | "invalid" | "unreadable";

export interface AllowlistState {
  path: string;
  status: AllowlistStatus;
  /** Entries in force: empty unless status is `ok`. */
  entries: Allowlist["entries"];
  /** Human-readable cause when status is not `ok` or `missing`. */
  detail: string | null;
}

/**
 * Read and validate the allow-list file. A missing file is an empty list; a file that does not validate
 * (or cannot be read or parsed) also counts as empty and is reported through `status` (README: authorization).
 */
export function loadAllowlist(path: string): AllowlistState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { path, status: "missing", entries: [], detail: null };
    return { path, status: "unreadable", entries: [], detail: (e as Error).message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { path, status: "invalid", entries: [], detail: `not valid JSON: ${(e as Error).message}` };
  }
  const result = validate("allowlist", parsed);
  if (!result.ok) {
    const first = result.issues[0];
    return { path, status: "invalid", entries: [], detail: `${first?.path || "(root)"}: ${first?.message ?? "invalid"}` };
  }
  return { path, status: "ok", entries: result.value.entries, detail: null };
}

/** Canonical (realpath) form of a repository path, or null when it cannot be resolved. */
export function canonicalRepo(repo: string): string | null {
  try {
    return realpathSync(repo);
  } catch {
    return null;
  }
}

/**
 * Exact match of agent, harness and canonical repo against the entries. Entry repos are canonicalized
 * the same way; there are no wildcards. Returns the request's canonical repo on a match, else null.
 */
export function matchAllowlist(entries: Allowlist["entries"], request: Pick<SubmitRequest, "agent_id" | "harness" | "repo">): string | null {
  const repo = canonicalRepo(request.repo);
  if (repo === null) return null;
  for (const entry of entries) {
    if (entry.agent_id !== request.agent_id || entry.harness !== request.harness) continue;
    if ((canonicalRepo(entry.repo) ?? entry.repo) === repo) return repo;
  }
  return null;
}
