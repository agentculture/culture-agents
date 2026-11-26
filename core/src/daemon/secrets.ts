/**
 * Secrets the core is started with, declared in ONE place.
 *
 * At start the core reads each variable below once (`takeSecrets`), keeps the value in memory and
 * deletes it from `process.env`, so no worker, host command (git, `openshell`) or sandbox inherits
 * it. `scrubSecrets` (used by the worker spawner, the host command runner and the sandbox scrub) is
 * a second line: whatever is still in a copied environment is dropped by name.
 *
 * Documented in core/README.md ("Injected secrets").
 */
export const INJECTED_SECRETS: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "LOBES_GATEWAY_KEY",
];

type MutableEnv = Record<string, string | undefined>;

const held = new Map<string, string>();

/** Read each named variable once, keep it in memory and delete it from `env`. Returns the names removed. */
export function takeSecrets(env: MutableEnv = process.env, names: readonly string[] = INJECTED_SECRETS): string[] {
  const removed: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (value === undefined) continue;
    if (value !== "") held.set(name, value);
    Reflect.deleteProperty(env, name);
    removed.push(name);
  }
  return removed;
}

/** A secret taken at start, or undefined. Never written to a worker, a host command or a sandbox. */
export function heldSecret(name: string): string | undefined {
  return held.get(name);
}

/** A copy of `env` without any injected secret. */
export function scrubSecrets<T extends Readonly<Record<string, string | undefined>>>(env: T): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !INJECTED_SECRETS.includes(key)) out[key] = value;
  }
  return out;
}
