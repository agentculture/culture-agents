/**
 * Harness configuration values that later reach a command line or a file are validated when the
 * configuration is loaded: a pasted key is refused instead of being written to disk, an option-like
 * name never reaches a CLI, and the availability checks pass names after `--`.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { checkSandboxHarness } from "../../src/harness/availability.js";
import { DEFAULT_RETAIN_FAILED_SANDBOX_DAYS, HarnessConfigError, loadHarnessConfig } from "../../src/harness/config.js";

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ca-harness-cfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fromFile(t: TestContext, content: unknown, env: Record<string, string> = {}) {
  const path = join(scratch(t), "harness.json");
  writeFileSync(path, JSON.stringify(content));
  return loadHarnessConfig({ HOME: "/nonexistent", CULTURE_AGENTS_HARNESS_CONFIG: path, ...env });
}

const refused = (env: Record<string, string>, pattern: RegExp): void => {
  assert.throws(() => loadHarnessConfig({ HOME: "/nonexistent", ...env }), (err: unknown) => err instanceof HarnessConfigError && pattern.test(err.message), JSON.stringify(env));
};

test("opencode.keyEnv must be a variable name; a pasted key is refused and not echoed", () => {
  const pasted = "sk-live-0123456789abcdef";
  for (const value of [pasted, "KEY WITH SPACE", "1KEY", "KEY}", "a=b", "{env:X}"]) {
    assert.throws(
      () => loadHarnessConfig({ HOME: "/nonexistent", CULTURE_AGENTS_OPENCODE_KEY_ENV: value }),
      (err: unknown) => err instanceof HarnessConfigError && /opencode\.keyEnv must be the NAME of an environment variable/.test(err.message) && !err.message.includes(value),
      value,
    );
  }
  assert.equal(loadHarnessConfig({ HOME: "/nonexistent", CULTURE_AGENTS_OPENCODE_KEY_ENV: "_My_KEY2" }).opencode.keyEnv, "_My_KEY2");
});

test("opencode.port in the config file may be a JSON number or a string", (t) => {
  assert.equal(fromFile(t, { opencode: { port: 4100 } }).opencode.port, 4100);
  assert.equal(fromFile(t, { opencode: { port: "4101" } }).opencode.port, 4101);
  assert.equal(fromFile(t, { opencode: { port: 4100 } }, { CULTURE_AGENTS_OPENCODE_PORT: "4102" }).opencode.port, 4102, "the environment still wins");
  for (const port of [0, 70000, 4096.5, "abc", true, [4096], "0x10", ""]) {
    assert.throws(() => fromFile(t, { opencode: { port } }), HarnessConfigError, JSON.stringify(port));
  }
});

test("image, provider and gateway names cannot be option-like or carry shell or path tricks", () => {
  refused({ CULTURE_AGENTS_RUN_IMAGE: "--privileged" }, /image must be/);
  refused({ CULTURE_AGENTS_RUN_IMAGE: "img name" }, /image must be/);
  refused({ CULTURE_AGENTS_RUN_IMAGE: "img;rm" }, /image must be/);
  refused({ CULTURE_AGENTS_CLAUDE_PROVIDERS: "-g" }, /claudeCode\.providers must be/);
  refused({ CULTURE_AGENTS_OPENCODE_PROVIDERS: "ok,--help" }, /opencode\.providers must be/);
  refused({ CULTURE_AGENTS_OPENCODE_PROVIDERS: "a/b" }, /opencode\.providers must be/);
  refused({ CULTURE_AGENTS_GATEWAY_NAME: "--gateway-insecure" }, /gateway\.name must be/);
  refused({ CULTURE_AGENTS_RUN_REF: "--upload-pack=x" }, /ref must be/);
  const ok = loadHarnessConfig({
    HOME: "/nonexistent",
    CULTURE_AGENTS_RUN_IMAGE: "registry.example:5000/team/culture-agents-run@sha256:0123abcd",
    CULTURE_AGENTS_CLAUDE_PROVIDERS: "claude-sub, claude_2.b",
    CULTURE_AGENTS_GATEWAY_NAME: "openshell",
    CULTURE_AGENTS_RUN_REF: "refs/heads/feature/x~2",
  });
  assert.equal(ok.image, "registry.example:5000/team/culture-agents-run@sha256:0123abcd");
  assert.deepEqual(ok.claudeCode.providers, ["claude-sub", "claude_2.b"]);
  assert.equal(ok.ref, "refs/heads/feature/x~2");
});

test("opencode.baseUrl must be an http(s) URL without credentials", () => {
  for (const url of ["not a url", "file:///etc/passwd", "ftp://host/v1", "http://user:secret@host:8001/v1", "https://token@host/v1", "host:8001/v1"]) {
    assert.throws(
      () => loadHarnessConfig({ HOME: "/nonexistent", CULTURE_AGENTS_OPENCODE_BASE_URL: url }),
      (err: unknown) => err instanceof HarnessConfigError && /opencode\.baseUrl must be/.test(err.message) && !err.message.includes("secret"),
      url,
    );
  }
  assert.equal(loadHarnessConfig({ HOME: "/nonexistent", CULTURE_AGENTS_OPENCODE_BASE_URL: "https://gw.internal:8443/v1" }).opencode.baseUrl, "https://gw.internal:8443/v1");
});

test("retainFailedSandboxDays: 7 by default, 0 to 90 from the environment or the file", (t) => {
  assert.equal(DEFAULT_RETAIN_FAILED_SANDBOX_DAYS, 7);
  assert.equal(loadHarnessConfig({ HOME: "/nonexistent" }).retainFailedSandboxDays, 7);
  assert.equal(loadHarnessConfig({ HOME: "/nonexistent", CULTURE_AGENTS_RETAIN_FAILED_SANDBOX_DAYS: "0" }).retainFailedSandboxDays, 0);
  assert.equal(loadHarnessConfig({ HOME: "/nonexistent", CULTURE_AGENTS_RETAIN_FAILED_SANDBOX_DAYS: "0.5" }).retainFailedSandboxDays, 0.5);
  assert.equal(fromFile(t, { retainFailedSandboxDays: 30 }).retainFailedSandboxDays, 30);
  assert.equal(fromFile(t, { retainFailedSandboxDays: 30 }, { CULTURE_AGENTS_RETAIN_FAILED_SANDBOX_DAYS: "90" }).retainFailedSandboxDays, 90);
  for (const value of ["-1", "91", "week", "NaN", "Infinity"]) refused({ CULTURE_AGENTS_RETAIN_FAILED_SANDBOX_DAYS: value }, /retainFailedSandboxDays must be a number from 0 to 90/);
  assert.throws(() => fromFile(t, { retainFailedSandboxDays: "many" }), HarnessConfigError);
});

test("the availability checks pass the image and provider names after --", async (t) => {
  const dir = scratch(t);
  const log = join(dir, "args.log");
  const bin = (name: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s|' ${name} "$@" >> '${log}'; echo >> '${log}'; echo '{}'\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const config = { ...loadHarnessConfig({ HOME: "/nonexistent" }), dockerBin: bin("docker"), openshellBin: bin("openshell"), image: "img:1", gateway: { endpoint: "https://x", tlsDir: null, name: "gw" } };
  await checkSandboxHarness(config, ["p1"]);
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).sort();
  assert.deepEqual(lines, ["docker|image|inspect|--format|{{json .Config.Labels}}|--|img:1|", "openshell|-g|gw|provider|get|--|p1|"]);
});
