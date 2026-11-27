/** The trace keys leave the environment before the socket listens, and no host command inherits them. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { hostEnv } from "../../src/sandbox/host-command.js";
import { call, makeEnv, waitFor } from "./harness.js";

test("hostEnv drops every CULTURE_AGENTS_TRACE_ variable", () => {
  const names = ["CULTURE_AGENTS_TRACE_SECRET_KEY", "CULTURE_AGENTS_TRACE_PUBLIC_KEY", "CULTURE_AGENTS_TRACE_ENDPOINT"];
  for (const n of names) process.env[n] = "marker";
  try {
    const env = hostEnv();
    for (const n of names) assert.equal(n in env, false, n);
  } finally {
    for (const n of names) Reflect.deleteProperty(process.env, n);
  }
});

test("the core has read and removed the trace variables by the time it serves its first request", async () => {
  const env = makeEnv();
  const script = join(dirname(fileURLToPath(import.meta.url)), "trace-env-child.js");
  const vars = { ...process.env, ...env.vars, CULTURE_AGENTS_TRACE_ENDPOINT: "http://127.0.0.1:3000/api/public/otel", CULTURE_AGENTS_TRACE_PUBLIC_KEY: "marker-a", CULTURE_AGENTS_TRACE_SECRET_KEY: "marker-b" };
  const proc = spawn(process.execPath, [script], { env: vars, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
  try {
    await waitFor(() => existsSync(env.socket) && /listening on/.test(err));
    await call(env.socket, "GET", "/v1/agents");
    await waitFor(() => /TRACE_VARS_LEFT=/.test(err));
    assert.match(err, /TRACE_VARS_LEFT=0/);
  } finally {
    proc.kill("SIGKILL");
    env.cleanup();
  }
});
