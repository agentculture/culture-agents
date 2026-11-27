// Child process for run-service tests: the real `main` with the built-in run service. The harness
// catalog is a fake built from FAKE_CATALOG (JSON list of FakeHarness); its entries point at the
// worker's fake driver module. Without FAKE_CATALOG the daemon uses its default (empty) catalog.
// SIGUSR2 throws from a callback, so a test can drive the fatal-error handlers. SUBMIT_FAULT is below.
import { fileURLToPath } from "node:url";

import type { Capabilities, Capability } from "../../src/contract/index.js";
import { main } from "../../src/daemon/main.js";
import type { HarnessCatalog, HarnessEntry } from "../../src/runs/ports.js";
import type { FakeHarness } from "./support.js";

const FAKE_DRIVER = fileURLToPath(new URL("../../src/worker/fake-driver.js", import.meta.url));
const STUB_DRIVER = fileURLToPath(new URL("../../src/harness/stub/index.js", import.meta.url));
const STUB_OPTIONS = { ref: "HEAD", identity: { name: "culture-agents run", email: "runs@culture-agents.invalid" }, stepMs: 30 };

const yes: Capability = { supported: true, reason: null, caveats: [] };
const no = (reason: string) => ({ supported: false as const, reason, caveats: [] });

export function capabilitiesOf(harness: FakeHarness): Capabilities {
  const deferred = no("deferred beyond D1");
  return {
    harness: harness.id,
    available: true,
    version: "0.0.0-test",
    transport: "scripted fake driver in a worker process",
    capabilities: {
      submit: yes,
      stream: yes,
      steer: harness.steer === false ? no("this fake declares steer unsupported") : yes,
      cancel: yes,
      pause: deferred,
      resume: deferred,
      answer: harness.ask === true ? yes : no("this fake's driver has no ask path"),
      continue_session: deferred,
      delegate: deferred,
      placement: deferred,
      reconnect: yes,
      worktree_isolation: { supported: true, reason: null, caveats: ["a clone per run; never a host worktree"] },
    },
  };
}

function fakeCatalog(harnesses: FakeHarness[]): HarnessCatalog {
  const entries: HarnessEntry[] = harnesses.map((h) => ({
    id: h.id,
    capabilities: () => Promise.resolve(capabilitiesOf(h)),
    driver: h.stub === true ? { module: STUB_DRIVER, options: STUB_OPTIONS } : { module: FAKE_DRIVER, options: { steps: h.steps } },
  }));
  // FAKE_GATEWAY_URL: a loopback test server standing in for the model gateway; every fake harness uses it.
  const url = process.env["FAKE_GATEWAY_URL"];
  return { list: () => entries, get: (id) => entries.find((e) => e.id === id), ...(url !== undefined && { gateway: { harnesses: harnesses.map((h) => h.id), url, timeoutMs: 300 } }) };
}

process.on("SIGUSR2", () => {
  throw new Error("boom from a callback");
});

const spec = process.env["FAKE_CATALOG"];
// SUBMIT_FAULT=<step> kills this core (SIGKILL, no cleanup) when a submit reaches that step.
const faultAt = process.env["SUBMIT_FAULT"];
// RECLAIM_INTERVAL_MS=<n> runs the daemon's housekeeping every n ms.
const housekeepMs = process.env["RECLAIM_INTERVAL_MS"];
// TEST_NODE: the node name of this core (default thor); a second core of a fleet test needs another.
const code = await main(undefined, {
  node: process.env["TEST_NODE"] ?? "thor",
  stderr: (line) => process.stderr.write(`${line}\n`),
  fatalHandlers: true,
  ...(housekeepMs !== undefined && { reclaimIntervalMs: Number(housekeepMs) }),
  ...(faultAt !== undefined && {
    submitFault: (step: string) => {
      if (step === faultAt) process.kill(process.pid, "SIGKILL");
    },
  }),
  ...(spec !== undefined && { harnessCatalog: () => fakeCatalog(JSON.parse(spec) as FakeHarness[]) }),
});
process.exit(code);
