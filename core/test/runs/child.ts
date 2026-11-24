// Child process for run-service tests: the real `main` with the built-in run service. The harness
// catalog is a fake built from FAKE_CATALOG (JSON list of FakeHarness); its entries point at the
// worker's fake driver module. Without FAKE_CATALOG the daemon uses its default (empty) catalog.
import { fileURLToPath } from "node:url";

import type { Capabilities, Capability } from "../../src/contract/index.js";
import { main } from "../../src/daemon/main.js";
import type { HarnessCatalog, HarnessEntry } from "../../src/runs/ports.js";
import type { FakeHarness } from "./support.js";

const FAKE_DRIVER = fileURLToPath(new URL("../../src/worker/fake-driver.js", import.meta.url));

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
      answer: deferred,
      continue_session: deferred,
      delegate: deferred,
      placement: deferred,
      reconnect: deferred,
      worktree_isolation: deferred,
    },
  };
}

function fakeCatalog(harnesses: FakeHarness[]): HarnessCatalog {
  const entries: HarnessEntry[] = harnesses.map((h) => ({
    id: h.id,
    capabilities: async () => capabilitiesOf(h),
    driver: { module: FAKE_DRIVER, options: { steps: h.steps } },
  }));
  return { list: () => entries, get: (id) => entries.find((e) => e.id === id) };
}

const spec = process.env["FAKE_CATALOG"];
const code = await main(undefined, {
  node: "spark",
  stderr: (line) => process.stderr.write(`${line}\n`),
  ...(spec !== undefined && { harnessCatalog: () => fakeCatalog(JSON.parse(spec) as FakeHarness[]) }),
});
process.exit(code);
