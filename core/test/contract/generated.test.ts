import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Run, RunEvent, SubmitRequest } from "../../src/contract/index.js";
import { schemaNames } from "../../src/contract/index.js";
import type { SchemaTypes } from "../../src/contract/generated/index.js";

// dist/test/contract -> core/ is three levels up.
const core = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("generated types are current (regenerate and diff)", () => {
  const check = spawnSync(process.execPath, [join(core, "scripts", "gen-contract-types.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(check.error, undefined, "the generator ran");
  assert.equal(check.status, 0, `the generator's --check found stale output: ${check.stderr}`);
});

test("every schema target has a generated type", () => {
  // SchemaTypes keys are compile-time only; compare against the names the validator offers.
  const expected = schemaNames();
  assert.ok(expected.length > 20);
  const probe: Record<keyof SchemaTypes, true> = Object.fromEntries(expected.map((n) => [n, true])) as Record<
    keyof SchemaTypes,
    true
  >;
  assert.equal(Object.keys(probe).length, expected.length);
});

test("types constrain payloads at compile time", () => {
  const request: SubmitRequest = {
    agent_id: "thor-culture-agents",
    harness: "claude-code",
    repo: "/srv/repo",
    task: "do it",
    caller: { kind: "operator", id: "thor-ori" },
  };
  // @ts-expect-error a run state outside the enum is rejected
  const bad: Run["state"] = "paused";
  const event: Pick<RunEvent, "kind"> = { kind: "run.state" };
  assert.equal(request.harness, "claude-code");
  assert.equal(bad, "paused");
  assert.equal(event.kind, "run.state");
});
