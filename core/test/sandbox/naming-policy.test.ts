import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  InvalidRunIdError,
  MAX_SANDBOX_NAME,
  runBranch,
  sandboxName,
  validateRunId,
} from "../../src/sandbox/naming.js";
import { DEFAULT_POLICY_PATH, loadPolicyFile, POLICY_DIR, PolicyError, toSdkPolicy } from "../../src/sandbox/policy.js";

test("sandbox names are deterministic, prefixed and within OpenShell's 19-char cap", () => {
  const long = "a".repeat(63);
  const name = sandboxName(long);
  assert.equal(name.length, MAX_SANDBOX_NAME);
  assert.ok(name.startsWith("ca-"));
  assert.equal(sandboxName(long), name);
  assert.notEqual(sandboxName("run-1"), sandboxName("run-2"));
  assert.ok(sandboxName("x", "t10-").startsWith("t10-"));
  assert.match(sandboxName("x", "t10-"), /^t10-[0-9a-f]{15}$/);
});

test("run ids and prefixes outside the safe charset are refused", () => {
  for (const bad of ["", "-x", "a b", "a/b", "a..b", "x.lock", "x.", "a".repeat(64), "ä"]) {
    assert.throws(() => validateRunId(bad), InvalidRunIdError, bad);
  }
  assert.throws(() => sandboxName("ok", "Bad"), InvalidRunIdError);
  assert.throws(() => sandboxName("ok", "much-too-long-"), InvalidRunIdError);
  assert.equal(runBranch("r-1.2_3"), "runs/r-1.2_3");
});

test("the run policy loads, is default-deny on the network and keeps the sandbox filesystem", () => {
  assert.ok(DEFAULT_POLICY_PATH.endsWith("core/policy/run-sandbox.policy.json"));
  const policy = loadPolicyFile();
  assert.equal(policy.version, 1);
  assert.deepEqual(policy.networkPolicies, {});
  assert.equal(policy.filesystem?.includeWorkdir, true);
  assert.ok(policy.filesystem?.readOnly?.includes("/usr"));
  assert.deepEqual(policy.filesystem?.readWrite, ["/tmp", "/dev/null"]);
  assert.equal(policy.landlock?.compatibility, "hard_requirement");
});

test("the policy loader refuses fields it does not understand and any network rule", () => {
  assert.throws(() => toSdkPolicy({ version: 1, filesystem_polcy: {} }), PolicyError);
  assert.throws(() => toSdkPolicy({ version: 2 }), PolicyError);
  assert.throws(() => toSdkPolicy({ version: 1, filesystem_policy: { read_only: ["rel"] } }), PolicyError);
  assert.throws(
    () => toSdkPolicy({ version: 1, network_policies: { github: { endpoints: [{ host: "github.com" }] } } }),
    /must be empty/,
  );
  assert.throws(() => toSdkPolicy({ version: 1, landlock: { compatibility: "maybe" } }), PolicyError);
  assert.deepEqual(toSdkPolicy({ version: 1, process: { run_as_user: "sandbox" } }).process, {
    runAsUser: "sandbox",
    runAsGroup: "",
  });
});

function profile(name: string): string {
  return readFileSync(join(POLICY_DIR, "profiles", name), "utf8");
}

test("provider profiles name credentials by environment variable only", () => {
  const files = readdirSync(join(POLICY_DIR, "profiles"));
  assert.deepEqual(files.sort(), [
    "culture-agents-claude-subscription.yaml",
    "culture-agents-local-gateway.yaml",
  ]);
  for (const file of files) {
    const text = profile(file);
    assert.doesNotMatch(text, /^\s*(value|token|secret|password|api_key)\s*:/m, file);
    assert.doesNotMatch(text, /sk-ant-|sk-[A-Za-z0-9]{20,}|ghp_|github_pat_/, file);
    assert.doesNotMatch(text, /GH_TOKEN|GITHUB_TOKEN|SSH_AUTH_SOCK/, file);
    assert.doesNotMatch(text, /github\.com/, file);
  }
  assert.match(profile("culture-agents-claude-subscription.yaml"), /env_vars: \[CLAUDE_CODE_OAUTH_TOKEN\]/);
  assert.match(profile("culture-agents-local-gateway.yaml"), /env_vars: \[LOBES_GATEWAY_KEY\]/);
});

test("provider profiles name the real harness and bridge binaries, nothing writable", () => {
  const claude = profile("culture-agents-claude-subscription.yaml");
  assert.match(claude, /- \/usr\/lib\/node_modules\/@anthropic-ai\/claude-code\/bin\/claude\.exe$/m);
  assert.match(claude, /- \/usr\/local\/lib\/ai-sdk-harness\/\*\*$/m);
  assert.match(claude, /host: api\.anthropic\.com/);
  const gateway = profile("culture-agents-local-gateway.yaml");
  assert.match(gateway, /- \/usr\/local\/bin\/opencode$/m);
  assert.match(gateway, /- \/usr\/local\/lib\/ai-sdk-harness\/\*\*$/m);
  assert.match(gateway, /host: host\.openshell\.internal\n\s+port: 8001/);
  for (const text of [claude, gateway]) {
    const binaries = text.slice(text.indexOf("binaries:"));
    assert.doesNotMatch(binaries, /\/sandbox|\/tmp|\/usr\/bin\/curl/);
  }
});
