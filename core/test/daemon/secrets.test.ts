import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { INJECTED_SECRETS, heldSecret, scrubSecrets, takeSecrets } from "../../src/daemon/secrets.js";
import { makeEnv } from "./harness.js";

const CHILD = fileURLToPath(new URL("./secrets-child.js", import.meta.url));

test("a marked secret is absent from the worker, a host command and the sandbox after the core starts", async () => {
  const env = makeEnv();
  try {
    const marked = Object.fromEntries(INJECTED_SECRETS.map((n) => [n, `marker-${n}`]));
    const child = spawn(process.execPath, [CHILD], { env: { ...process.env, ...env.vars, ...marked }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    await new Promise((resolve) => child.once("exit", resolve));
    const seen = JSON.parse(out.trim().split("\n").pop() ?? "{}") as Record<string, string[]>;
    assert.ok(seen["worker"] && seen["worker"].length > 0, `worker environment was read: ${err}`);
    assert.ok(seen["host"] && seen["host"].length > 0, "host command environment was read");
    for (const name of INJECTED_SECRETS) {
      for (const where of ["core", "worker", "host", "sandbox"]) assert.ok(!seen[where]?.includes(name), `${name} absent from ${where}`);
    }
  } finally {
    env.cleanup();
  }
});

test("takeSecrets reads each variable once, keeps it in memory and deletes it", () => {
  const env: Record<string, string | undefined> = { MARK_A: "a", KEEP: "k" };
  assert.deepEqual(takeSecrets(env, ["MARK_A", "MARK_B"]), ["MARK_A"]);
  assert.deepEqual(env, { KEEP: "k" });
  assert.equal(heldSecret("MARK_A"), "a");
});

test("scrubSecrets drops every declared name and nothing else", () => {
  const env = { ...Object.fromEntries(INJECTED_SECRETS.map((n) => [n, "v"])), PATH: "/bin" };
  assert.deepEqual(scrubSecrets(env), { PATH: "/bin" });
});
