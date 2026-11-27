/**
 * The aliases a core gives its checkouts (docs/d2/part-two-design.md, Decision 4): the local file
 * `${XDG_CONFIG_HOME:-$HOME/.config}/culture-agents/fleet/aliases.json`, beside the trust list, as
 * `{ "version": 1, "aliases": [{ "alias": "culture-agents", "repo": "/abs/path" }] }`
 * (contract `remote.json#/$defs/alias_file`). It is local and untracked, like the allow-list.
 *
 * - A member names a repository only by an alias this host defines; the alias resolves to a path on
 *   this host, and the allow-list (agent, harness, canonical path) applies to that path unchanged.
 *   No path crosses the network: another member sees aliases, never paths.
 * - "The same repository" on two hosts is the operators' claim, made by giving the checkouts the same
 *   alias. The core never infers it; it checks only a commit the caller names (serve-runs.ts).
 * - The file is read again on every call, with the trust file's 1 MiB cap. A missing file defines no
 *   alias. A file that cannot be read or does not validate defines none either, and says why.
 */
import { join } from "node:path";

import { validate, type AliasFile, type AliasList, type Allowlist } from "../contract/index.js";
import { canonicalRepo } from "../daemon/allowlist.js";
import { readTrustText, resolveTrustPath } from "./trust.js";

export interface AliasState {
  path: string;
  /** In force: empty unless the file is valid. */
  aliases: AliasFile["aliases"];
  /** Why the file defines nothing, when it exists and is refused. */
  problem: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

export function resolveAliasesPath(env: Env = process.env): string {
  return join(resolveTrustPath(env), "..", "aliases.json");
}

/** Read and check the alias file. Never throws: a refused file is an empty list with a `problem`. */
export function loadAliases(path: string): AliasState {
  let text: string | null;
  try {
    text = readTrustText(path);
  } catch (e) {
    return { path, aliases: [], problem: (e as Error).message };
  }
  if (text === null) return { path, aliases: [], problem: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { path, aliases: [], problem: `${path} is not valid JSON` };
  }
  const checked = validate("remote#alias_file", parsed);
  if (!checked.ok) return { path, aliases: [], problem: `${path}: ${checked.issues[0]?.path || "(root)"} ${checked.issues[0]?.message ?? "is invalid"}` };
  const names = checked.value.aliases.map((a) => a.alias);
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice !== undefined) return { path, aliases: [], problem: `${path} defines alias ${twice} twice` };
  return { path, aliases: checked.value.aliases, problem: null };
}

/** The path an alias resolves to on this host, or null when this host defines no such alias. */
export function resolveAlias(state: AliasState, alias: string): string | null {
  return state.aliases.find((a) => a.alias === alias)?.repo ?? null;
}

/** What `GET /v1/fleet/aliases` reports: each alias and the agent and harness pairs the allow-list permits on its path. No path. */
export function aliasList(node: string, state: AliasState, entries: Allowlist["entries"]): AliasList {
  const aliases = state.aliases.map((a) => {
    const repo = canonicalRepo(a.repo) ?? a.repo;
    const permits = entries.filter((e) => (canonicalRepo(e.repo) ?? e.repo) === repo).map((e) => ({ agent_id: e.agent_id, harness: e.harness }));
    return { alias: a.alias, permits };
  });
  return { node, aliases };
}
