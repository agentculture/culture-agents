import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";

import type { DaemonPaths } from "./paths.js";

/**
 * Single-instance lock.
 *
 * Mechanism (Linux): the lock is a listening socket in the abstract Unix namespace, named after a hash
 * of the lock path. Only one socket can listen on a name, so `listen` failing with EADDRINUSE means
 * another core holds the lock. The kernel destroys an abstract socket when the last descriptor to it
 * closes, which includes the exit of a process killed with SIGKILL. A dead core therefore can never
 * leave a stuck lock, and no cleanup, pid probing or timeout is needed to take over. The lock is taken
 * before the real socket is bound, and a stale socket file is removed only while it is held.
 *
 * Fallback (platforms without abstract sockets): an exclusively created pid file, treated as stale
 * when its pid is not alive. This is best-effort (a reused pid reads as a live holder).
 *
 * The abstract namespace has no file permissions, so another local user could occupy the name and make
 * start fail closed (denial of service only); it grants them no access to the control socket.
 */
export interface HeldLock {
  release(): Promise<void>;
}

/** What a second instance reads to name the running one. */
export interface InstanceInfo {
  pid: number;
  api_version: string;
  socket: string;
}

/** Another core holds the lock. `info` is null when its info file could not be read in time. */
export class LockHeldError extends Error {
  readonly info: InstanceInfo | null;
  constructor(paths: DaemonPaths, info: InstanceInfo | null) {
    super(
      info
        ? `culture-agents core is already running (pid ${info.pid}, socket ${info.socket}); stop it first.`
        : `culture-agents core is already running (pid unknown) on socket ${paths.socket}; stop it first.`,
    );
    this.name = "LockHeldError";
    this.info = info;
  }
}

const LINUX = process.platform === "linux";

function abstractName(lockPath: string): string {
  return `\0culture-agents-lock-${createHash("sha256").update(lockPath).digest("hex").slice(0, 40)}`;
}

function listenAbstract(name: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen({ path: name }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquirePidFile(path: string): HeldLock | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return { release: () => Promise.resolve(void safeUnlink(path)) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number.parseInt(readFileSafe(path) ?? "", 10);
      if (Number.isInteger(pid) && pidAlive(pid)) return null;
      safeUnlink(path);
    }
  }
  return null;
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/** Take the exclusive lock, or throw `LockHeldError` naming the running instance. */
export async function acquireLock(paths: DaemonPaths): Promise<HeldLock> {
  if (LINUX) {
    try {
      const server = await listenAbstract(abstractName(paths.lock));
      return { release: () => new Promise<void>((resolve) => server.close(() => resolve())) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  } else {
    const held = acquirePidFile(paths.lock);
    if (held) return held;
  }
  throw new LockHeldError(paths, await readInstanceInfo(paths));
}

/** Publish pid and API version for second instances (atomic replace). Call only while holding the lock. */
export function writeInstanceInfo(paths: DaemonPaths, info: InstanceInfo): void {
  const tmp = `${paths.info}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  renameSync(tmp, paths.info);
}

export function removeInstanceInfo(paths: DaemonPaths): void {
  safeUnlink(paths.info);
}

/**
 * Read the running instance's info. The holder removes a dead predecessor's file and writes its own
 * right after taking the lock, so retry briefly while the file is missing or names a dead pid.
 */
export async function readInstanceInfo(paths: DaemonPaths, attempts = 20, delayMs = 25): Promise<InstanceInfo | null> {
  for (let i = 0; i < attempts; i++) {
    const text = readFileSafe(paths.info);
    if (text) {
      try {
        const info = JSON.parse(text) as InstanceInfo;
        if (Number.isInteger(info.pid) && pidAlive(info.pid)) return info;
      } catch {
        /* partially written; retry */
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}
