/**
 * Harness configuration: where the sandbox gateway is, which image and credential providers a
 * run uses, and each harness's model. Read from environment variables, then an optional JSON
 * file, then the defaults below (environment wins over the file, the file over defaults).
 *
 * OWNER REVIEW: every key and default here is a decision. Defaults match the D1 probe
 * (docs/d0/probe.md) and the gateway running on the fleet host.
 *
 * | JSON key (file)        | Environment variable                 | Default                                   |
 * | ---------------------- | ------------------------------------ | ----------------------------------------- |
 * | (the file itself)      | CULTURE_AGENTS_HARNESS_CONFIG        | $XDG_CONFIG_HOME/culture-agents/harness.json (~/.config when XDG_CONFIG_HOME is unset); a missing file is fine |
 * | gateway.endpoint       | CULTURE_AGENTS_GATEWAY_ENDPOINT      | https://127.0.0.1:17670 (local OpenShell gateway) |
 * | gateway.tlsDir         | CULTURE_AGENTS_GATEWAY_TLS_DIR       | $OPENSHELL_LOCAL_TLS_DIR, else unset (the harness is then unavailable) |
 * | gateway.name           | CULTURE_AGENTS_GATEWAY_NAME          | unset: the `openshell` CLI's default gateway (used by `collect`) |
 * | openshellBin           | CULTURE_AGENTS_OPENSHELL_BIN         | openshell (on PATH; `collect` runs `sandbox ssh-config`) |
 * | dockerBin              | CULTURE_AGENTS_DOCKER_BIN            | docker (availability check: the image exists locally) |
 * | image                  | CULTURE_AGENTS_RUN_IMAGE             | culture-agents-run:dev (built by core/image/build.sh) |
 * | sandboxPrefix          | CULTURE_AGENTS_SANDBOX_PREFIX        | ca- (1-9 of [a-z0-9-], starting with a letter) |
 * | ref                    | CULTURE_AGENTS_RUN_REF               | HEAD (the host repository commit a run starts from) |
 * | identity.name / .email | CULTURE_AGENTS_COMMIT_NAME / _EMAIL  | culture-agents run / runs@culture-agents.invalid (never the operator's) |
 * | claudeCode.providers   | CULTURE_AGENTS_CLAUDE_PROVIDERS      | claude-sub (comma-separated provider names on the gateway) |
 * | claudeCode.model       | CULTURE_AGENTS_CLAUDE_MODEL          | haiku (one of haiku, sonnet, opus: the AI SDK adapter's model ids) |
 * | opencode.providers     | CULTURE_AGENTS_OPENCODE_PROVIDERS    | lobes |
 * | opencode.model         | CULTURE_AGENTS_OPENCODE_MODEL        | gateway/worker (`<provider id>/<model id>` in the generated OpenCode config) |
 * | opencode.baseUrl       | CULTURE_AGENTS_OPENCODE_BASE_URL     | http://host.openshell.internal:8001/v1 (the model gateway as a sandbox sees it) |
 * | opencode.keyEnv        | CULTURE_AGENTS_OPENCODE_KEY_ENV      | LOBES_GATEWAY_KEY (sandbox variable holding the provider placeholder; never a value) |
 * | opencode.port          | CULTURE_AGENTS_OPENCODE_PORT         | 4096 (port of `opencode serve` inside the sandbox) |
 * | stub                   | CULTURE_AGENTS_HARNESS_STUB          | false; "1"/"true" lists the harness-neutral `stub` harness |
 *
 * No credential value is ever read here: providers are referenced by name and keys by the
 * name of the variable that holds OpenShell's placeholder inside the sandbox.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_MODELS = ["haiku", "sonnet", "opus"] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export interface HarnessConfig {
  gateway: { endpoint: string; tlsDir: string | null; name: string | null };
  openshellBin: string;
  dockerBin: string;
  image: string;
  sandboxPrefix: string;
  ref: string;
  identity: { name: string; email: string };
  claudeCode: { providers: string[]; model: ClaudeModel };
  opencode: { providers: string[]; model: string; baseUrl: string; keyEnv: string; port: number };
  stub: boolean;
  /** The config file that was read, or null. */
  file: string | null;
}

export class HarnessConfigError extends Error {
  override readonly name = "HarnessConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;
type Json = Record<string, unknown>;

function configPath(env: Env): string {
  const explicit = env["CULTURE_AGENTS_HARNESS_CONFIG"];
  if (explicit) return explicit;
  return join(env["XDG_CONFIG_HOME"] || join(env["HOME"] || homedir(), ".config"), "culture-agents", "harness.json");
}

function readFile(path: string, explicit: boolean): Json | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (!explicit && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HarnessConfigError(`cannot read harness config ${path}: ${(err as Error).message}`);
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
    return value as Json;
  } catch (err) {
    throw new HarnessConfigError(`harness config ${path} is invalid: ${(err as Error).message}`);
  }
}

function pick(file: Json | null, path: string): unknown {
  let cur: unknown = file;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Json)[key];
  }
  return cur;
}

export function loadHarnessConfig(env: Env = process.env): HarnessConfig {
  const path = configPath(env);
  const file = readFile(path, Boolean(env["CULTURE_AGENTS_HARNESS_CONFIG"]));
  const str = (envName: string, key: string, fallback: string): string => {
    const fromEnv = env[envName];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    const fromFile = pick(file, key);
    if (fromFile === undefined || fromFile === null) return fallback;
    if (typeof fromFile !== "string" || fromFile === "") throw new HarnessConfigError(`${key} must be a non-empty string`);
    return fromFile;
  };
  const optional = (envName: string, key: string, fallback: string | null): string | null => {
    const value = str(envName, key, "");
    return value === "" ? fallback : value;
  };
  const list = (envName: string, key: string, fallback: string[]): string[] => {
    const fromEnv = env[envName];
    const raw = fromEnv !== undefined && fromEnv !== "" ? fromEnv.split(",") : (pick(file, key) ?? fallback);
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || v.trim() === "")) {
      throw new HarnessConfigError(`${key} must be a list of provider names`);
    }
    return (raw as string[]).map((v) => v.trim());
  };
  const model = str("CULTURE_AGENTS_CLAUDE_MODEL", "claudeCode.model", "haiku");
  if (!(CLAUDE_MODELS as readonly string[]).includes(model)) {
    throw new HarnessConfigError(`claudeCode.model must be one of ${CLAUDE_MODELS.join(", ")}`);
  }
  const port = Number(str("CULTURE_AGENTS_OPENCODE_PORT", "opencode.port", "4096"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HarnessConfigError("opencode.port must be a TCP port");
  const ocModel = str("CULTURE_AGENTS_OPENCODE_MODEL", "opencode.model", "gateway/worker");
  if (!/^[^/\s]+\/[^\s]+$/.test(ocModel)) throw new HarnessConfigError("opencode.model must be <provider id>/<model id>");
  const prefix = str("CULTURE_AGENTS_SANDBOX_PREFIX", "sandboxPrefix", "ca-");
  if (!/^[a-z][a-z0-9-]{0,8}$/.test(prefix)) throw new HarnessConfigError("sandboxPrefix must be 1-9 of [a-z0-9-], starting with a letter");
  const stubRaw = env["CULTURE_AGENTS_HARNESS_STUB"] ?? pick(file, "stub");
  return {
    gateway: {
      endpoint: str("CULTURE_AGENTS_GATEWAY_ENDPOINT", "gateway.endpoint", "https://127.0.0.1:17670"),
      tlsDir: optional("CULTURE_AGENTS_GATEWAY_TLS_DIR", "gateway.tlsDir", env["OPENSHELL_LOCAL_TLS_DIR"] || null),
      name: optional("CULTURE_AGENTS_GATEWAY_NAME", "gateway.name", null),
    },
    openshellBin: str("CULTURE_AGENTS_OPENSHELL_BIN", "openshellBin", "openshell"),
    dockerBin: str("CULTURE_AGENTS_DOCKER_BIN", "dockerBin", "docker"),
    image: str("CULTURE_AGENTS_RUN_IMAGE", "image", "culture-agents-run:dev"),
    sandboxPrefix: prefix,
    ref: str("CULTURE_AGENTS_RUN_REF", "ref", "HEAD"),
    identity: {
      name: str("CULTURE_AGENTS_COMMIT_NAME", "identity.name", "culture-agents run"),
      email: str("CULTURE_AGENTS_COMMIT_EMAIL", "identity.email", "runs@culture-agents.invalid"),
    },
    claudeCode: { providers: list("CULTURE_AGENTS_CLAUDE_PROVIDERS", "claudeCode.providers", ["claude-sub"]), model: model as ClaudeModel },
    opencode: {
      providers: list("CULTURE_AGENTS_OPENCODE_PROVIDERS", "opencode.providers", ["lobes"]),
      model: ocModel,
      baseUrl: str("CULTURE_AGENTS_OPENCODE_BASE_URL", "opencode.baseUrl", "http://host.openshell.internal:8001/v1"),
      keyEnv: str("CULTURE_AGENTS_OPENCODE_KEY_ENV", "opencode.keyEnv", "LOBES_GATEWAY_KEY"),
      port,
    },
    stub: stubRaw === true || stubRaw === "1" || stubRaw === "true",
    file: file === null ? null : path,
  };
}
