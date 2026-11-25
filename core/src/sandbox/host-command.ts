// Host-side command runner for git and the `openshell` CLI, injectable so the
// working-tree tests can record every command without touching a repository.
import { execFile } from "node:child_process";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/**
 * Environment for host commands: the parent environment minus every `GIT_*`
 * variable (a stray GIT_DIR or GIT_WORK_TREE would point git at another
 * repository) and minus the operator's GitHub/SSH agent credentials, which no
 * fetch from a sandbox needs.
 */
export function hostEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("GIT_")) continue;
    if (key === "GH_TOKEN" || key === "GITHUB_TOKEN" || key === "SSH_AUTH_SOCK") continue;
    env[key] = value;
  }
  env["GIT_TERMINAL_PROMPT"] = "0";
  return { ...env, ...extra };
}

function exitCodeOf(error: { code?: unknown } | null): number {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : 1;
}

export const runCommand: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ? { ...options.env } : hostEnv(),
        timeout: options.timeoutMs ?? 300_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = exitCodeOf(error);
        resolve({ code, stdout, stderr: stderr || (error && code !== 0 ? error.message : "") });
      },
    );
  });
