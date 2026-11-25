/**
 * Reclaiming sandboxes of finished runs. Kept out of the registry module (`index.ts`), which must
 * load no vendor package: this file pulls in the gateway client, so the daemon imports it only
 * when it first reclaims.
 */
import { openRunSandboxes } from "../sandbox/index.js";
import type { HarnessConfig } from "./config.js";

/**
 * Delete the sandboxes still on the gateway for these finished runs. A run's worker deletes its
 * own sandbox; this catches the ones it could not (the gateway did not confirm, or the worker was
 * killed). Only the given run ids are touched, so cores sharing a gateway leave each other alone.
 */
export async function reclaimSandboxes(
  config: HarnessConfig,
  finishedRunIds: string[],
  open: typeof openRunSandboxes = openRunSandboxes,
): Promise<string[]> {
  if (finishedRunIds.length === 0 || !config.gateway.tlsDir) return [];
  const sandboxes = await open({ image: config.image, providers: [], prefix: config.sandboxPrefix }, { gateway: config.gateway.endpoint, tlsDir: config.gateway.tlsDir });
  return sandboxes.sweep([], finishedRunIds);
}
