/**
 * The sandbox workspace and the OpenCode server start-up against fake sandboxes: process
 * parsing, cleanup when the handoff or the server start fails, and the generated OpenCode config
 * (a key reference, never a value).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { newProcesses, parsePs, PS_SCRIPT, PS_SELF } from "../../src/harness/common/processes.js";
import { SandboxWorkspace, SandboxWorkspaceFactory, type SandboxDeps, type SandboxSettings } from "../../src/harness/common/sandbox-workspace.js";
import { OpenCodeBackend, openCodeConfig, type SandboxBacked } from "../../src/harness/opencode/backend.js";
import type { RunProcess, RunSandbox, RunSandboxes } from "../../src/sandbox/index.js";

const PS = `${PS_SELF} 200
    1     0 Ss   /sbin/init-ish
   99     1 Sl   /usr/local/bin/opencode serve --hostname 127.0.0.1 --port 4096
  164     1 S    sleep 120
  170     1 Z    [defunct]
  190     1 Ss   exec-helper
  200   190 Ss   sh -c ${PS_SCRIPT}
  201   200 R    ps -eo pid=,ppid=,stat=,args=
`;

test("ps parsing drops zombies and the check's own processes; the diff keeps only new ones", () => {
  const procs = parsePs(PS);
  assert.deepEqual(procs.map((p) => p.pid), [1, 99, 164]);
  assert.deepEqual(newProcesses([{ pid: 1, ppid: 0, args: "/sbin/init-ish" }], procs).map((p) => p.pid), [99, 164]);
});

test("the check's own processes are known by pid: a process that only looks like the check is still listed", () => {
  // A harness child cannot hide by carrying the old marker, by looking like the listing, or by claiming to be the check.
  const disguised = `${PS_SELF} 200
    1     0 Ss   /sbin/init-ish
   50     1 S    opencode serve
   60    50 S    sh -c : ca-proc-check; exec sleep 1e9
   61    60 S    ps -eo pid=,ppid=,stat=,args=
   62    50 S    sh -c echo "${PS_SELF} 50"; sleep 1e9
  200     1 Ss   sh -c ${PS_SCRIPT}
  201   200 R    ps -eo pid=,ppid=,stat=,args=
${PS_SELF} 50
`;
  assert.deepEqual(parsePs(disguised).map((p) => p.pid), [1, 50, 60, 61, 62], "only pid 200 and its child are the check's");
  // A shell that exec'd the listing in place (one process with the reported pid) is the check too.
  assert.deepEqual(parsePs(`${PS_SELF} 7\n    1     0 Ss   init\n    7     1 R    ps -eo pid=,ppid=,stat=,args=\n`).map((p) => p.pid), [1]);
  assert.match(PS_SCRIPT, /\$\$/, "the script reports its own shell pid");
  assert.throws(() => parsePs("    1     0 Ss   init\n"), /did not report its own pid/, "a listing without the pid line is a failure, not an empty list");
});

const settings: SandboxSettings = {
  gateway: { endpoint: "https://127.0.0.1:17670", tlsDir: "/tls", name: null },
  openshellBin: "openshell",
  image: "culture-agents-run:dev",
  providers: ["lobes"],
  sandboxPrefix: "t11-",
  ref: "HEAD",
  identity: { name: "n", email: "e@x" },
};

function fakeSandbox(log: string[]): RunSandbox {
  return {
    runId: "r",
    name: "t11-abc",
    home: "/sandbox",
    state: "ready",
    exec: async () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
    readFile: async () => null,
    writeFile: async (path) => void log.push(`write ${path}`),
    spawn: async () => {
      throw new Error("unused");
    },
    endpoint: async () => ({ host: "127.0.0.1", port: 1 }),
    stop: async () => undefined,
    destroy: async () => void log.push("destroy"),
  };
}

test("a failed repository handoff deletes the sandbox before the error propagates", async () => {
  const log: string[] = [];
  const deps: SandboxDeps = {
    openRunSandboxes: async (config) => {
      log.push(`open ${config.image} ${config.providers?.join(",")} ${config.prefix}`);
      return { create: async () => fakeSandbox(log), destroy: async () => void log.push("destroy-by-id") } as unknown as RunSandboxes;
    },
    prepare: async () => {
      throw new Error("bundle clone failed");
    },
    collect: async () => {
      throw new Error("unused");
    },
  };
  const factory = new SandboxWorkspaceFactory("r", "/host", settings, deps);
  await assert.rejects(factory.open(new AbortController().signal), /bundle clone failed/);
  assert.deepEqual(log, ["open culture-agents-run:dev lobes t11-", "destroy"]);
});

test("a commit count that fails in the sandbox fails the collect; it is not read as nothing to collect", async () => {
  const sandbox = { ...fakeSandbox([]), exec: async () => ({ exitCode: 1, stdout: new Uint8Array(), stderr: new TextEncoder().encode("fatal: index.lock exists") }) };
  const prepared = { branch: "runs/r", baseCommit: "a".repeat(40), path: "/sandbox/work" };
  const never = () => new Promise<never>(() => undefined);
  const ws = new SandboxWorkspace({} as RunSandboxes, sandbox, prepared, "r", "/host", settings, { openRunSandboxes: never, prepare: never, collect: never });
  await assert.rejects(ws.collect(), /could not count the run's commits.*exit 1.*index\.lock/);
});

function fakeProcess(stdout: string): RunProcess & { cancelled: number } {
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (text) c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
  const proc = {
    cancelled: 0,
    stdout: stream(stdout),
    stderr: stream("boom: no config\n"),
    write: () => undefined,
    closeInput: () => undefined,
    wait: async () => ({ exitCode: 1 }),
    cancel: async () => {
      proc.cancelled += 1;
    },
  };
  return proc;
}

test("an OpenCode server that never listens fails the start and is stopped", async () => {
  const proc = fakeProcess("starting...\n");
  const spawned: { command: string; env: Record<string, string> | undefined }[] = [];
  const writes: string[] = [];
  const workspace = {
    workdir: "/sandbox/work",
    sandbox: {
      home: "/sandbox",
      writeFile: async (path: string, content: Uint8Array) => void writes.push(`${path}=${new TextDecoder().decode(content)}`),
      spawn: async (command: string, options?: { env?: Record<string, string> }) => {
        spawned.push({ command, env: options?.env ? { ...options.env } : undefined });
        return proc;
      },
      endpoint: async () => ({ host: "127.0.0.1", port: 1 }),
    },
  } as unknown as SandboxBacked;
  const backend = new OpenCodeBackend({ model: "gateway/worker", baseUrl: "http://gw/v1", keyEnv: "LOBES_GATEWAY_KEY", port: 4096, startTimeoutMs: 500 });
  await assert.rejects(backend.open(workspace, new AbortController().signal, () => undefined), /did not report listening/);
  assert.equal(proc.cancelled, 1, "the server process is stopped");
  assert.match(spawned[0]?.command ?? "", /^exec '\/usr\/local\/bin\/opencode' serve --hostname 127\.0\.0\.1 --port 4096$/);
  assert.equal(spawned[0]?.env?.["OPENCODE_CONFIG"], "/sandbox/.culture-agents/opencode.json");
  assert.ok((spawned[0]?.env?.["OPENCODE_SERVER_PASSWORD"] ?? "").length >= 24, "a per-run password");
  assert.ok(writes[0]?.startsWith("/sandbox/.culture-agents/opencode.json="));
});

test("the OpenCode config references the key variable and names the model", () => {
  const config = openCodeConfig({ model: "gateway/worker", baseUrl: "http://host.openshell.internal:8001/v1", keyEnv: "LOBES_GATEWAY_KEY", port: 4096 });
  const provider = (config["provider"] as Record<string, { options: { apiKey: string; baseURL: string }; models: Record<string, unknown> }>)["gateway"];
  assert.equal(provider?.options.apiKey, "{env:LOBES_GATEWAY_KEY}");
  assert.equal(provider?.options.baseURL, "http://host.openshell.internal:8001/v1");
  assert.ok(provider?.models["worker"]);
  assert.equal(config["model"], "gateway/worker");
});
