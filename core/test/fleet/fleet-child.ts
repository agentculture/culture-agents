// Child for config.test.ts: the real `main` of thor's fixture, with the fleet variables the parent set.
// Mode "on": the parent passed a key and a listen address; this child stands in for the operator (it
// derives the serving core's certificate from the key before `main` takes it) and for a calling core
// (a second key, trusted by the serving core), then reports what it saw as one JSON line.
// Mode "off": no listen address. Mode "bad": `main` must refuse to start.
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/daemon/main.js";
import { FLEET_KEY_ENV, newFleetKey, parseFleetKey } from "../../src/fleet/cert.js";
import { fleetCall } from "../../src/fleet/transport.js";
import { loadTrust, resolveTrustPath } from "../../src/fleet/trust.js";
import { hostEnv } from "../../src/sandbox/host-command.js";
import { spawnWorker } from "../../src/worker/spawn.js";
import { FakeRunService } from "../daemon/fake-service.js";
import { fakeDriver, newRun } from "../worker/helpers.js";
import { writeTrust } from "./support.js";

const [mode = "off", configHome = ""] = process.argv.slice(2);
const caller = newFleetKey(); // the calling core
const servingText = process.env[FLEET_KEY_ENV];
const callerTrustPath = join(configHome, "caller-trust.json");
if (mode === "on" && servingText) {
  writeTrust(resolveTrustPath({ XDG_CONFIG_HOME: configHome }), [caller]);
  writeTrust(callerTrustPath, [parseFleetKey(servingText)]);
}
let fleetPort = 0;

async function workerSees(): Promise<boolean> {
  const stateDir = mkdtempSync(join(tmpdir(), "ca-fleet-worker-"));
  try {
    const worker = await spawnWorker({ stateDir, run: newRun(), driver: fakeDriver({ steps: [{ op: "started" }, { op: "hang" }] }), heartbeatMs: 50 });
    const env = readFileSync(`/proc/${worker.pid}/environ`, "utf8");
    process.kill(worker.pid, "SIGKILL");
    return env.includes(`${FLEET_KEY_ENV}=`);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function probe(): Promise<void> {
  const out: Record<string, unknown> = { keyInCoreEnv: FLEET_KEY_ENV in process.env };
  if (mode === "on") {
    const res = await fleetCall({ key: caller, trust: loadTrust(callerTrustPath), host: "127.0.0.1", port: fleetPort, method: "GET", path: "/v1/version" });
    out["status"] = res.status;
    out["keyInHostEnv"] = FLEET_KEY_ENV in hostEnv();
    out["keyInWorkerEnv"] = await workerSees();
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.kill(process.pid, "SIGTERM");
}

const code = await main(new FakeRunService(), {
  node: "thor",
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
    const m = /fleet transport listening on [^:]+:(\d+)/.exec(line);
    if (m) fleetPort = Number(m[1]);
    if (line.includes("listening on") && line.includes("(pid")) {
      probe().catch((e: unknown) => {
        process.stdout.write(`${JSON.stringify({ error: String(e) })}\n`);
        process.kill(process.pid, "SIGTERM");
      });
    }
  },
});
process.exit(code);
