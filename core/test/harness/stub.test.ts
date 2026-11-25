/**
 * The stub harness passes the same contract suite as the real harnesses, and its import graph
 * reaches no AI SDK, OpenShell or other vendor package (only `node:` built-ins and core files).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadHarnessConfig, getHarness, type GuardedDriver } from "../../src/harness/index.js";
import { createDriver } from "../../src/harness/stub/index.js";
import { defineContractSuite } from "./contract-suite.js";

const config = { ...loadHarnessConfig({ HOME: "/nonexistent" }), stub: true };

defineContractSuite({
  harness: "stub",
  skip: async () => null,
  createDriver: async (run) => {
    const entry = getHarness(config, "stub");
    assert.ok(entry);
    return createDriver({ run, runDir: run.repo, options: { ...entry.driver.options, stepMs: 120 } }) as GuardedDriver;
  },
  submit: { task: "Write one file.\nfiles: hello.txt", expectFiles: ["hello.txt"] },
  steer: {
    task: "files: f1.txt, f2.txt, f3.txt, f4.txt, f5.txt, f6.txt, f7.txt, f8.txt",
    afterToolResults: 2,
    message: "Change of plan. files: STEERED.txt",
    expectFiles: ["f1.txt", "f2.txt", "STEERED.txt"],
    forbidFiles: ["f8.txt"],
  },
  cancel: { task: "hang\nfiles: never.txt", afterToolCalls: 0, delayMs: 50 },
  trials: 1,
  timeoutMs: 30_000,
});

/** Every module reachable from `entry` by relative import, with the bare specifiers it imports. */
function importGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = (m[1] ?? m[2]) as string;
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  };
  visit(entry);
  return { files, bare };
}

test("the stub driver module imports no AI SDK, OpenShell or vendor package", () => {
  const entry = fileURLToPath(new URL("../../src/harness/stub/index.js", import.meta.url));
  const { files, bare } = importGraph(entry);
  assert.ok(files.size > 3, "the graph was walked");
  const vendor = [...bare].filter((s) => !s.startsWith("node:"));
  assert.deepEqual(vendor, [], `non-built-in imports reachable from the stub: ${vendor.join(", ")}`);
});

test("the registry module loads no driver and no vendor package", () => {
  const entry = fileURLToPath(new URL("../../src/harness/index.js", import.meta.url));
  const { bare } = importGraph(entry);
  const vendor = [...bare].filter((s) => !s.startsWith("node:"));
  // The contract module validates with ajv; no harness runtime is reachable.
  assert.deepEqual(vendor.filter((s) => s !== "ajv/dist/2020.js"), [], `vendor imports reachable from the registry: ${vendor.join(", ")}`);
});
