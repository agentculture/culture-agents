/**
 * The fleet transport, wired into the core (docs/d2/part-two-design.md, Decisions 1, 3, 4 and 5).
 * Off unless configured (config.ts). It serves authenticated members `GET /v1/version`,
 * `POST /v1/fleet/announce` (members.ts), `GET /v1/fleet/members`, and the remote-run routes of
 * serve-runs.ts (3.2), and refuses every other path with `not_found`. No local control route is
 * reachable over the network: the remote-run routes have their own checks and act only on the runs
 * the calling member submitted. The calling side of remote runs is remote.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";

import { apiVersion as buildVersion } from "../contract/index.js";
import type { Announcement } from "../contract/index.js";
import { checkBody, readJsonBody, sendError, sendJson } from "../daemon/http.js";
import { notFound } from "../daemon/errors.js";
import { heldSecret } from "../daemon/secrets.js";
import { version as coreVersion } from "../index.js";
import { FLEET_KEY_ENV, fingerprint } from "./cert.js";
import { loadFleetConfig, type FleetConfig } from "./config.js";
import { loadAliases } from "./aliases.js";
import { createAnnouncer, MAX_REPLY_BYTES } from "./announce.js";
import { createMemberList, SWEEP_MS, type Members } from "./members.js";
import { peersSource } from "./peers.js";
import { createRemote, type Remote } from "./remote.js";
import { checkPeerVersion, serveRuns, type RunsDeps } from "./serve-runs.js";
import { startFleetServer, type FleetServer } from "./transport.js";
import { trustSource, type TrustEntry } from "./trust.js";

export { FLEET_KEY_ENV, certificateFor, fingerprint, fleetKeyText, newFleetKey, parseFleetKey } from "./cert.js";
export { FLEET_LISTEN_ENV, FleetConfigError, loadFleetConfig, parseListen, type FleetConfig } from "./config.js";
export { FleetCallError, fleetCall, startFleetServer, type FleetCallOptions, type FleetResponse, type FleetServer } from "./transport.js";
export { ANNOUNCE_INTERVAL_MS, createMemberList, memberListOff, SILENCE_MS, SWEEP_MS, type Members } from "./members.js";
export { loadPeers, parsePeers, resolvePeersPath, type PeerAddress } from "./peers.js";
export { aliasList, loadAliases, resolveAlias, resolveAliasesPath, type AliasState } from "./aliases.js";
export { createRemote, REMOTE_RUNS_SINCE, type Remote, type RemoteRequest } from "./remote.js";
export { MAX_MEMBER_PAGE, remoteView, type RunsDeps } from "./serve-runs.js";
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

/**
 * What the transport serves to a member: the version route, the announce route, the member list and,
 * with `runs`, the remote-run routes. `reported` is the API version this core reports (tests use an
 * older MINOR to stand for a core that has not been upgraded).
 */
export function memberRoutes(node: string, members?: Members, runs?: RunsDeps, reported = buildVersion): (member: TrustEntry, req: IncomingMessage, res: ServerResponse) => void {
  return (member, req, res) => {
    serveMember({ node, members, runs, reported }, member, req, res).catch((e: unknown) => sendError(res, e));
  };
}

interface Served {
  node: string;
  members: Members | undefined;
  runs: RunsDeps | undefined;
  reported: string;
}

async function serveMember(s: Served, member: TrustEntry, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "https://fleet.invalid") // a base to parse the path against; nothing is fetched;
  const route = `${req.method ?? ""} ${url.pathname}`;
  if (route === "GET /v1/version") return sendJson(res, 200, "version", { api_version: s.reported, core_version: coreVersion, node: s.node });
  if (s.runs && (await serveRuns(s.runs, member, req, res, url))) return;
  checkPeerVersion(req, s.reported, false);
  if (s.members && route === "POST /v1/fleet/announce") return announced(s.members, member, req, res);
  if (s.members && route === "GET /v1/fleet/members") return sendJson(res, 200, "fleet", s.members.view());
  throw notFound(`No route ${url.pathname} over the fleet transport.`);
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
  /** Calls to other members on behalf of the local control socket (remote.ts). */
  readonly remote: Remote;
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
  /** The API version this core reports and sends. Default: this build's; tests use an older MINOR. */
  apiVersion?: string;
}

/** What the remote-run routes need from the core: its run service, allow-list and clock. */
export type FleetRuns = Omit<RunsDeps, "node" | "apiVersion" | "aliases"> & { aliases?: RunsDeps["aliases"] };

/**
 * The fleet of this core: its member list, its listener, its announcer and its remote calls. With
 * `runs`, members may submit and control their own runs here. Nothing runs before `start`.
 */
export function createFleet(config: FleetConfig, node: string, err: Log, timing: FleetTiming = {}, runs?: FleetRuns): Fleet {
  const reported = timing.apiVersion ?? buildVersion;
  const trust = trustSource(config.trustPath, (m) => err(`culture-agents core: fleet: ${m}`));
  const members = createMemberList({ node, fingerprint: fingerprint(config.key), log: err, trust: () => trust().list, ...timing });
  const announcer = createAnnouncer({
    key: config.key,
    trust: () => trust().list,
    peers: peersSource(config.peersPath, (m) => err(`culture-agents core: fleet: ${m}`)),
    members,
    log: err,
    ...(timing.intervalMs !== undefined && { intervalMs: timing.intervalMs }),
  });
  const remote = createRemote({ key: config.key, trust: () => trust().list, members, addressOf: (n) => announcer.addressOf(n), apiVersion: reported });
  const aliasesPath = join(dirname(config.trustPath), "aliases.json");
  const served = runs && { ...runs, node, apiVersion: reported, aliases: runs.aliases ?? (() => loadAliases(aliasesPath)) };
  let server: FleetServer | null = null;
  let sweep: NodeJS.Timeout | null = null;
  return {
    members,
    remote,
    address: () => server?.address ?? null,
    announce: () => announcer.round(),
    async start() {
      try {
        server = await startFleetServer({ key: config.key, trustPath: config.trustPath, host: config.host, port: config.port, onRequest: memberRoutes(node, members, served, reported), log: err });
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
