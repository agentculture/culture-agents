import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apiVersion, type Allowlist } from "../../src/contract/index.js";
import { pollUntil } from "../../src/util/sequence.js";

export interface Env {
  root: string;
  socket: string;
  configHome: string;
  allowlistPath: string;
  vars: Record<string, string>;
  cleanup(): void;
}

/** A private temp tree with a socket path and config home for one test. */
export function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "ca-daemon-"));
  const socket = join(root, "run", "core.sock");
  const configHome = join(root, "config");
  mkdirSync(configHome, { recursive: true });
  const vars = { CULTURE_AGENTS_SOCKET: socket, XDG_CONFIG_HOME: configHome };
  return { root, socket, configHome, allowlistPath: join(configHome, "culture-agents", "allowlist.json"), vars, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function writeAllowlist(env: Env, list: Allowlist | string): void {
  mkdirSync(dirname(env.allowlistPath), { recursive: true });
  writeFileSync(env.allowlistPath, typeof list === "string" ? list : JSON.stringify(list));
}

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: unknown;
}

/** One HTTP request over the Unix socket. */
export function call(socket: string, method: string, path: string, opts: { body?: unknown; rawBody?: string; headers?: Record<string, string>; version?: string | null } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.version !== null) headers["Agents-Api-Version"] = opts.version ?? apiVersion;
    const payload = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const req = request({ socketPath: socket, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON (SSE) */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export interface Child {
  proc: ChildProcess;
  stderr(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Spawn the daemon as a separate process (compiled child.js). */
export function spawnDaemon(env: Env): Child {
  const script = join(dirname(fileURLToPath(import.meta.url)), "child.js");
  const proc = spawn(process.execPath, [script], { env: { ...process.env, ...env.vars }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
  return { proc, stderr: () => err, exited };
}

export async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  if (!(await pollUntil(cond, { everyMs: 20, timeoutMs: ms }))) throw new Error("timed out waiting for condition");
}
