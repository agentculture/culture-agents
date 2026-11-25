/**
 * Waits on the gateway are bounded: deleting a sandbox has one overall deadline however many
 * attempts it takes, and an abort that arrives while a process is being started still stops it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { ExecRequest, InteractiveControl } from "../../src/sandbox/openshell-client.js";
import { createRunSandboxes, DELETE_DEADLINE_MS } from "../../src/sandbox/run-sandboxes.js";
import { SandboxCleanupError } from "../../src/sandbox/types.js";
import { FakeOpenShell, TEST_POLICY, must } from "./fake-openshell.js";

const never = <T>() => new Promise<T>(() => undefined);

class SlowGateway extends FakeOpenShell {
  hangDelete = false;
  hangWaitDeleted = false;
  /** Resolves the pending execInteractive. */
  releaseInteractive: (() => void) | null = null;
  holdInteractive = false;
  waitDeletedSecs: number[] = [];

  override async delete(name: string, options?: { allowMissing?: boolean }): Promise<unknown> {
    if (this.hangDelete) {
      this.calls.push({ op: "delete", name });
      return never();
    }
    return super.delete(name, options);
  }

  override async waitDeleted(name: string, timeoutSecs?: number): Promise<void> {
    this.waitDeletedSecs.push(timeoutSecs ?? -1);
    if (this.hangWaitDeleted) {
      this.calls.push({ op: "waitDeleted", name });
      return never();
    }
    return super.waitDeleted(name);
  }

  override async execInteractive(name: string, command: string[], opts?: ExecRequest): Promise<InteractiveControl> {
    if (this.holdInteractive) await new Promise<void>((resolve) => (this.releaseInteractive = resolve));
    return super.execInteractive(name, command, opts);
  }
}

function setup(deleteDeadlineMs: number) {
  const fake = new SlowGateway();
  const sandboxes = createRunSandboxes({ image: "img:1", prefix: "t-", deleteDeadlineMs }, { client: fake, policy: TEST_POLICY, sleep: async () => undefined });
  return { fake, sandboxes };
}

test("the default overall delete deadline is 90 s", () => {
  assert.equal(DELETE_DEADLINE_MS, 90_000);
});

test("a delete the gateway never answers gives up at the overall deadline, not once per attempt", async () => {
  const { fake, sandboxes } = setup(150);
  const sb = await sandboxes.create("run-1");
  fake.hangDelete = true;
  const began = Date.now();
  await assert.rejects(sb.destroy(), (err: unknown) => err instanceof SandboxCleanupError && /within the overall deadline|did not finish/.test(err.message));
  const took = Date.now() - began;
  assert.ok(took >= 140 && took < 1000, `gave up after about the deadline (took ${took} ms)`);
  assert.equal(fake.calls.filter((c) => c.op === "delete").length, 1, "no further attempt starts once the deadline has passed");
  // The run id is still queued, so a later sweep (the daemon's reclaim) deletes it.
  fake.hangDelete = false;
  await sb.stop();
  await sandboxes.destroy("run-1");
  assert.equal(fake.sandboxes.size, 0);
});

test("the wait for the sandbox to be gone is cut to the time left, and a wait that ignores it is abandoned", async () => {
  const { fake, sandboxes } = setup(200);
  const sb = await sandboxes.create("run-1");
  fake.hangWaitDeleted = true;
  const began = Date.now();
  await assert.rejects(sb.destroy(), SandboxCleanupError);
  assert.ok(Date.now() - began < 1000);
  assert.ok(fake.waitDeletedSecs.length >= 1 && fake.waitDeletedSecs.every((s) => s >= 1 && s <= 1), `wait bounded by the deadline, not 120 s: ${fake.waitDeletedSecs.join(",")}`);
});

test("retries share the one deadline: transient failures still succeed inside it", async () => {
  const { fake, sandboxes } = setup(5000);
  fake.options.deleteFailures = 2;
  const sb = await sandboxes.create("run-1");
  await sb.destroy();
  assert.equal(fake.sandboxes.size, 0);
  assert.equal(fake.calls.filter((c) => c.op === "delete").length, 3);
});

test("an abort that fires while the process is being started stops the process and fails the spawn", async () => {
  const { fake, sandboxes } = setup(5000);
  const sb = await sandboxes.create("run-1");
  fake.holdInteractive = true;
  const ctl = new AbortController();
  const spawning = sb.spawn("opencode serve", { signal: ctl.signal });
  await delay(10);
  ctl.abort(new Error("cancelled"));
  await assert.rejects(spawning, /cancelled/, "the caller is released at the abort, before the gateway answers");
  must(fake.releaseInteractive)();
  await delay(10);
  assert.equal(fake.interactives.length, 1);
  assert.equal(must(fake.interactives[0]).cancelled, true, "the process that started after the abort is stopped");
});

test("an abort that lands between the gateway's answer and the listener still stops the process", async () => {
  const { fake, sandboxes } = setup(5000);
  const sb = await sandboxes.create("run-1");
  const ctl = new AbortController();
  // The gateway answers and the signal aborts in the same tick: a listener added afterwards would never fire.
  const original = fake.execInteractive.bind(fake);
  fake.execInteractive = async (name, command, opts) => {
    const res = await original(name, command, opts);
    ctl.abort(new Error("cancelled"));
    return res;
  };
  await assert.rejects(sb.spawn("opencode serve", { signal: ctl.signal }), /cancelled/);
  assert.equal(must(fake.interactives[0]).cancelled, true);
});
