import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ContractValidationError,
  apiVersion,
  assertValid,
  buildActionId,
  buildMeshId,
  buildRunId,
  buildSessionId,
  canTransition,
  errorCodes,
  exitCodeFor,
  httpStatusFor,
  isActionId,
  isActive,
  isCompatible,
  isRunId,
  isSessionId,
  isTerminal,
  newUlid,
  parseMeshId,
  parseScopedId,
  retryableFor,
  runBranch,
  runStates,
  validate,
  type ErrorCode,
  type RunState,
} from "../../src/contract/index.js";

const repoContract = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contract");
const ULID = "01J9ZB5Q8XG7C3M2N4P6R8T0VW";

test("apiVersion is read from api.json", () => {
  const api = JSON.parse(readFileSync(join(repoContract, "api.json"), "utf8")) as { api_version: string };
  assert.equal(apiVersion, api.api_version);
  assert.match(apiVersion, /^\d+\.\d+$/);
});

// --- versioning: compatible exactly when C == S and y >= x ---------------------------

test("compatibility: same major, core minor >= client minor", () => {
  assert.equal(isCompatible("1.0", "1.0"), true);
  assert.equal(isCompatible("1.0", "1.3"), true);
  assert.equal(isCompatible("1.3", "1.3"), true);
  assert.equal(isCompatible("1.3", "1.0"), false);
  assert.equal(isCompatible("1.0", "2.0"), false);
  assert.equal(isCompatible("2.0", "1.9"), false);
  assert.equal(isCompatible("1.9", "1.10"), true, "minor compares numerically, not as text");
  assert.equal(isCompatible("1.10", "1.9"), false);
});

test("compatibility: unparseable versions are never compatible", () => {
  for (const bad of ["", "1", "1.0.0", "v1.0", "a.b"]) {
    assert.equal(isCompatible(bad, "1.0"), false, bad);
    assert.equal(isCompatible("1.0", bad), false, bad);
  }
});

// --- run state machine (README table) -------------------------------------------------

const TABLE: Record<string, RunState[]> = {
  queued: ["running", "cancelling", "failed", "unknown"],
  running: ["cancelling", "succeeded", "failed", "unknown"],
  cancelling: ["cancelled", "timed_out", "unanswered", "succeeded", "failed", "unknown"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  unanswered: [],
  unknown: [],
};

test("state machine allows exactly the README transitions", () => {
  assert.deepEqual([...runStates].sort(), Object.keys(TABLE).sort());
  for (const from of runStates) {
    for (const to of runStates) {
      assert.equal(canTransition(from, to), (TABLE[from] ?? []).includes(to), `${from} -> ${to}`);
    }
  }
});

test("the first state is queued and nothing else", () => {
  for (const to of runStates) assert.equal(canTransition(null, to), to === "queued", String(to));
});

test("terminal and active states", () => {
  const terminal: RunState[] = ["succeeded", "failed", "cancelled", "timed_out", "unanswered", "unknown"];
  const active: RunState[] = ["queued", "running", "cancelling"];
  for (const s of terminal) {
    assert.equal(isTerminal(s), true, s);
    assert.equal(isActive(s), false, s);
  }
  for (const s of active) {
    assert.equal(isTerminal(s), false, s);
    assert.equal(isActive(s), true, s);
  }
});

test("cancelled, timed_out and unanswered are reachable only through cancelling", () => {
  for (const from of runStates) {
    for (const to of ["cancelled", "timed_out", "unanswered"] as const) {
      assert.equal(canTransition(from, to), from === "cancelling", `${from} -> ${to}`);
    }
  }
});

// --- ids ------------------------------------------------------------------------------

test("mesh ids split at the first hyphen", () => {
  assert.deepEqual(parseMeshId("thor-culture-agents"), { node: "thor", agent: "culture-agents" });
  assert.equal(buildMeshId("thor", "culture-agents"), "thor-culture-agents");
  assert.equal(parseMeshId("nohyphen"), null);
  assert.equal(parseMeshId("-agent"), null);
  assert.equal(parseMeshId("Thor-agent"), null);
  assert.equal(parseMeshId("sp_ark-agent"), null, "node has no underscore or hyphen");
  assert.throws(() => buildMeshId("sp-ark", "a"), RangeError);
  assert.throws(() => buildMeshId("thor", "Bad"), RangeError);
});

test("run, session and action ids use the executing agent's mesh id", () => {
  const agent = "thor-culture-agents";
  assert.equal(buildRunId(agent, ULID), `${agent}.run.${ULID}`);
  assert.equal(buildSessionId(agent, ULID), `${agent}.ses.${ULID}`);
  assert.equal(buildActionId(agent, ULID), `${agent}.act.${ULID}`);
  const parsed = parseScopedId(buildRunId(agent, ULID));
  assert.deepEqual(parsed, { kind: "run", agentId: agent, node: "thor", agent: "culture-agents", ulid: ULID });
  assert.equal(isRunId(`${agent}.run.${ULID}`), true);
  assert.equal(isRunId(`${agent}.ses.${ULID}`), false);
  assert.equal(isSessionId(`${agent}.ses.${ULID}`), true);
  assert.equal(isActionId(`${agent}.act.${ULID}`), true);
  assert.equal(parseScopedId(`${agent}.run.not-a-ulid`), null);
  assert.equal(parseScopedId(`${agent}.job.${ULID}`), null);
  assert.equal(parseScopedId(`bad.run.${ULID}`), null);
  assert.throws(() => buildRunId("nohyphen", ULID), RangeError);
  assert.throws(() => buildRunId(agent, "short"), RangeError);
});

test("built ids validate against the schemas", () => {
  const agent = "thor-culture-agents";
  assert.ok(validate("common#run_id", buildRunId(agent, ULID)).ok);
  assert.ok(validate("common#session_id", buildSessionId(agent, ULID)).ok);
  assert.ok(validate("common#action_id", buildActionId(agent, ULID)).ok);
  assert.ok(validate("common#mesh_id", agent).ok);
  assert.equal(validate("common#run_id", `${agent}.run.${"I".repeat(26)}`).ok, false, "Crockford excludes I");
});

test("the id helpers and the schemas agree on the length bounds: node 32, mesh id 96", () => {
  const longest = `${"n".repeat(32)}-${"a".repeat(63)}`; // 96 characters
  const cases: [id: string, ok: boolean][] = [
    [longest, true],
    [`${"n".repeat(33)}-culture-agents`, false], // node of 33
    [`thor-${"a".repeat(92)}`, false], // 97 characters
  ];
  for (const [mesh, ok] of cases) {
    assert.equal(parseMeshId(mesh) !== null, ok, `parseMeshId ${mesh}`);
    assert.equal(validate("common#mesh_id", mesh).ok, ok, `mesh_id ${mesh}`);
    assert.equal(isRunId(`${mesh}.run.${ULID}`), ok);
    assert.equal(validate("common#run_id", `${mesh}.run.${ULID}`).ok, ok, `run_id ${mesh}`);
    assert.equal(isSessionId(`${mesh}.ses.${ULID}`), ok);
    assert.equal(validate("common#session_id", `${mesh}.ses.${ULID}`).ok, ok, `session_id ${mesh}`);
    assert.equal(isActionId(`${mesh}.act.${ULID}`), ok);
    assert.equal(validate("common#action_id", `${mesh}.act.${ULID}`).ok, ok, `action_id ${mesh}`);
  }
  assert.ok(validate("common#run_id", buildRunId(longest, ULID)).ok);
});

test("a run's host branch is runs/<run_id>", () => {
  const id = buildRunId("thor-culture-agents", ULID);
  assert.equal(runBranch(id), `runs/${id}`);
});

test("newUlid produces valid, time-ordered, distinct ULIDs", () => {
  const a = newUlid(1_700_000_000_000);
  const b = newUlid(1_700_000_000_001);
  assert.ok(validate("common#ulid", a).ok);
  assert.ok(a.slice(0, 10) < b.slice(0, 10));
  assert.notEqual(newUlid(1_700_000_000_000), a);
  assert.throws(() => newUlid(-1), RangeError);
  assert.ok(validate("common#ulid", newUlid()).ok);
});

// --- errors (README table) ------------------------------------------------------------

const ERRORS: Record<ErrorCode, [number, number, boolean | null]> = {
  invalid: [400, 1, false],
  denied: [403, 1, false],
  not_found: [404, 1, false],
  busy: [409, 1, true],
  conflict: [409, 1, null],
  limit_reached: [429, 1, true],
  unsupported: [422, 1, false],
  incompatible_version: [412, 2, false],
  unavailable: [503, 2, true],
  internal: [500, 2, false],
};

test("error table: HTTP status, exit code and retryability per code", () => {
  assert.deepEqual([...errorCodes].sort(), Object.keys(ERRORS).sort());
  for (const [code, [http, exit, retryable]] of Object.entries(ERRORS) as [ErrorCode, [number, number, boolean | null]][]) {
    assert.equal(httpStatusFor(code), http, code);
    assert.equal(exitCodeFor(code), exit, code);
    assert.equal(retryableFor(code), retryable, code);
  }
});

// --- validation errors ----------------------------------------------------------------

test("assertValid throws a typed error with code invalid and the failing path", () => {
  assert.throws(
    () => assertValid("error", { error: { code: "denied", message: "x", retryable: false, extra: 1 } }),
    (err: unknown) => {
      assert.ok(err instanceof ContractValidationError);
      assert.equal(err.code, "invalid");
      assert.equal(err.path, "/error/extra");
      assert.ok(err.issues.length > 0);
      return true;
    },
  );
});

test("a missing required property is reported at that property, and toBody is a valid error body", () => {
  try {
    assertValid("version", { api_version: "1.0", node: "thor" });
    assert.fail("expected a throw");
  } catch (err) {
    assert.ok(err instanceof ContractValidationError);
    assert.equal(err.path, "/core_version");
    const body = { error: err.toBody() };
    assert.equal(body.error.field, "/core_version");
    assert.ok(validate("error", body).ok);
  }
});

test("assertValid returns the value when valid", () => {
  const v = { api_version: "1.0", core_version: "0.0.0", node: "thor" };
  assert.deepEqual(assertValid("version", v), v);
});
