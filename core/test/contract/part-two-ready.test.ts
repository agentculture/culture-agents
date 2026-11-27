/**
 * Plan task t30: contract 3.0 carries what D2 part two needs, so part two adds behaviour without a
 * MAJOR bump. `placement` may be reported supported (no harness of this core does yet), and
 * `admission_held` refuses a submit that an admission signal holds (no route returns it yet). Both
 * are (planned, part two) in contract/README.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  errorCodes,
  exitCodeFor,
  httpStatusFor,
  retryableFor,
  validate,
  type Capabilities,
  type ErrorBody,
  type HeldSignal,
} from "../../src/contract/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contract", "fixtures");
const read = (path: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${path}.json`), "utf8"));

test("a capability report may state placement as supported with a caveat", () => {
  const result = validate("capabilities", read("valid/capabilities/root.placement-supported-with-caveat"));
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.issues));
  const placement = (result.value as Capabilities).capabilities.placement;
  assert.deepEqual([placement.supported, placement.reason], [true, null]);
  assert.ok(placement.caveats.length > 0);
  const bare = validate("capabilities", read("invalid/capabilities/root.type-placement-unsupported-without-reason"));
  assert.equal(bare.ok, false, "unsupported placement still needs a reason");
});

test("admission_held is a retryable 429 with exit 1", () => {
  assert.ok(errorCodes.includes("admission_held"));
  assert.deepEqual([httpStatusFor("admission_held"), exitCodeFor("admission_held"), retryableFor("admission_held")], [429, 1, true]);
});

test("a held submit names the signal, its state and the time it was observed", () => {
  for (const [name, signal] of [
    ["root.admission-held-heat", { name: "heat", state: "hold", observed_at: "2026-11-27T09:14:05Z" }],
    ["root.admission-held-gateway-unknown", { name: "gateway", state: "unknown", observed_at: null }],
  ] as const) {
    const result = validate("error", read(`valid/error/${name}`));
    assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.issues));
    const error = (result.value as { error: ErrorBody }).error;
    const held: HeldSignal | undefined = error.signal;
    assert.deepEqual([error.code, error.retryable, held], ["admission_held", true, signal]);
  }
});

test("a held refusal without its signal, not retryable, or with a signal elsewhere is rejected", () => {
  for (const name of [
    "root.required-admission-held-without-signal",
    "root.const-admission-held-not-retryable",
    "root.enum-held-signal-name-unknown",
    "root.enum-held-signal-state-admit",
    "root.required-held-signal-without-observed-at",
    "root.not-signal-on-limit-reached",
  ]) {
    assert.equal(validate("error", read(`invalid/error/${name}`)).ok, false, name);
  }
});
