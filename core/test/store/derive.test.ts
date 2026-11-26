import assert from "node:assert/strict";
import { test } from "node:test";

import { runStates, isTerminal, validate, type RunEvent, type RunState } from "../../src/contract/index.js";
import { deriveRun } from "../../src/store/derive.js";
import { newRun } from "../worker/helpers.js";

const NOW = "2026-11-25T12:00:00.000Z";

function stateEvent(runId: string, cursor: number, from: RunState | null, to: RunState): RunEvent {
  return { run_id: runId, cursor, time: `2026-11-25T10:00:0${cursor}Z`, kind: "run.state", data: { from, to, reason: null } };
}

const PATHS: Record<RunState, RunState[]> = {
  queued: ["queued"],
  running: ["queued", "running"],
  cancelling: ["queued", "running", "cancelling"],
  succeeded: ["queued", "running", "succeeded"],
  failed: ["queued", "running", "failed"],
  cancelled: ["queued", "running", "cancelling", "cancelled"],
  timed_out: ["queued", "running", "cancelling", "timed_out"],
  unanswered: ["queued", "running", "cancelling", "unanswered"],
  unknown: ["queued", "running", "unknown"],
};

/** A legal log ending in `final`. */
function logTo(runId: string, final: RunState): RunEvent[] {
  let from: RunState | null = null;
  return PATHS[final].map((to, i) => {
    const event = stateEvent(runId, i + 1, from, to);
    from = to;
    return event;
  });
}

test("a terminal event in the log is reported as that state, whether or not a worker is alive", () => {
  const record = newRun();
  for (const final of runStates.filter(isTerminal)) {
    for (const alive of [true, false]) {
      const derived = deriveRun({ record, events: logTo(record.id, final), alive, controllable: true, now: NOW });
      assert.ok(derived);
      assert.equal(derived.run.state, final);
      assert.equal(derived.orphaned, false);
      assert.equal(derived.run.terminal, true);
      assert.equal(derived.run.live_control, false);
      assert.ok(validate("run", derived.run).ok);
    }
  }
});

test("no terminal event and a live worker: the last recorded state", () => {
  const record = newRun();
  for (const last of ["queued", "running", "cancelling"] as RunState[]) {
    const derived = deriveRun({ record, events: logTo(record.id, last), alive: true, controllable: true, now: NOW });
    assert.equal(derived?.run.state, last);
    assert.equal(derived?.orphaned, false);
    assert.equal(derived?.run.live_control, true);
    const restarted = deriveRun({ record, events: logTo(record.id, last), alive: true, controllable: false, now: NOW });
    assert.equal(restarted?.run.live_control, false, "after a core restart live control is unavailable");
  }
});

test("no terminal event and no live worker: unknown, never succeeded", () => {
  const record = newRun();
  for (const last of ["queued", "running", "cancelling"] as RunState[]) {
    const derived = deriveRun({ record, events: logTo(record.id, last), alive: false, controllable: true, now: NOW, goneReason: "gone" });
    assert.ok(derived);
    assert.equal(derived.run.state, "unknown");
    assert.notEqual(derived.run.state, "succeeded");
    assert.equal(derived.orphaned, true);
    assert.equal(derived.run.terminal, true);
    assert.equal(derived.run.live_control, false);
    assert.equal(derived.run.ended_at, NOW);
    assert.match(derived.run.state_reason ?? "", /without a terminal event \(gone\)/);
    assert.ok(validate("run", derived.run).ok);
  }
});

test("state fields come from the log, not from the stored record", () => {
  const record = newRun({ state: "queued" });
  const events = logTo(record.id, "running");
  const derived = deriveRun({ record, events, alive: true, controllable: true, now: NOW });
  assert.equal(derived?.run.cursor, 2);
  assert.equal(derived?.run.started_at, events[1]?.time);
  assert.equal(derived?.run.updated_at, events[1]?.time);
});

test("a run with no event at all is not established", () => {
  assert.equal(deriveRun({ record: newRun(), events: [], alive: false, controllable: false, now: NOW }), null);
  assert.equal(deriveRun({ record: newRun(), events: [], alive: true, controllable: true, now: NOW }), null);
});
