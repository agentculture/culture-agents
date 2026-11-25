/**
 * The harness port of the run service. The run service knows a harness only through this shape:
 * its id, its measured capability document, and the compiled driver module a worker loads for it.
 * The real catalog lives elsewhere and is connected by `daemon/main.ts`; nothing here imports it.
 */
import type { Capabilities } from "../contract/index.js";

export interface HarnessEntry {
  /** The harness id as submitted (`harness` in the request), for example `opencode`. */
  id: string;
  /** The capability document as this core drives the harness, measured now (README: honest refusal). */
  capabilities(): Promise<Capabilities>;
  driver: {
    /** Absolute path of a compiled ES module exporting `createDriver`. */
    module: string;
    /** JSON-serializable options passed to `createDriver` through the run's `driver.json`. */
    options: Record<string, unknown>;
  };
}

export interface HarnessCatalog {
  list(): HarnessEntry[];
  get(id: string): HarnessEntry | undefined;
  /**
   * Delete whatever the harnesses left running for these finished runs (a sandbox whose deletion
   * failed, or whose worker was killed). Returns the run ids something was deleted for. Optional:
   * a catalog without workspaces of its own has nothing to reclaim.
   */
  reclaim?(finishedRunIds: string[]): Promise<string[]>;
}

/** A catalog with no harness: every submit is refused with `not_found` for an unknown harness. */
export function emptyCatalog(): HarnessCatalog {
  return { list: () => [], get: () => undefined };
}
