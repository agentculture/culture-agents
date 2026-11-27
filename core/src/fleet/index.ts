/**
 * The fleet transport, wired into the core (docs/d2/part-two-design.md, Decision 1). Off unless
 * configured (config.ts). In this task the transport serves `GET /v1/version` to authenticated
 * members and refuses every other path with `not_found`: the member routes (announce, remote calls)
 * are tasks t22 and t23. No local control route is reachable over the network.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { apiVersion } from "../contract/index.js";
import { sendError, sendJson } from "../daemon/http.js";
import { notFound } from "../daemon/errors.js";
import { heldSecret } from "../daemon/secrets.js";
import { version as coreVersion } from "../index.js";
import { FLEET_KEY_ENV } from "./cert.js";
import { loadFleetConfig, type FleetConfig } from "./config.js";
import { startFleetServer, type FleetServer } from "./transport.js";
import type { TrustEntry } from "./trust.js";

export { FLEET_KEY_ENV, certificateFor, fingerprint, fleetKeyText, newFleetKey, parseFleetKey } from "./cert.js";
export { FLEET_LISTEN_ENV, FleetConfigError, loadFleetConfig, parseListen, type FleetConfig } from "./config.js";
export { FleetCallError, fleetCall, startFleetServer, type FleetCallOptions, type FleetResponse, type FleetServer } from "./transport.js";
export { loadTrust, parseTrust, resolveTrustPath, TrustConfigError, type TrustEntry, type TrustList } from "./trust.js";

type Log = (line: string) => void;
type Env = Readonly<Record<string, string | undefined>>;

/**
 * The fleet configuration at start, after `takeSecrets`: null when the transport is off, undefined
 * when it is configured wrongly (reported; the core must not start). Never prints the key.
 */
export function prepareFleet(env: Env, err: Log, trustPath?: string): FleetConfig | null | undefined {
  try {
    return loadFleetConfig(env, heldSecret(FLEET_KEY_ENV), trustPath);
  } catch (e) {
    err(`culture-agents core: cannot start: fleet transport: ${(e as Error).message}`);
    return undefined;
  }
}

/** What the transport serves to a member in this task: the version route only. */
export function memberRoutes(node: string): (member: TrustEntry, req: IncomingMessage, res: ServerResponse) => void {
  return (_member, req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://fleet").pathname;
      if (req.method === "GET" && path === "/v1/version") sendJson(res, 200, "version", { api_version: apiVersion, core_version: coreVersion, node });
      else sendError(res, notFound(`No route ${path} over the fleet transport.`));
    } catch (e) {
      sendError(res, e);
    }
  };
}

/** Start the transport; null when it cannot bind (reported). */
export async function startFleet(config: FleetConfig, node: string, err: Log): Promise<FleetServer | null> {
  try {
    const server = await startFleetServer({ key: config.key, trustPath: config.trustPath, host: config.host, port: config.port, onRequest: memberRoutes(node), log: err });
    err(`culture-agents core: fleet transport listening on ${server.address.host}:${server.address.port}; ${config.trust.length} trusted member(s)`);
    return server;
  } catch (e) {
    err(`culture-agents core: cannot start: fleet transport: ${(e as Error).message}`);
    return null;
  }
}
