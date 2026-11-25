import { chmodSync, lstatSync, mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";

import { apiVersion } from "../contract/index.js";
import { version as coreVersion } from "../index.js";
import { loadAllowlist, type AllowlistState } from "./allowlist.js";
import { sendError } from "./http.js";
import { acquireLock, removeInstanceInfo, writeInstanceInfo, type HeldLock } from "./lock.js";
import { resolveAllowlistPath, resolvePaths, type DaemonPaths } from "./paths.js";
import type { RunService } from "./ports.js";
import { handle, type RouteContext } from "./routes.js";

export interface DaemonOptions {
  service: RunService;
  /** This host's node name (the `<node>` of local agents). */
  node: string;
  env?: Record<string, string | undefined>;
  /** Allow-list file; defaults to the user config dir. */
  allowlistPath?: string;
  now?: () => Date;
  /** Idle SSE keepalive interval; the contract requires 15 s or less. */
  keepaliveMs?: number;
}

export interface Daemon {
  readonly paths: DaemonPaths;
  /** Current allow-list state (re-read from disk), for a `doctor` check. */
  allowlistState(): AllowlistState;
  /** Stop serving, end streams, remove the socket and info file, release the lock. Idempotent. */
  stop(): Promise<void>;
}

/** Create the socket directory (mode 0700) and refuse one that someone else could use. */
function prepareDirectory(paths: DaemonPaths): void {
  const uid = process.getuid?.();
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(paths.dir);
  if (!st.isDirectory()) throw new Error(`${paths.dir} is not a directory; remove it or set CULTURE_AGENTS_SOCKET.`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${paths.dir} is owned by another user; refusing to place the control socket there.`);
  // Only tighten directories this daemon derives itself; an overridden location may be shared on purpose.
  if (!paths.overridden && (st.mode & 0o077) !== 0) chmodSync(paths.dir, 0o700);
}

/** Remove a leftover socket file. Call only while holding the lock: nothing else can be serving it. */
function removeStaleSocket(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`${path} exists and is not a socket; refusing to remove it.`);
  unlinkSync(path);
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const previous = process.umask(0o177); // socket is created 0600
    server.listen(path, () => {
      process.umask(previous);
      server.off("error", reject);
      resolve();
    });
    server.once("error", () => process.umask(previous));
  });
}

/**
 * Start the daemon: take the single-instance lock, clear a stale socket, bind it owner-only, publish
 * the instance info. Throws `LockHeldError` when another core runs. Order matters: lock, then unlink,
 * then bind.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const env = options.env ?? process.env;
  const paths = resolvePaths(env);
  const allowlistPath = options.allowlistPath ?? resolveAllowlistPath(env);
  prepareDirectory(paths);

  const lock: HeldLock = await acquireLock(paths);
  const shutdown = new AbortController();
  const ctx: RouteContext = {
    service: options.service,
    allowlist: () => loadAllowlist(allowlistPath),
    node: options.node,
    coreVersion,
    now: options.now ?? (() => new Date()),
    keepaliveMs: Math.max(1, options.keepaliveMs ?? 15_000), // never a zero-delay interval
    shutdown: shutdown.signal,
  };
  const server = createServer((req, res) => {
    handle(ctx, req, res).catch((e: unknown) => sendError(res, e));
  });

  let bound = false;
  try {
    removeStaleSocket(paths.socket);
    removeInstanceInfo(paths);
    await listen(server, paths.socket);
    bound = true;
    chmodSync(paths.socket, 0o600);
    if ((statSync(paths.socket).mode & 0o777) !== 0o600) throw new Error(`could not set ${paths.socket} to mode 0600`);
    writeInstanceInfo(paths, { pid: process.pid, api_version: apiVersion, socket: paths.socket });
  } catch (e) {
    server.close();
    // Still under the lock: a socket this start bound is ours to remove, so no stale file is left.
    if (bound) rmSync(paths.socket, { force: true });
    await lock.release();
    throw e;
  }

  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      shutdown.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      try {
        unlinkSync(paths.socket);
      } catch {
        /* already removed by close */
      }
      removeInstanceInfo(paths);
      await lock.release();
    })();
    return stopped;
  };
  return { paths, allowlistState: () => ctx.allowlist(), stop };
}
