/**
 * The registry shape another module codes against, the configuration loader, the capability
 * documents (validated against contract/capabilities.json), and refusal of every undeclared
 * capability for every harness.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { validate, type CapabilityName } from "../../src/contract/index.js";
import {
  HarnessConfigError,
  getHarness,
  guardDriver,
  listHarnesses,
  loadHarnessConfig,
  refusalFor,
  UnsupportedCapabilityError,
} from "../../src/harness/index.js";
import type { Driver } from "../../src/worker/driver.js";

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ca-harness-reg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A shell script standing in for docker or openshell. */
function fakeBin(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("defaults match the probe and no file is required", () => {
  const c = loadHarnessConfig({ HOME: "/nonexistent" });
  assert.equal(c.gateway.endpoint, "https://127.0.0.1:17670");
  assert.equal(c.gateway.tlsDir, null);
  assert.equal(c.image, "culture-agents-run:dev");
  assert.deepEqual(c.claudeCode, { providers: ["claude-sub"], model: "haiku" });
  assert.deepEqual(c.opencode, {
    providers: ["lobes"],
    model: "gateway/worker",
    baseUrl: "http://host.openshell.internal:8001/v1",
    keyEnv: "LOBES_GATEWAY_KEY",
    port: 4096,
  });
  assert.equal(c.sandboxPrefix, "ca-");
  assert.equal(c.stub, false);
  assert.equal(c.file, null);
});

test("the environment overrides the file, which overrides the defaults", (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "culture-agents"));
  writeFileSync(
    join(dir, "culture-agents", "harness.json"),
    JSON.stringify({ image: "img:file", opencode: { model: "gw/other", providers: ["p1", "p2"] }, gateway: { tlsDir: "/tls" } }),
  );
  const c = loadHarnessConfig({ XDG_CONFIG_HOME: dir, CULTURE_AGENTS_RUN_IMAGE: "img:env", OPENSHELL_LOCAL_TLS_DIR: "/ignored" });
  assert.equal(c.image, "img:env");
  assert.equal(c.opencode.model, "gw/other");
  assert.deepEqual(c.opencode.providers, ["p1", "p2"]);
  assert.equal(c.gateway.tlsDir, "/tls");
  assert.equal(c.file, join(dir, "culture-agents", "harness.json"));
  assert.deepEqual(loadHarnessConfig({ XDG_CONFIG_HOME: dir, CULTURE_AGENTS_OPENCODE_PROVIDERS: "a, b" }).opencode.providers, ["a", "b"]);
});

test("invalid configuration is refused with a HarnessConfigError", (t) => {
  const dir = scratch(t);
  const bad: Record<string, string>[] = [
    { CULTURE_AGENTS_CLAUDE_MODEL: "gpt" },
    { CULTURE_AGENTS_OPENCODE_PORT: "99999" },
    { CULTURE_AGENTS_OPENCODE_MODEL: "nomodel" },
    { CULTURE_AGENTS_SANDBOX_PREFIX: "Bad_Prefix" },
    { CULTURE_AGENTS_HARNESS_CONFIG: join(dir, "missing.json") },
  ];
  for (const env of bad) assert.throws(() => loadHarnessConfig({ HOME: "/nonexistent", ...env }), HarnessConfigError, JSON.stringify(env));
  writeFileSync(join(dir, "x.json"), "[1]");
  assert.throws(() => loadHarnessConfig({ CULTURE_AGENTS_HARNESS_CONFIG: join(dir, "x.json") }), HarnessConfigError);
});

test("registry shape: ids, absolute driver modules exporting createDriver, JSON options", async () => {
  const config = { ...loadHarnessConfig({ HOME: "/nonexistent" }), stub: true };
  const entries = listHarnesses(config);
  assert.deepEqual(entries.map((e) => e.id), ["claude-code", "opencode", "stub"]);
  assert.deepEqual(listHarnesses({ ...config, stub: false }).map((e) => e.id), ["claude-code", "opencode"]);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["capabilities", "driver", "id"]);
    assert.equal(typeof entry.capabilities, "function");
    assert.ok(entry.driver.module.startsWith("/"), "absolute module path");
    assert.ok(existsSync(entry.driver.module), `${entry.driver.module} exists`);
    assert.deepEqual(JSON.parse(JSON.stringify(entry.driver.options)), entry.driver.options, "options survive JSON");
    const mod = (await import(entry.driver.module)) as { createDriver?: unknown };
    assert.equal(typeof mod.createDriver, "function");
    assert.equal(getHarness(config, entry.id)?.id, entry.id);
  }
  assert.equal(getHarness(config, "codex"), undefined);
  const oc = getHarness(config, "opencode");
  assert.equal((oc?.driver.options["opencode"] as { model: string }).model, "gateway/worker");
  assert.deepEqual((oc?.driver.options["sandbox"] as { providers: string[] }).providers, ["lobes"]);
  assert.ok(!JSON.stringify(entries.map((e) => e.driver.options)).match(/openshell:resolve|sk-|secret/i), "no credential in options");
});

test("capability documents validate against the contract, available or not", async (t) => {
  const dir = scratch(t);
  const tls = join(dir, "tls");
  mkdirSync(join(tls, "client"), { recursive: true });
  for (const f of ["ca.crt", "client/tls.crt", "client/tls.key"]) writeFileSync(join(tls, f), "x");
  const docker = fakeBin(dir, "docker", `echo '{"dev.culture.agents.claude-code":"2.1.319","dev.culture.agents.harness-claude-code":"1.0.196","dev.culture.agents.opencode":"2.3.2"}'`);
  const openshell = fakeBin(dir, "openshell", "exit 0");
  const ok = { ...loadHarnessConfig({ HOME: "/nonexistent" }), stub: true, dockerBin: docker, openshellBin: openshell, gateway: { endpoint: "https://x", tlsDir: tls, name: null } };
  const missing = { ...ok, dockerBin: fakeBin(dir, "nodocker", "echo 'No such image' >&2; exit 1"), openshellBin: fakeBin(dir, "noosh", "echo 'not found' >&2; exit 1") };
  for (const [label, config] of [["available", ok], ["unavailable", missing]] as const) {
    for (const entry of listHarnesses(config)) {
      const doc = await entry.capabilities();
      const result = validate("capabilities", doc);
      assert.ok(result.ok, `${entry.id} (${label}): ${JSON.stringify(result.ok ? null : result.issues)}`);
      assert.equal(doc.harness, entry.id);
      if (entry.id !== "stub") assert.equal(doc.available, label === "available", `${entry.id} availability (${label})`);
      for (const c of ["pause", "resume", "answer", "continue_session", "delegate", "placement", "reconnect", "worktree_isolation"] as const) {
        assert.equal(doc.capabilities[c].supported, false, `${entry.id}: ${c} is deferred`);
      }
    }
  }
  const claude = await getHarness(ok, "claude-code")?.capabilities();
  assert.equal(claude?.version, "2.1.319 (AI SDK adapter 1.0.196)");
  assert.equal((await getHarness(ok, "opencode")?.capabilities())?.version, "2.3.2");
  const down = await getHarness(missing, "opencode")?.capabilities();
  assert.ok(Array.isArray((down?.extension as { unavailable?: string[] }).unavailable), "reasons are reported");
  const list = validate("capabilities#capabilities_list", { harnesses: await Promise.all(listHarnesses(ok).map((e) => e.capabilities())) });
  assert.ok(list.ok);
});

test("every undeclared capability of every harness is refused, typed, and never forwarded", async () => {
  const config = { ...loadHarnessConfig({ HOME: "/nonexistent" }), stub: true, dockerBin: "/bin/false", openshellBin: "/bin/false" };
  for (const entry of listHarnesses(config)) {
    const doc = await entry.capabilities();
    const undeclared = (Object.keys(doc.capabilities) as CapabilityName[]).filter((c) => !doc.capabilities[c].supported);
    assert.ok(undeclared.length >= 8);
    for (const capability of undeclared) {
      const refusal = refusalFor(doc, capability);
      assert.ok(refusal, `${entry.id}: ${capability} refused`);
      assert.equal(refusal.code, "unsupported");
      assert.equal(refusal.capability, capability);
      assert.ok(validate("error#error", refusal).ok, "the refusal is a contract error body");
    }
    for (const capability of Object.keys(doc.capabilities) as CapabilityName[]) {
      if (doc.capabilities[capability].supported) assert.equal(refusalFor(doc, capability), null);
    }
    // A harness that could not steer: the guard refuses before the driver sees anything.
    const noSteer = { ...doc, capabilities: { ...doc.capabilities, steer: { supported: false, reason: "not verified", caveats: [] } } };
    const calls: string[] = [];
    const inner: Driver = {
      start: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      steer: async () => void calls.push("steer"),
      cancel: async () => void calls.push("cancel"),
      dispose: async () => undefined,
    };
    const guarded = guardDriver(inner, noSteer);
    await assert.rejects(guarded.steer("x"), (err: unknown) => err instanceof UnsupportedCapabilityError && err.capability === "steer");
    await assert.rejects(guarded.control("pause"), (err: unknown) => err instanceof UnsupportedCapabilityError && err.capability === "pause");
    await guarded.cancel("ok");
    assert.deepEqual(calls, ["cancel"], `${entry.id}: only the supported action was forwarded`);
  }
});
