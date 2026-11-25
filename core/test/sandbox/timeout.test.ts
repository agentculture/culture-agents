import assert from "node:assert/strict";
import { test } from "node:test";

import { SandboxTimeoutError, withTimeout } from "../../src/sandbox/timeout.js";

test("withTimeout returns the result of a call that finishes in time", async () => {
  assert.equal(await withTimeout("quick", 1000, async () => 7), 7);
});

test("withTimeout releases the caller even when the call ignores its signal, and aborts the signal", async () => {
  let seen: AbortSignal | undefined;
  const never = (signal: AbortSignal) => ((seen = signal), new Promise<number>(() => undefined));
  const began = Date.now();
  await assert.rejects(withTimeout("committing", 60, never), (e: unknown) => e instanceof SandboxTimeoutError && /committing did not finish within/.test(e.message));
  assert.ok(Date.now() - began < 1000);
  assert.equal(seen?.aborted, true);
});

test("withTimeout passes a failure through", async () => {
  await assert.rejects(withTimeout("failing", 1000, async () => Promise.reject(new Error("boom"))), /boom/);
});
