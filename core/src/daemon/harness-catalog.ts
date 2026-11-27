/**
 * The real harness registry as the run service's `HarnessCatalog` port. It lives in `daemon/`
 * so that `runs/` never imports a harness module, and it is loaded only by the daemon's bin
 * target (`main.ts`): `main()` itself keeps the empty catalog unless a catalog is passed.
 */
import { listHarnesses, loadHarnessConfig, type HarnessConfig } from "../harness/index.js";
import type { HarnessCatalog } from "../runs/ports.js";

/** A catalog over the registry for one configuration. Capability documents are measured per call. */
export function registryCatalog(config: HarnessConfig): HarnessCatalog {
  const entries = listHarnesses(config);
  return {
    list: () => entries,
    get: (id) => entries.find((entry) => entry.id === id),
    gateway: { harnesses: ["opencode"], url: hostView(config.opencode.baseUrl) },
    // Loaded on first use: the gateway client is not part of the daemon's start-up.
    reclaim: async (finishedRunIds) => (await import("../harness/reclaim.js")).reclaimSandboxes(config, finishedRunIds),
  };
}

/** The name a sandbox uses for the host it runs on. The core is on that host, where the name does not resolve. */
const SANDBOX_HOST_ALIAS = "host.openshell.internal";

/**
 * The gateway URL as the core itself reaches it. The harness is configured with the sandbox's view,
 * `http://host.openshell.internal:<port>/...`; from the host that is loopback on the same port.
 * Any other URL is used as it is.
 */
export function hostView(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== SANDBOX_HOST_ALIAS) return url;
    parsed.hostname = "127.0.0.1";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Load the harness configuration and build the catalog; throws `HarnessConfigError` on a bad configuration. */
export function loadRegistryCatalog(env: Readonly<Record<string, string | undefined>> = process.env): HarnessCatalog {
  return registryCatalog(loadHarnessConfig(env));
}
