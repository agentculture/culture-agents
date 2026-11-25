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
  return { list: () => entries, get: (id) => entries.find((entry) => entry.id === id) };
}

/** Load the harness configuration and build the catalog; throws `HarnessConfigError` on a bad configuration. */
export function loadRegistryCatalog(env: Readonly<Record<string, string | undefined>> = process.env): HarnessCatalog {
  return registryCatalog(loadHarnessConfig(env));
}
