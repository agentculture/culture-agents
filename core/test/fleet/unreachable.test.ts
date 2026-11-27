// t25 in-process: the unreachable view (contract 3.3). A run on a member that stops answering reads
// `unreachable` to the caller on every read and never `succeeded` or any state; the caller writes
// nothing, to disk or to the member; the same view shows the true state once the member answers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { validate, type RunView } from "../../src/contract/index.js";
import { call } from "../daemon/harness.js";
import { eventsOf, pair, submitBody, type Core } from "./remote-support.js";

/** Every file under `dir` with a digest of its content, so any write shows. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue; // a socket or a file gone since the listing
      }
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) out[path] = `${st.size}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  };
  walk(dir);
  return out;
}

async function view(caller: Core, runId: string): Promise<RunView> {
  const reply = await call(caller.env.socket, "GET", `/v1/fleet/runs/${runId}/view`);
  assert.equal(reply.status, 200, reply.text);
  assert.ok(validate("reachability", reply.json).ok, reply.text);
  return reply.json as RunView;
}

async function submitted(caller: Core): Promise<string> {
  const reply = await call(caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody() });
  assert.equal(reply.status, 201, reply.text);
  return (reply.json as { run: { id: string } }).run.id;
}

test("a member that stops answering reads unreachable on every read, none succeeds, and the caller writes nothing", async () => {
  const { exec, caller } = await pair();
  try {
    const id = await submitted(caller);
    const before = await view(caller, id);
    assert.equal(before.view, "reachable");
    assert.equal(before.run?.state, "queued", "the member's own answer while it answers");

    const callerBefore = tree(caller.env.root);
    await exec.fleet.stop(); // the member stops answering: its transport is gone, the caller still lists it
    await exec.daemon.stop();
    const execBefore = tree(exec.env.root); // after its own shutdown writes: the caller's reads are what is measured
    const reads = [await view(caller, id), await view(caller, id), await view(caller, id)];
    assert.deepEqual(reads.map((r) => r.view), ["unreachable", "unreachable", "unreachable"]);
    assert.equal(reads.filter((r) => r.run !== undefined).length, 0, "0 reads succeeded");
    assert.equal(reads[0]?.unreachable?.reason, "no_answer");
    assert.equal(JSON.stringify(reads).includes("succeeded"), false);
    assert.deepEqual(tree(caller.env.root), callerBefore, "the caller wrote nothing");
    assert.deepEqual(tree(exec.env.root), execBefore, "and nothing reached the member's directory");
    // The ordinary read of the same run still fails as it did: the view adds a route, changes none.
    const plain = await call(caller.env.socket, "GET", `/v1/fleet/runs/${id}`);
    assert.equal(plain.status, 503, plain.text);
  } finally {
    await caller.stop();
    await exec.stop().catch(() => undefined);
  }
});

test("a trusted member that is not listed (silent past the limit) reads unreachable; a name the trust list lacks does not", async () => {
  const { exec, caller } = await pair();
  try {
    const id = await submitted(caller);
    // Its transport goes; the caller's list still has it for the silence limit, so the call fails.
    await exec.fleet.stop();
    const gone = await view(caller, id);
    assert.equal(gone.view, "unreachable");
    const stranger = id.replace(/^thor-/, "zzzzzzzz-");
    const reply = await call(caller.env.socket, "GET", `/v1/fleet/runs/${stranger}/view`);
    assert.equal(reply.status, 503, "not a trusted member: unavailable, not a view");
  } finally {
    await caller.stop();
    await exec.stop().catch(() => undefined);
  }
});

test("a run shown unreachable shows its true terminal state once its host answers again", async () => {
  const { exec, caller } = await pair();
  try {
    const id = await submitted(caller);
    assert.equal((await view(caller, id)).view, "reachable");
    // The caller's route to the member is cut (its address list is emptied), the run ends on the member meanwhile.
    caller.announceTo();
    await caller.fleet.stop();
    await caller.fleet.start();
    for (const e of eventsOf("steered-then-succeeded.jsonl", id).slice(1)) exec.service.append(e);
    const cut = await view(caller, id);
    assert.equal(cut.view, "unreachable");
    assert.equal(cut.run, undefined);
    caller.announceTo(exec); // healed
    await caller.fleet.announce();
    const healed = await view(caller, id);
    assert.equal(healed.view, "reachable");
    assert.equal(healed.run?.state, "succeeded", "the run's true terminal state, which the member holds");
    assert.equal(healed.run?.terminal, true);
  } finally {
    await caller.stop();
    await exec.stop();
  }
});

test("a halted member leaves the list after the silence limit and its runs read unreachable (not_listed), within 16 s of its last announcement", async () => {
  let t = 0;
  const { exec, caller } = await pair({ callerOptions: { timing: { now: () => t, silenceMs: 15_000 } } });
  try {
    const id = await submitted(caller);
    assert.equal((await view(caller, id)).view, "reachable");
    t = 15_001; // the member's last announcement was 15.001 s ago on the caller's clock; the sweep limit is 15 s, a read is never past it
    const silent = await view(caller, id);
    assert.equal(silent.view, "unreachable");
    assert.equal(silent.unreachable?.reason, "not_listed");
    assert.equal(silent.run, undefined);
  } finally {
    await caller.stop();
    await exec.stop();
  }
});
