import assert from "node:assert/strict";
import { test } from "node:test";

import { runKey, sandboxName } from "../../src/sandbox/naming.js";
import { createRunSandboxes } from "../../src/sandbox/run-sandboxes.js";
import { CANCELLED_EXIT, WRITE_CHUNK } from "../../src/sandbox/run-sandbox.js";
import {
  SandboxBusyError,
  SandboxCleanupError,
  SandboxNotFoundError,
  type RunSandboxesConfig,
} from "../../src/sandbox/types.js";
import { FakeOpenShell, SdkLikeError, TEST_POLICY, type FakeOptions, must } from "./fake-openshell.js";

const CONFIG: RunSandboxesConfig = { image: "img:1", providers: ["claude-sub"], prefix: "t-" };

function setup(options: FakeOptions = {}, config: Partial<RunSandboxesConfig> = {}) {
  const fake = new FakeOpenShell(options);
  const sandboxes = createRunSandboxes(
    { ...CONFIG, ...config },
    { client: fake, policy: TEST_POLICY, sleep: async () => undefined },
  );
  return { fake, sandboxes };
}

test("create names the sandbox from the run id, labels it and passes the policy", async () => {
  const { fake, sandboxes } = setup();
  const sb = await sandboxes.create("run-1");
  assert.equal(sb.name, sandboxName("run-1", "t-"));
  assert.equal(sb.home, "/sandbox");
  assert.equal(sb.state, "ready");
  const spec = fake.calls.find((c) => c.op === "create")?.detail as Record<string, unknown>;
  assert.deepEqual(spec["labels"], { "managed-by": "culture-agents", "run-key": runKey("run-1"), "run-id": "run-1" });
  assert.deepEqual(spec["providers"], ["claude-sub"]);
  assert.deepEqual(spec["policy"], TEST_POLICY);
  assert.equal(spec["image"], "img:1");
  assert.equal("environment" in spec, false, "no host environment is passed to the sandbox");
  assert.deepEqual(sandboxes.active(), ["run-1"]);
});

test("destroy deletes, waits, is idempotent and drops the handle", async () => {
  const { fake, sandboxes } = setup();
  const sb = await sandboxes.create("run-1");
  await sb.destroy();
  await sb.destroy();
  assert.equal(sb.state, "destroyed");
  assert.equal(fake.sandboxes.size, 0);
  assert.deepEqual(sandboxes.active(), []);
  assert.equal(fake.calls.filter((c) => c.op === "delete").length, 1);
  await assert.rejects(sb.exec("true"), /destroyed/);
});

test("a second create for the same run id is refused while one is live", async () => {
  const { sandboxes } = setup();
  await sandboxes.create("run-1");
  await assert.rejects(sandboxes.create("run-1"), SandboxBusyError);
});

test("an existing sandbox of the same name is never deleted by a failed create", async () => {
  const { fake, sandboxes } = setup();
  const name = sandboxName("run-1", "t-");
  fake.sandboxes.set(name, { phase: "ready", labels: {}, files: new Map(), spec: {} as never });
  await assert.rejects(sandboxes.create("run-1"), SandboxBusyError);
  assert.ok(fake.sandboxes.has(name));
  assert.equal(fake.calls.filter((c) => c.op === "delete").length, 0);
});

test("readiness failure deletes the sandbox before the error propagates", async () => {
  const { fake, sandboxes } = setup({ waitReadyError: new Error("image pull failed") });
  await assert.rejects(sandboxes.create("run-1"), /image pull failed/);
  assert.equal(fake.sandboxes.size, 0);
  assert.deepEqual(fake.ops(), ["create", "waitReady", "delete", "waitDeleted"]);
  assert.deepEqual(sandboxes.active(), []);
});

test("a create that fails after the gateway acted is cleaned up", async () => {
  const { fake, sandboxes } = setup({ createThenThrow: new Error("deadline exceeded") });
  await assert.rejects(sandboxes.create("run-1"), /deadline exceeded/);
  assert.equal(fake.sandboxes.size, 0);
});

test("an abort during startup deletes the sandbox", async () => {
  const ctl = new AbortController();
  const { fake, sandboxes } = setup({
    onExec: (_n, script) => {
      if (script === "pwd") ctl.abort(new Error("operator cancelled"));
      return undefined;
    },
  });
  await assert.rejects(sandboxes.create("run-1", { signal: ctl.signal }), /operator cancelled/);
  assert.equal(fake.sandboxes.size, 0);
});

test("an already-aborted signal creates nothing", async () => {
  const { fake, sandboxes } = setup();
  await assert.rejects(sandboxes.create("run-1", { signal: AbortSignal.abort() }));
  assert.equal(fake.calls.length, 0);
});

test("withRun destroys after success and after failure", async () => {
  const { fake, sandboxes } = setup();
  assert.equal(await sandboxes.withRun("ok", async () => 42), 42);
  await assert.rejects(
    sandboxes.withRun("boom", async () => {
      throw new Error("adapter doStart failed");
    }),
    /adapter doStart failed/,
  );
  assert.equal(fake.sandboxes.size, 0);
  assert.deepEqual(sandboxes.active(), []);
});

test("delete retries transient failures", async () => {
  const { fake, sandboxes } = setup({ deleteFailures: 2 });
  const sb = await sandboxes.create("run-1");
  await sb.destroy();
  assert.equal(fake.sandboxes.size, 0);
  assert.equal(fake.calls.filter((c) => c.op === "delete").length, 3);
});

test("unconfirmed deletion raises SandboxCleanupError and sweep retries it", async () => {
  const { fake, sandboxes } = setup({ deleteFailures: 3 });
  const sb = await sandboxes.create("run-1");
  await assert.rejects(sb.destroy(), SandboxCleanupError);
  assert.equal(fake.sandboxes.size, 1);
  // The handle stays usable for another attempt; sweep picks it up too.
  await sb.stop();
  const deleted = await sandboxes.sweep();
  assert.deepEqual(deleted, []); // still live in this process
  await sb.destroy();
  assert.equal(fake.sandboxes.size, 0);
});

test("destroy by run id works without a handle (leaked adapter sandbox)", async () => {
  const first = setup();
  await first.sandboxes.create("run-9");
  // A different process (or a crashed HarnessAgent) holds no handle.
  const other = createRunSandboxes(CONFIG, { client: first.fake, policy: TEST_POLICY });
  await other.destroy("run-9");
  assert.equal(first.fake.sandboxes.size, 0);
  await other.destroy("run-9"); // idempotent: allowMissing
});

test("resume rebinds by run id and checks the run-id label", async () => {
  const { fake, sandboxes } = setup();
  await sandboxes.create("run-1");
  const other = createRunSandboxes(CONFIG, { client: fake, policy: TEST_POLICY });
  const sb = await other.resume("run-1");
  assert.equal(sb.name, sandboxName("run-1", "t-"));
  await assert.rejects(other.resume("nope"), SandboxNotFoundError);
  must(fake.sandboxes.get(sandboxName("run-1", "t-"))).labels["run-id"] = "someone-else";
  const third = createRunSandboxes(CONFIG, { client: fake, policy: TEST_POLICY });
  await assert.rejects(third.resume("run-1"), /belongs to run/);
});

test("sweep deletes managed sandboxes not kept and not live", async () => {
  const { fake, sandboxes } = setup();
  await sandboxes.create("live");
  const crashed = createRunSandboxes(CONFIG, { client: fake, policy: TEST_POLICY });
  await crashed.create("orphan");
  await crashed.create("kept");
  fake.sandboxes.set("unmanaged", { phase: "ready", labels: {}, files: new Map(), spec: {} as never });
  const deleted = await sandboxes.sweep(["kept"]);
  assert.deepEqual(deleted, ["orphan"]);
  assert.deepEqual([...fake.sandboxes.keys()].sort(), [sandboxName("kept", "t-"), sandboxName("live", "t-"), "unmanaged"].sort());
});

test("exec scrubs operator credentials from any env it is given", async () => {
  const { fake, sandboxes } = setup();
  const sb = await sandboxes.create("run-1");
  await sb.exec("env", { env: { GH_TOKEN: "x", GITHUB_TOKEN: "y", SSH_AUTH_SOCK: "/s", OK: "1" } });
  const last = must(fake.execs.at(-1));
  assert.deepEqual(last.opts?.environment, { OK: "1" });
  assert.equal(last.opts?.noLoginShell, true);
  assert.equal(last.opts?.workdir, "/sandbox");
});

test("files round-trip, missing files are null, and large writes are chunked", async () => {
  const { fake, sandboxes } = setup();
  const sb = await sandboxes.create("run-1");
  assert.equal(await sb.readFile("nope.txt"), null);
  const big = new Uint8Array(WRITE_CHUNK * 2 + 5).fill(7);
  await sb.writeFile("d/big.bin", big);
  const back = await sb.readFile("/sandbox/d/big.bin");
  assert.equal(back?.length, big.length);
  const writes = fake.execs.filter((e) => e.script.includes("cat >"));
  assert.equal(writes.length, 3);
});

test("spawn streams output, cancel ends the remote process, stop cancels the rest", async () => {
  const { fake, sandboxes } = setup();
  const sb = await sandboxes.create("run-1");
  const proc = await sb.spawn("cat", { stdin: true });
  const ctl = must(fake.interactives[0]);
  assert.equal(ctl.inputClosed, false);
  proc.write(new TextEncoder().encode("hi"));
  ctl.emit({ stream: "stdout", data: Buffer.from("out") });
  ctl.emit({ stream: "stderr", data: Buffer.from("err") });
  await proc.cancel();
  assert.equal(ctl.cancelled, true);
  assert.deepEqual(await proc.wait(), { exitCode: CANCELLED_EXIT });
  assert.equal(await new Response(proc.stdout).text(), "out");
  assert.equal(await new Response(proc.stderr).text(), "err");
  assert.equal(Buffer.concat(ctl.written).toString(), "hi");

  const quiet = await sb.spawn("sleep 100");
  assert.equal(must(fake.interactives[1]).inputClosed, true);
  assert.throws(() => quiet.write(new Uint8Array([1])), /without stdin/);
  const done = await sb.spawn("true");
  must(fake.interactives[2]).emit({ type: "exit", exitCode: 0 });
  must(fake.interactives[2]).end();
  assert.deepEqual(await done.wait(), { exitCode: 0 });
  await sb.endpoint(4100);
  await sb.stop();
  assert.equal(must(fake.interactives[1]).cancelled, true);
  assert.equal(fake.closedForwards, 1);
  assert.equal(sb.state, "stopped");
});

test("an abort signal cancels a spawned process", async () => {
  const { fake, sandboxes } = setup();
  const sb = await sandboxes.create("run-1");
  const ctl = new AbortController();
  const proc = await sb.spawn("sleep 100", { signal: ctl.signal });
  ctl.abort();
  assert.deepEqual(await proc.wait(), { exitCode: CANCELLED_EXIT });
  assert.equal(must(fake.interactives[0]).cancelled, true);
});

test("endpoint forwards once per port", async () => {
  const { fake, sandboxes } = setup();
  const sb = await sandboxes.create("run-1");
  const a = await sb.endpoint(4100);
  const b = await sb.endpoint(4100);
  assert.deepEqual(a, b);
  assert.equal(a.host, "127.0.0.1");
  assert.equal(fake.calls.filter((c) => c.op === "forward").length, 1);
});

test("a not-found during readiness still leaves nothing behind", async () => {
  const { fake, sandboxes } = setup({ waitReadyError: new SdkLikeError("not_found", "gone") });
  await assert.rejects(sandboxes.create("run-1"));
  assert.equal(fake.sandboxes.size, 0);
});

// The longest contract-valid run id: a 96-character mesh id, ".run.", a 26-character ULID.
const LONG_RUN_ID = `spark-${"a".repeat(90)}.run.01JD0000000000000000000000`;

test("a 127-character run id gets labels the gateway accepts; resume, destroy and sweep work by run id alone", async () => {
  assert.equal(LONG_RUN_ID.length, 127);
  const { fake, sandboxes } = setup();
  const sb = await sandboxes.create(LONG_RUN_ID);
  assert.equal(sb.name, sandboxName(LONG_RUN_ID, "t-"));
  const labels = must(fake.sandboxes.get(sb.name)).labels;
  assert.equal(labels["run-key"], runKey(LONG_RUN_ID));
  assert.equal(labels["run-id"], undefined, "the full id does not fit one label value");
  for (const value of Object.values(labels)) assert.ok(value.length <= 63);

  // A process with no handle resumes it, and a mismatching key is refused.
  const other = createRunSandboxes(CONFIG, { client: fake, policy: TEST_POLICY });
  assert.equal((await other.resume(LONG_RUN_ID)).name, sb.name);
  const crashed = createRunSandboxes(CONFIG, { client: fake, policy: TEST_POLICY });
  await crashed.create(`${LONG_RUN_ID.slice(0, -1)}1`);
  // sweep recovers the full run id from the labels and deletes the orphan, not the live one.
  assert.deepEqual(await sandboxes.sweep(), [`${LONG_RUN_ID.slice(0, -1)}1`]);
  // destroy by run id alone.
  await createRunSandboxes(CONFIG, { client: fake, policy: TEST_POLICY }).destroy(LONG_RUN_ID);
  assert.equal(fake.sandboxes.size, 0);
});

test("resume refuses a sandbox whose run key belongs to another long run id", async () => {
  const { fake, sandboxes } = setup();
  const sb = await sandboxes.create(LONG_RUN_ID);
  must(fake.sandboxes.get(sb.name)).labels["run-key"] = runKey("someone-else");
  const other = createRunSandboxes(CONFIG, { client: fake, policy: TEST_POLICY });
  await assert.rejects(other.resume(LONG_RUN_ID), /belongs to run/);
});
