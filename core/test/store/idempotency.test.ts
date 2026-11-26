import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KeyIndex, keysDir, pruneKeys, recoverKeys, requestDigest, type KeyEntry } from "../../src/store/idempotency.js";

const RUN = "thor-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5" as KeyEntry["run_id"];

function index(t: { after(fn: () => void): void }): KeyIndex {
  const dir = mkdtempSync(join(tmpdir(), "ca-keys-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new KeyIndex(dir);
}

const entry = (over: Partial<KeyEntry> = {}): KeyEntry => ({
  scope: "submit",
  key: "k1",
  digest: "sha256:x",
  run_id: RUN,
  state: "reserved",
  action: null,
  recorded_at: "2026-11-26T00:00:00.000Z",
  ...over,
});

test("the digest ignores field order and the key, and counts every other field and the route", () => {
  const a = { task: "t", caller: { kind: "operator", id: "thor-operator" }, repo: "/r", idempotency_key: "k" };
  const b = { repo: "/r", caller: { id: "thor-operator", kind: "operator" }, task: "t", idempotency_key: "other" };
  assert.equal(requestDigest("submit", a), requestDigest("submit", b));
  assert.notEqual(requestDigest("submit", a), requestDigest("submit", { ...a, task: "u" }));
  assert.notEqual(requestDigest("submit", a), requestDigest("submit", { ...a, caller: { kind: "agent", id: "thor-x" } }));
  assert.notEqual(requestDigest("steer", { message: "m" }, "r1"), requestDigest("steer", { message: "m" }, "r2"));
  assert.notEqual(requestDigest("steer", { caller: 1 }, "r1"), requestDigest("cancel", { caller: 1 }, "r1"));
});

test("entries are owner-only files in a 0700 directory and survive a new index", (t) => {
  const keys = index(t);
  keys.put(entry());
  assert.equal(statSync(keysDir(keys.stateDir)).mode & 0o777, 0o700);
  const reread = new KeyIndex(keys.stateDir).get("submit", "k1");
  assert.equal(reread?.run_id, RUN);
  assert.equal(new KeyIndex(keys.stateDir).get("steer", "k1"), null, "a key belongs to one route");
});

test("recovery releases a reserved key whose run never got a directory and keeps established keys", (t) => {
  const keys = index(t);
  keys.put(entry());
  keys.put(entry({ key: "k2", state: "established" }));
  const report = recoverKeys(keys);
  assert.deepEqual(report, { established: [], pending: [], released: ["submit:k1"] });
  assert.equal(keys.get("submit", "k1"), null);
  assert.equal(keys.get("submit", "k2")?.state, "established");
});

test("pruning removes only established keys the rule says are over", (t) => {
  const keys = index(t);
  keys.put(entry({ state: "established" }));
  keys.put(entry({ key: "k2" }));
  assert.deepEqual(pruneKeys(keys, () => true), ["submit:k1"]);
  assert.equal(keys.get("submit", "k2")?.state, "reserved");
});

test("exclusive runs calls on one key one at a time", async (t) => {
  const keys = index(t);
  const order: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const first = keys.exclusive("steer", "k", async () => {
    order.push("a-start");
    await gate;
    order.push("a-end");
  });
  const second = keys.exclusive("steer", "k", () => Promise.resolve(void order.push("b")));
  await Promise.resolve();
  open();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
});
