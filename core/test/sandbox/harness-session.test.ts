import assert from "node:assert/strict";
import { test } from "node:test";

import {
  sliceLines,
  toHarnessSandboxSession,
} from "../../src/sandbox/harness-session.js";
import { createRunSandboxes } from "../../src/sandbox/run-sandboxes.js";
import { FakeOpenShell, TEST_POLICY, type FakeOptions, must } from "./fake-openshell.js";

function setup(options: FakeOptions = {}) {
  const fake = new FakeOpenShell(options);
  const sandboxes = createRunSandboxes(
    { image: "img:1", prefix: "t-" },
    { client: fake, policy: TEST_POLICY, sleep: async () => undefined },
  );
  return { fake, sandboxes };
}

test("the session runs commands, reads and writes files, and resolves port endpoints", async () => {
  const { fake, sandboxes } = setup({
    onExec: (_n, script) => {
      if (script === "echo hi") return { exitCode: 0, stdout: Buffer.from("hello world"), stderr: Buffer.alloc(0) };
      if (script.includes("stat -L")) return { exitCode: 0, stdout: Buffer.from("regular file|12\n"), stderr: Buffer.alloc(0) };
      if (script.includes("find ")) return { exitCode: 0, stdout: Buffer.from("f a.txt\nd sub\nl ln\n"), stderr: Buffer.alloc(0) };
      return undefined;
    },
  });
  const session = toHarnessSandboxSession(await sandboxes.create("run-1"));
  assert.deepEqual(await session.run({ command: "echo hi" }), { exitCode: 0, stdout: "hello world", stderr: "" });
  const capped = await session.run({ command: "echo hi", maxOutputLength: 5 });
  assert.equal(capped.stdout, "hello");
  assert.equal(capped.stdoutLength, 11);
  await session.writeTextFile({ path: "a/b.txt", content: "one\ntwo\nthree" });
  assert.equal(await session.readTextFile({ path: "a/b.txt", startLine: 2, endLine: 2 }), "two");
  assert.equal(await session.readTextFile({ path: "missing" }), null);
  assert.equal(await session.readFile({ path: "missing" }), null);
  const stream = await session.readFile({ path: "/sandbox/a/b.txt" });
  assert.equal(await new Response(stream).text(), "one\ntwo\nthree");
  await session.writeFile({ path: "c.bin", content: must(new Response("streamed").body) });
  assert.equal(await session.readTextFile({ path: "c.bin" }), "streamed");
  assert.deepEqual(await session.stat({ path: "a/b.txt" }), { type: "file", size: 12 });
  assert.deepEqual(await session.listDirectory({ path: "." }), [
    { name: "a.txt", type: "file" },
    { name: "sub", type: "directory" },
    { name: "ln", type: "symlink" },
  ]);
  assert.equal(await session.deleteFile({ path: "a/b.txt" }), true);
  const ep = await session.getPortEndpoint({ port: 4100, protocol: "ws" });
  assert.match(ep.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await session.getPortUrl({ port: 4100, protocol: "ws" }), ep.url);
  await must(session.setPorts)([4100, 4200]);
  assert.deepEqual(session.ports, [4100, 4200]);
  assert.equal(fake.calls.filter((c) => c.op === "forward").length, 1);
  const restricted = session.restricted() as unknown as Record<string, unknown>;
  for (const member of ["stop", "destroy", "getPortEndpoint", "setPorts"]) {
    assert.equal(member in restricted, false, member);
  }
});

test("spawn with stdin and kill map onto the run process", async () => {
  const { fake, sandboxes } = setup();
  const session = toHarnessSandboxSession(await sandboxes.create("run-1"));
  const proc = await session.spawn({ command: "cat", stdin: true });
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode("via-stdin"));
  await writer.close();
  const ctl = must(fake.interactives[0]);
  assert.equal(Buffer.concat(ctl.written).toString(), "via-stdin");
  assert.equal(ctl.inputClosed, true);
  await proc.kill();
  assert.equal(ctl.cancelled, true);
  assert.deepEqual(await proc.wait(), { exitCode: 137 });
  await session.stop();
  await session.destroy();
  assert.equal(fake.sandboxes.size, 0);
});

test("sliceLines matches the AI SDK's 1-based inclusive clamped slicing", () => {
  assert.equal(sliceLines("a\nb\nc"), "a\nb\nc");
  assert.equal(sliceLines("a\nb\nc", 2), "b\nc");
  assert.equal(sliceLines("a\r\nb\r\nc", 1, 2), "a\r\nb");
  assert.equal(sliceLines("a\nb", 0, 99), "a\nb");
});
