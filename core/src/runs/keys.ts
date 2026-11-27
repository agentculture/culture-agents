/**
 * Idempotency on the run service's routes (contract/README.md: idempotency keys), over the on-disk
 * key index (store/idempotency.ts). A key is looked up after the capability checks and before
 * the limit check of a submit, and before the capability check of a steer or cancel:
 *
 * - no entry: the request proceeds and its key is written before anything else happens;
 * - an entry whose effect is not established yet: settled from the store first (released, so the
 *   request proceeds; still pending, so `unavailable` with `retry_after_ms`);
 * - the same digest: the first run (as it is now) or the first action, with `replayed: true`;
 * - another digest: `conflict`, not retryable, with `idempotency_key` and the key's `run_id`.
 */
import type { AcceptedResponse, Run, SubmitResponse } from "../contract/index.js";
import { ControlError } from "../daemon/errors.js";
import { settleKey, type KeyEntry, type KeyIndex, type KeyScope } from "../store/idempotency.js";

/** The fault injection points of a submit, in on-disk order. */
export type SubmitStep = "after-key" | "after-run-dir" | "after-spawn";

/** Called at each step of a submit; a test kills the core there. Never set in production. */
export type SubmitFault = (step: SubmitStep) => void;

function conflict(entry: KeyEntry): ControlError {
  return new ControlError("conflict", `Idempotency key ${entry.key} was already used with a different ${entry.scope} request (run ${entry.run_id}).`, {
    run_id: entry.run_id,
    idempotency_key: entry.key,
    retryable: false,
  });
}

function pending(entry: KeyEntry): ControlError {
  return new ControlError("unavailable", `The ${entry.scope} with idempotency key ${entry.key} is still being established; retry shortly.`, {
    run_id: entry.run_id,
    retry_after_ms: 500,
  });
}

/** The established entry for a key, or null when it is unused or was released. */
function lookup(index: KeyIndex, scope: KeyScope, key: string, digest: string): KeyEntry | null {
  const found = index.get(scope, key);
  if (found === null) return null;
  const { settlement, entry } = settleKey(index, found);
  if (settlement === "released") return null;
  if (entry.digest !== digest) throw conflict(entry);
  if (settlement === "pending") throw pending(entry);
  return entry;
}

/** A repeated submit: the first run as it is now, or null when the key is free. */
export function replaySubmit(index: KeyIndex, key: string, digest: string, read: (runId: string) => Run | null): SubmitResponse | null {
  const entry = lookup(index, "submit", key, digest);
  if (entry === null) return null;
  const run = read(entry.run_id);
  if (run === null) {
    // The run left the store (it was never established after all, or it was removed): the key is free.
    index.release("submit", key);
    return null;
  }
  return { run, replayed: true };
}

/** A repeated steer or cancel: the first action record, or null when the key is free. */
export function replayAction(index: KeyIndex, scope: "steer" | "cancel", key: string, digest: string): AcceptedResponse | null {
  const entry = lookup(index, scope, key, digest);
  if (!entry?.action) return null;
  return { action: { ...entry.action, outcome: "accepted" }, replayed: true };
}
