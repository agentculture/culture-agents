/**
 * The sequencing helpers: one step at a time, never two at once, with waits that an abort signal
 * cuts short and no promise chain that grows with the number of steps.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { again, finish, inOrder, pollUntil, stepUntil } from "../../src/util/sequence.js";

/** Counts how many calls are in flight, and the most seen at once. */
function overlapMeter() {
  let active = 0;
  let most = 0;
  return {
    async run<T>(ms: number, value: T): Promise<T> {
      active += 1;
      most = Math.max(most, active);
      await delay(ms);
      active -= 1;
      return value;
    },
    get most() {
      return most;
    },
  };
}

test("stepUntil runs the first step synchronously and resolves with the finishing value", async () => {
  const seen: string[] = [];
  const result = stepUntil(() => {
    seen.push("step");
    return finish(7);
  });
  seen.push("after call");
  assert.deepEqual(seen, ["step", "after call"]);
  assert.equal(await result, 7);
});

test("stepUntil waits the time each step asks for, and not at all when it asks for none", async () => {
  const at: number[] = [];
  const began = Date.now();
  const waits = [undefined, 40, undefined];
  const result = await stepUntil(() => {
    at.push(Date.now() - began);
    if (at.length > waits.length) return finish(at.length);
    return again(waits[at.length - 1]);
  });
  assert.equal(result, 4);
  assert.ok((at[1] as number) < 30, `no wait before the second step (${at[1]} ms)`);
  assert.ok((at[2] as number) - (at[1] as number) >= 35, `the 40 ms wait was kept (${at[2]} ms)`);
  assert.ok((at[3] as number) - (at[2] as number) < 30, "no wait before the last step");
});

test("stepUntil never runs two steps at once, with sync and async steps mixed", async () => {
  const meter = overlapMeter();
  let n = 0;
  await stepUntil(() => {
    n += 1;
    if (n === 6) return finish(undefined);
    if (n % 2 === 0) return again(1);
    return meter.run(5, again(n === 3 ? undefined : 1));
  });
  assert.equal(n, 6);
  assert.equal(meter.most, 1);
});

test("stepUntil rejects with what a step throws or rejects with, and runs no further step", async () => {
  let calls = 0;
  await assert.rejects(
    stepUntil(() => {
      calls += 1;
      if (calls === 2) throw new Error("sync boom");
      return again(1);
    }),
    /sync boom/,
  );
  await assert.rejects(
    stepUntil(async () => {
      calls += 1;
      if (calls === 4) throw new Error("async boom");
      return again(1);
    }),
    /async boom/,
  );
  await delay(20);
  assert.equal(calls, 4);
});

test("stepUntil stops promptly when the signal aborts during a wait", async () => {
  const controller = new AbortController();
  let calls = 0;
  const began = Date.now();
  const pending = stepUntil(
    () => {
      calls += 1;
      return again(60_000);
    },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error("stop now")), 20);
  await assert.rejects(pending, /stop now/);
  assert.ok(Date.now() - began < 2000);
  assert.equal(calls, 1, "no step after the abort");
});

test("stepUntil resolves with onAbort's value instead of rejecting, before the first step too", async () => {
  const controller = new AbortController();
  const began = Date.now();
  const pending = stepUntil<string>(() => again(60_000), { signal: controller.signal, onAbort: () => "closed" });
  controller.abort(); // after the first step returned, before its wait was set up
  assert.equal(await pending, "closed");
  assert.ok(Date.now() - began < 2000, "an abort between a step and its wait is not missed");
  let calls = 0;
  const never = await stepUntil<string>(
    () => {
      calls += 1;
      return finish("ran");
    },
    { signal: controller.signal, onAbort: () => "closed" },
  );
  assert.equal(never, "closed");
  assert.equal(calls, 0);
});

test("stepUntil lets a running step finish after an abort, and honours what it returns", async () => {
  const controller = new AbortController();
  const result = stepUntil<string>(
    async () => {
      controller.abort();
      await delay(5);
      return finish("finished anyway");
    },
    { signal: controller.signal, onAbort: () => "closed" },
  );
  assert.equal(await result, "finished anyway");
});

test("stepUntil uses the given wait in place of a timer", async () => {
  const waited: number[] = [];
  let n = 0;
  await stepUntil(
    () => {
      n += 1;
      return n === 4 ? finish(undefined) : again(n === 2 ? undefined : n * 1000);
    },
    {
      wait: async (ms) => {
        waited.push(ms);
      },
    },
  );
  assert.deepEqual(waited, [1000, 3000]);
});

test("stepUntil holds no growing chain: many steps without a wait neither overflow the stack nor slow down", async () => {
  let n = 0;
  const result = await stepUntil(() => {
    n += 1;
    return n === 200_000 ? finish(n) : again();
  });
  assert.equal(result, 200_000);
});

test("pollUntil resolves with the first truthy value and checks in order, one at a time", async () => {
  const meter = overlapMeter();
  const order: number[] = [];
  let n = 0;
  const value = await pollUntil(
    async () => {
      n += 1;
      order.push(n);
      return meter.run(8, n === 4 ? "ready" : undefined);
    },
    { everyMs: 1 },
  );
  assert.equal(value, "ready");
  assert.deepEqual(order, [1, 2, 3, 4]);
  assert.equal(meter.most, 1);
});

test("pollUntil resolves undefined once the time is up, right after a failed check and without another wait", async () => {
  let calls = 0;
  const began = Date.now();
  const value = await pollUntil(
    () => {
      calls += 1;
      return false;
    },
    { everyMs: 10, timeoutMs: 45 },
  );
  const took = Date.now() - began;
  assert.equal(value, undefined);
  assert.ok(calls >= 2 && calls <= 7, `${calls} checks`);
  assert.ok(took >= 40 && took < 1000, `${took} ms`);
});

test("pollUntil checks once even with no time at all", async () => {
  let calls = 0;
  const value = await pollUntil(
    () => {
      calls += 1;
      return calls === 1 ? "first" : undefined;
    },
    { everyMs: 10, timeoutMs: 0 },
  );
  assert.equal(value, "first");
});

test("pollUntil rejects promptly with the abort reason when aborted mid-wait", async () => {
  const controller = new AbortController();
  let calls = 0;
  const began = Date.now();
  const pending = pollUntil(
    () => {
      calls += 1;
      return false;
    },
    { everyMs: 60_000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error("cancelled")), 20);
  await assert.rejects(pending, /cancelled/);
  assert.ok(Date.now() - began < 2000);
  assert.equal(calls, 1);
});

test("pollUntil propagates a rejection from the check and stops checking", async () => {
  let calls = 0;
  await assert.rejects(
    pollUntil(
      async () => {
        calls += 1;
        if (calls === 3) throw new Error("check failed");
        return false;
      },
      { everyMs: 1 },
    ),
    /check failed/,
  );
  await delay(20);
  assert.equal(calls, 3);
});

test("inOrder runs each item only after the one before it has finished", async () => {
  const log: string[] = [];
  await inOrder([30, 1, 10], async (ms, index) => {
    log.push(`start ${index}`);
    await delay(ms);
    log.push(`end ${index}`);
  });
  assert.deepEqual(log, ["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]);
});

test("inOrder starts the first item synchronously and does nothing for an empty list", async () => {
  const log: string[] = [];
  const pending = inOrder(["a"], (item) => {
    log.push(item);
  });
  log.push("after call");
  await pending;
  assert.deepEqual(log, ["a", "after call"]);
  await inOrder([], () => assert.fail("no items"));
});

test("inOrder stops at the first rejection and leaves the rest untouched", async () => {
  const seen: number[] = [];
  await assert.rejects(
    inOrder([1, 2, 3, 4], async (n) => {
      seen.push(n);
      if (n === 2) throw new Error("second failed");
    }),
    /second failed/,
  );
  await delay(10);
  assert.deepEqual(seen, [1, 2]);
});

test("inOrder reads its items lazily, so a set changed by an earlier item is seen as it then is", async () => {
  const items = new Set(["a", "b", "c"]);
  const seen: string[] = [];
  await inOrder(items, (item) => {
    seen.push(item);
    if (item === "a") items.delete("b");
  });
  assert.deepEqual(seen, ["a", "c"]);
});
