import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the daemon keeps its files (contract/README.md: transport, authorization).
 *
 * - socket: `$CULTURE_AGENTS_SOCKET`, else `$XDG_RUNTIME_DIR/culture-agents/core.sock`, else
 *   `/tmp/culture-agents-<uid>/core.sock`.
 * - lock key and pid file sit beside the socket (`<socket>.lock`, `<socket>.pid`).
 * - allow-list: `${XDG_CONFIG_HOME:-$HOME/.config}/culture-agents/allowlist.json`.
 */
export interface DaemonPaths {
  socket: string;
  /** Identity of the instance lock (see lock.ts); derived from the socket path, never created as a file. */
  lock: string;
  /** Small JSON file naming the running instance (pid, API version). */
  info: string;
  /** Directory that holds the socket. */
  dir: string;
  /** True when the socket path came from the override variable (the directory is then not ours to chmod). */
  overridden: boolean;
}

type Env = Record<string, string | undefined>;

export function resolveSocketPath(env: Env = process.env, uid: number = process.getuid?.() ?? 0): { path: string; overridden: boolean } {
  const override = env["CULTURE_AGENTS_SOCKET"];
  if (override) return { path: override, overridden: true };
  const runtime = env["XDG_RUNTIME_DIR"];
  if (runtime) return { path: join(runtime, "culture-agents", "core.sock"), overridden: false };
  return { path: join("/tmp", `culture-agents-${uid}`, "core.sock"), overridden: false };
}

export function resolvePaths(env: Env = process.env, uid?: number): DaemonPaths {
  const { path, overridden } = resolveSocketPath(env, uid);
  return { socket: path, lock: `${path}.lock`, info: `${path}.pid`, dir: dirname(path), overridden };
}

export function resolveAllowlistPath(env: Env = process.env): string {
  const config = env["XDG_CONFIG_HOME"] || join(env["HOME"] || homedir(), ".config");
  return join(config, "culture-agents", "allowlist.json");
}

/** Path of the local `server.yaml` that names this node (README: identifiers). */
export function resolveServerYamlPath(env: Env = process.env): string {
  return env["CULTURE_SERVER_YAML"] || join(env["HOME"] || homedir(), ".culture", "server.yaml");
}
