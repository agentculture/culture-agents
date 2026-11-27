import assert from "node:assert/strict";
import { test } from "node:test";

import type { SchemaTypes } from "../../src/contract/generated/index.js";
import type { Agent, RunResult } from "../../src/contract/index.js";

// Type-level assertions: this file fails `tsc` if a generated entity type collapses to `never`
// or rejects a valid payload shape.

/** Keys of SchemaTypes whose generated type is `never`. Must be empty. */
type Collapsed = { [K in keyof SchemaTypes]: [SchemaTypes[K]] extends [never] ? K : never }[keyof SchemaTypes];
const noneCollapsed: [Collapsed] extends [never] ? true : false = true;

test("no generated schema type collapses to never", () => {
  assert.equal(noneCollapsed, true);
});

test("Agent accepts every valid state, including the unconstrained one", () => {
  const base = {
    id: "thor-culture-agents",
    node: "thor",
    suffix: "culture-agents",
    harnesses: ["claude-code"],
    repos: ["/srv/repo"],
  } as const;
  const idle: Agent = { ...base, harnesses: ["claude-code"], repos: ["/srv/repo"], state: "idle", active_run_ids: [] };
  const running: Agent = {
    ...base,
    harnesses: ["claude-code"],
    repos: ["/srv/repo"],
    state: "running",
    active_run_ids: ["thor-culture-agents.run.01JABCDEFGHJKMNPQRSTVWXYZ0"],
  };
  const unavailable: Agent = { ...base, harnesses: ["claude-code"], repos: ["/srv/repo"], state: "unavailable", active_run_ids: [] };
  assert.deepEqual([idle.state, running.state, unavailable.state], ["idle", "running", "unavailable"]);
});

test("RunResult accepts every terminal state", () => {
  const common = { run_id: "thor-culture-agents.run.01JABCDEFGHJKMNPQRSTVWXYZ0", summary: null, branch: null, commits: [], ended_at: "2026-01-01T00:00:00Z" };
  const ok: RunResult = { ...common, state: "succeeded", error: null };
  const failed: RunResult = { ...common, state: "failed", error: { code: "internal", message: "x", retryable: false } };
  const cancelled: RunResult = { ...common, state: "cancelled", error: null };
  const timedOut: RunResult = { ...common, state: "timed_out", error: null };
  const unanswered: RunResult = { ...common, state: "unanswered", error: null };
  const unknown: RunResult = { ...common, state: "unknown", error: null };
  assert.equal([ok, failed, cancelled, timedOut, unanswered, unknown].length, 6);
});
