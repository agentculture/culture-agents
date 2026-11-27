/**
 * The fleet transport, wired into the core (docs/d2/part-two-design.md, Decisions 1 and 3). Off
 * unless configured (config.ts). It serves authenticated members `GET /v1/version`,
 * `POST /v1/fleet/announce` (members.ts) and `GET /v1/fleet/members`, and refuses every other path
 * with `not_found`: remote calls are task t23. No local control route is reachable over the network.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { apiVersion } from "../contract/index.js";
import type { Announcement } from "../contract/index.js";
import { checkBody, readJsonBody, sendError, sendJson } from "../daemon/http.js";
import { notFound } from "../daemon/errors.js";
import { heldSecret } from "../daemon/secrets.js";
import { version as coreVersion } from "../index.js";
import { FLEET_KEY_ENV, fingerprint } from "./cert.js";
import { loadFleetConfig, type FleetConfig } from "./config.js";
import { createAnnouncer, MAX_REPLY_BYTES } from "./announce.js";
import { createMemberList, SWEEP_MS, type Members } from "./members.js";
import { peersSource } from "./peers.js";
import { startFleetServer, type FleetServer } from "./transport.js";
import { trustSource, type TrustEntry } from "./trust.js";

export { FLEET_KEY_ENV, certificateFor, fingerprint, fleetKeyText, newFleetKey, parseFleetKey } from "./cert.js";
export { FLEET_LISTEN_ENV, FleetConfigError, loadFleetConfig, parseListen, type FleetConfig } from "./config.js";
export { FleetCallError, fleetCall, startFleetServer, type FleetCallOptions, type FleetResponse, type FleetServer } from "./transport.js";
export { ANNOUNCE_INTERVAL_MS, createMemberList, memberListOff, SILENCE_MS, SWEEP_MS, type Members } from "./members.js";
export { loadPeers, parsePeers, resolvePeersPath, type PeerAddress } from "./peers.js";
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

/** What the transport serves to a member: the version route, the announce route and the member list. */
export function memberRoutes(node: string, members?: Members): (member: TrustEntry, req: IncomingMessage, res: ServerResponse) => void {
  return (member, req, res) => {
    serveMember(node, members, member, req, res).catch((e: unknown) => sendError(res, e));
  };
}

async function serveMember(node: string, members: Members | undefined, member: TrustEntry, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://fleet").pathname;
  const route = `${req.method ?? ""} ${path}`;
  if (route === "GET /v1/version") return sendJson(res, 200, "version", { api_version: apiVersion, core_version: coreVersion, node });
  if (members && route === "POST /v1/fleet/announce") return announced(members, member, req, res);
  if (members && route === "GET /v1/fleet/members") return sendJson(res, 200, "fleet", members.view());
  throw notFound(`No route ${path} over the fleet transport.`);
}

/** An announcement from an authenticated member: listed (200, this core's own announcement), or refused (409, `announce_refusal`). */
async function announced(members: Members, member: TrustEntry, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, MAX_REPLY_BYTES);
  checkBody("fleet#announcement", body);
  const receipt = members.receive(member, body as Announcement);
  if (!receipt.ok) return sendJson(res, 409, "fleet#announce_refusal", { code: "conflict", message: `Announcement refused: ${receipt.reason}.`, retryable: receipt.retryable });
  return sendJson(res, 200, "fleet#announcement", members.announcement("up"));
}

export interface Fleet {
  readonly members: Members;
  /** Listen, then announce every interval and sweep every second. False when it cannot bind (reported). */
  start(): Promise<boolean>;
  /** Announce `leaving`, stop the sweep, close the listener. Idempotent. */
  stop(): Promise<void>;
  /** The bound address, once started. */
  address(): { host: string; port: number } | null;
  /** One announcement round now, besides the interval's (tests, and an operator's reload later). */
  announce(): Promise<void>;
}

export interface FleetTiming {
  now?: () => number;
  intervalMs?: number;
  silenceMs?: number;
  sweepMs?: number;
}

/** The fleet of this core: its member list, its listener and its announcer. Nothing runs before `start`. */
export function createFleet(config: FleetConfig, node: string, err: Log, timing: FleetTiming = {}): Fleet {
  const members = createMemberList({ node, fingerprint: fingerprint(config.key), log: err, ...timing });
  const trust = trustSource(config.trustPath, (m) => err(`culture-agents core: fleet: ${m}`));
  const announcer = createAnnouncer({
    key: config.key,
    trust: () => trust().list,
    peers: peersSource(config.peersPath, (m) => err(`culture-agents core: fleet: ${m}`)),
    members,
    log: err,
    ...(timing.intervalMs !== undefined && { intervalMs: timing.intervalMs }),
  });
  let server: FleetServer | null = null;
  let sweep: NodeJS.Timeout | null = null;
  return {
    members,
    address: () => server?.address ?? null,
    announce: () => announcer.round(),
    async start() {
      try {
        server = await startFleetServer({ key: config.key, trustPath: config.trustPath, host: config.host, port: config.port, onRequest: memberRoutes(node, members), log: err });
      } catch (e) {
        err(`culture-agents core: cannot start: fleet transport: ${(e as Error).message}`);
        return false;
      }
      err(`culture-agents core: fleet transport listening on ${server.address.host}:${server.address.port}; ${config.trust.length} trusted member(s)`);
      sweep = setInterval(() => members.sweep(), timing.sweepMs ?? SWEEP_MS);
      sweep.unref();
      announcer.start();
      return true;
    },
    async stop() {
      if (sweep) clearInterval(sweep);
      await announcer.stop();
      await server?.stop();
    },
  };
}
