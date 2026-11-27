// Child for secrets.test.ts: the real `main` with every injected secret set in its environment. Once it
// reports that it is listening it starts a worker with the default environment, runs a host command and
// execs in a recording sandbox, then prints what each of the three could see as one JSON line.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INJECTED_SECRETS } from "../../src/daemon/secrets.js";
import { main } from "../../src/daemon/main.js";
import { runCommand } from "../../src/sandbox/host-command.js";
import { OpenShellRunSandbox } from "../../src/sandbox/run-sandbox.js";
import { spawnWorker } from "../../src/worker/spawn.js";
import { fakeDriver, newRun } from "../worker/helpers.js";
import { FakeRunService } from "./fake-service.js";

const names = (text: string): string[] => text.split("\n").map((l) => l.split("=")[0] ?? "");

async function probe(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "ca-secrets-"));
  const worker = await spawnWorker({ stateDir, run: newRun(), driver: fakeDriver({ steps: [{ op: "started" }, { op: "hang" }] }), heartbeatMs: 50 });
  const workerEnv = names(readFileSync(`/proc/${worker.pid}/environ`, "utf8").replaceAll("\0", "\n"));
  process.kill(worker.pid, "SIGKILL");
  const host = names((await runCommand("env", [])).stdout);
  let sandboxEnv: string[] = [];
  const client = { exec: (_n: string, _c: string[], o?: { environment?: Record<string, string> }) => {
    sandboxEnv = Object.keys(o?.environment ?? {});
    return Promise.resolve({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });
  } };
  const sandbox = new OpenShellRunSandbox("r", "n", "/home", client as never, async () => undefined, () => undefined);
  // The caller passes the core's own environment, as the harness session does.
  await sandbox.exec("true", { env: { ...process.env, ...Object.fromEntries(INJECTED_SECRETS.map((n) => [n, "x"])) } as Record<string, string> });
  const out = { worker: workerEnv, host, sandbox: sandboxEnv, core: Object.keys(process.env) };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  rmSync(stateDir, { recursive: true, force: true });
  process.kill(process.pid, "SIGTERM");
}

const code = await main(new FakeRunService(), {
  node: "thor",
  stderr: (line) => {
    if (line.includes("listening on")) void probe();
  },
});
process.exit(code);
