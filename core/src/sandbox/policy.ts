// Loads the authored run policy (core/policy/run-sandbox.policy.json) and maps
// it to the create-time policy shape the OpenShell SDK takes.
//
// The file is OpenShell's authored policy schema written as JSON, so
// `openshell policy lint core/policy/run-sandbox.policy.json` validates it
// offline. This loader supports exactly the sections the run policy uses and
// refuses anything else, so a field it does not understand can never be
// dropped silently on the way to the gateway.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SandboxPolicyInit } from "./openshell-client.js";

/** `core/policy/` resolved from compiled output (`dist/src/sandbox/`) or source. */
export const POLICY_DIR = fileURLToPath(new URL("../../../policy/", import.meta.url));
export const DEFAULT_POLICY_PATH = `${POLICY_DIR}run-sandbox.policy.json`;

export class PolicyError extends Error {
  override readonly name = "PolicyError";
}

const TOP = new Set(["version", "filesystem_policy", "landlock", "process", "network_policies"]);
const FS = new Set(["include_workdir", "read_only", "read_write"]);

export interface AuthoredPolicy {
  version: 1;
  filesystem_policy?: { include_workdir?: boolean; read_only?: string[]; read_write?: string[] };
  landlock?: { compatibility: "best_effort" | "hard_requirement" };
  process?: { run_as_user?: string; run_as_group?: string };
  network_policies?: Record<string, never>;
}

export function loadPolicyFile(path: string = DEFAULT_POLICY_PATH): SandboxPolicyInit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PolicyError(`cannot read policy ${path}: ${(error as Error).message}`);
  }
  return toSdkPolicy(parsed);
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.startsWith("/"))) {
    throw new PolicyError(`${where} must be a list of absolute paths`);
  }
  return [...value] as string[];
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new PolicyError(`unsupported field ${where}${key}`);
  }
}

function filesystemPolicy(value: unknown): NonNullable<SandboxPolicyInit["filesystem"]> {
  const fs = object(value, "filesystem_policy");
  onlyKeys(fs, FS, "filesystem_policy.");
  return {
    includeWorkdir: fs["include_workdir"] === undefined ? false : fs["include_workdir"] === true,
    readOnly: fs["read_only"] === undefined ? [] : strings(fs["read_only"], "read_only"),
    readWrite: fs["read_write"] === undefined ? [] : strings(fs["read_write"], "read_write"),
  };
}

function landlockPolicy(value: unknown): NonNullable<SandboxPolicyInit["landlock"]> {
  const ll = object(value, "landlock");
  onlyKeys(ll, new Set(["compatibility"]), "landlock.");
  const c = ll["compatibility"];
  if (c !== "best_effort" && c !== "hard_requirement") {
    throw new PolicyError("landlock.compatibility must be best_effort or hard_requirement");
  }
  return { compatibility: c };
}

function processPolicy(value: unknown): NonNullable<SandboxPolicyInit["process"]> {
  const p = object(value, "process");
  onlyKeys(p, new Set(["run_as_user", "run_as_group"]), "process.");
  return {
    runAsUser: typeof p["run_as_user"] === "string" ? p["run_as_user"] : "",
    runAsGroup: typeof p["run_as_group"] === "string" ? p["run_as_group"] : "",
  };
}

/**
 * Default deny: the run policy grants no network rule of its own. Endpoints
 * come only from attached provider profiles, which OpenShell composes in.
 */
function checkNetworkPolicies(value: unknown): void {
  const net = object(value, "network_policies");
  if (Object.keys(net).length > 0) {
    throw new PolicyError(
      "network_policies must be empty: run sandboxes get network access only from provider profiles",
    );
  }
}

/** Validate an authored policy object and convert it to the SDK's create-time shape. */
export function toSdkPolicy(input: unknown): SandboxPolicyInit {
  const doc = object(input, "policy");
  onlyKeys(doc, TOP, "");
  if (doc["version"] !== 1) throw new PolicyError("policy version must be 1");
  const out: SandboxPolicyInit = { version: 1, networkPolicies: {} };

  if (doc["filesystem_policy"] !== undefined) out.filesystem = filesystemPolicy(doc["filesystem_policy"]);
  if (doc["landlock"] !== undefined) out.landlock = landlockPolicy(doc["landlock"]);
  if (doc["process"] !== undefined) out.process = processPolicy(doc["process"]);
  if (doc["network_policies"] !== undefined) checkNetworkPolicies(doc["network_policies"]);
  return out;
}
