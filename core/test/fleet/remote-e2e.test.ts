// t23 acceptance 1 with two real cores: each is the real `main` in its own process (test/runs/child.ts)
// with the fleet transport on, the real run store and real worker processes (the fake driver). The
// executing core is thor; the calling core is CALLER_NODE, length-boundary filler that names no host
// (two members never share a node name, c40). The caller's operator submits on its own control
// socket, attaches, steers and cancels; thor records the member as the run's submitter.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RemoteSubmitResponse, Run, RunEvent } from "../../src/contract/index.js";
import { call } from "../daemon/harness.js";
import { events, HANG, ok, waitFor, waitRun } from "../runs/support.js";
import { CALLER_NODE, sseEvents, submitBody } from "./remote-support.js";
import { twoCores } from "./two-cores.js";

const CALLER = { kind: "operator", id: `${CALLER_NODE}-operator` } as const;

test("two real cores: a submit from the caller runs on thor and is attached, steered and cancelled from the caller", async (t) => {
  const { thor, caller } = await twoCores(t);
  const body = { ...submitBody({ harness: HANG.id, deadline_ms: 600_000 }), caller: CALLER };
  const reply = await call(caller.socket, "POST", "/v1/fleet/runs", { body });
  assert.equal(reply.status, 201, reply.text);
  const { run } = reply.json as RemoteSubmitResponse;
  const { key, ...named } = run.submitter ?? {};
  assert.deepEqual(named, { kind: "member", node: CALLER_NODE });
  assert.match(String(key), /^[0-9a-f]{64}$/, "the key the member authenticated with");

  // thor's own view: a real run in its store, on the aliased checkout, submitted by the member.
  const onThor = await ok<Run>(thor, "GET", `/v1/runs/${run.id}`, 200, "run");
  assert.equal(onThor.repo, thor.repoA);
  assert.deepEqual(onThor.submitter, run.submitter);
  assert.equal(onThor.base_commit, run.base_commit, "the commit returned to the caller is the one thor recorded");
  await waitRun(thor, run.id, (r) => r.state === "running", "the run to start on thor");

  const attached = call(caller.socket, "GET", `/v1/fleet/runs/${run.id}/attach?after=0`);
  const steer = await call(caller.socket, "POST", `/v1/fleet/runs/${run.id}/steer`, { body: { caller: CALLER, message: "Also cover the null case.", idempotency_key: "steer-1" } });
  assert.equal(steer.status, 202, steer.text);
  const seen = async (): Promise<boolean> => (await events(thor, run.id)).some((e) => e.kind === "run.control");
  await waitFor(seen, 8000, "thor to record the steer");
  const cancel = await call(caller.socket, "POST", `/v1/fleet/runs/${run.id}/cancel`, { body: { caller: CALLER, reason: "enough" } });
  assert.equal(cancel.status, 202, cancel.text);

  const stream = await attached;
  assert.equal(stream.status, 200, stream.text);
  const got: RunEvent[] = sseEvents(stream.text);
  assert.deepEqual(got.map((e) => e.cursor), got.map((_, i) => i + 1), "every event once, in cursor order");
  assert.ok(got.some((e) => e.kind === "run.output"), "the run's output reached the caller");
  assert.ok(got.some((e) => e.kind === "run.control"), "the steer is in the log the caller read");
  assert.deepEqual(got.at(-1)?.data, { ...(got.at(-1)?.data as object), to: "cancelled" }, "the stream ends with the terminal state");
  const final = await waitRun(thor, run.id, (r) => r.terminal, "the run to end on thor");
  assert.equal(final.state, "cancelled");
  const shown = await call(caller.socket, "GET", `/v1/fleet/runs/${run.id}`);
  assert.equal((shown.json as { state: string }).state, "cancelled");
  assert.equal(shown.text.includes(thor.repoA), false, "the caller never sees thor's path");
});
