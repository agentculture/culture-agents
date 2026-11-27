/**
 * The control socket's remote-run routes (contract 3.2): the local operator submits, shows, attaches
 * to, steers and cancels a run on another fleet member, and reads a member's aliases. Each request is
 * checked here against its schema, then sent to the member over the fleet transport (fleet/remote.ts),
 * which answers with the same shapes. The caller chooses the member: the node of the agent id for a
 * submit, the node of the run id afterwards, the `member` query for aliases. Nothing schedules, and
 * nothing about a remote run is stored on this core.
 *
 * 3.3 (t26, fleet/bundle.ts): a remote run's stored events, its result and its branch as a git
 * bundle, read from the member that executes it. Events and bundle arrive unredacted and leave with
 * the sensitivity header; only a member that announced 3.3 is asked.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { parseMeshId, parseScopedId, validate, type RemoteSubmitRequest } from "../contract/index.js";
import { markUnredacted, relayRunBundle, REMOTE_RESULTS_SINCE, REMOTE_RESULTS_WHAT } from "../fleet/bundle.js";
import { MAX_PAGE_BYTES, streamRemoteAttach } from "../fleet/remote-attach.js";
import { Unreached, type Remote } from "../fleet/remote.js";
import { MAX_MEMBER_PAGE } from "../fleet/serve-runs.js";
import { invalid, unsupported } from "./errors.js";
import { checkBody, readJsonBody, sendJson } from "./http.js";

export interface FleetRouteCall {
  remote: Remote | null;
  /** This core's node name. */
  node: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The run id of the path, already checked against `common#run_id`; empty for the others. */
  runId: string;
  keepaliveMs: number;
  shutdown: AbortSignal;
}

function remoteOf(c: FleetRouteCall): Remote {
  if (c.remote === null) throw unsupported("placement", "The fleet transport is off on this core (CULTURE_AGENTS_FLEET_LISTEN is not set), so it cannot reach another member.");
  return c.remote;
}

/** The member a run id names: its node, which must not be this core's. */
function memberOfRun(c: FleetRouteCall): string {
  const node = parseScopedId(c.runId)?.node ?? "";
  if (node === c.node) throw invalid(`Run ${c.runId} is on this core; use /v1/runs/${encodeURIComponent(c.runId)} for it.`, "run_id");
  return node;
}

const runPath = (runId: string, rest = ""): string => `/v1/fleet/runs/${encodeURIComponent(runId)}${rest}`;

export async function fleetRunsSubmit(c: FleetRouteCall): Promise<void> {
  const remote = remoteOf(c);
  const body = await readJsonBody(c.req);
  checkBody("remote#submit_request", body);
  const request = body as RemoteSubmitRequest;
  const node = parseMeshId(request.agent_id)?.node ?? "";
  if (node === c.node) throw invalid(`Agent ${request.agent_id} is on this core; submit to it with POST /v1/runs and a repository path.`, "/agent_id");
  const sent = await remote.request(node, { method: "POST", path: "/v1/fleet/runs", body: request, status: 201, schema: "remote#submit_response" });
  return sendJson(c.res, 201, "remote#submit_response", sent);
}

export async function fleetRunsShow(c: FleetRouteCall): Promise<void> {
  const remote = remoteOf(c);
  const run = await remote.request(memberOfRun(c), { method: "GET", path: runPath(c.runId), status: 200, schema: "remote" });
  return sendJson(c.res, 200, "remote", run);
}

/**
 * The unreachable view (3.3): the member's answer, or `unreachable` when it does not answer this
 * caller. Computed on each read from one GET; nothing is stored or written, here or on the member.
 * Any other failure (a refusal, a bad answer) is relayed as the error it is, not as unreachable.
 */
export async function fleetRunsView(c: FleetRouteCall): Promise<void> {
  const remote = remoteOf(c);
  const node = memberOfRun(c);
  try {
    const run = await remote.request(node, { method: "GET", path: runPath(c.runId), status: 200, schema: "remote" });
    return sendJson(c.res, 200, "reachability", { run_id: c.runId, node, view: "reachable", run });
  } catch (e) {
    if (!(e instanceof Unreached)) throw e;
    return sendJson(c.res, 200, "reachability", { run_id: c.runId, node, view: "unreachable", unreachable: { reason: e.reason, detail: e.body.message } });
  }
}

export async function fleetRunsControl(c: FleetRouteCall, kind: "steer" | "cancel"): Promise<void> {
  const remote = remoteOf(c);
  const node = memberOfRun(c);
  const body = await readJsonBody(c.req);
  checkBody(`control-action#${kind}_request`, body);
  const accepted = await remote.request(node, { method: "POST", path: runPath(c.runId, `/${kind}`), body, status: 202, schema: "control-action#accepted_response" });
  return sendJson(c.res, 202, "control-action#accepted_response", accepted);
}

export async function fleetRunsAttach(c: FleetRouteCall): Promise<void> {
  const remote = remoteOf(c);
  const node = memberOfRun(c);
  const raw = c.url.searchParams.get("after") ?? c.req.headers["last-event-id"] ?? "0";
  const after = Array.isArray(raw) ? raw.join(",") : raw;
  if (!/^\d{1,16}$/.test(after) || Number(after) > Number.MAX_SAFE_INTEGER) throw invalid("after must be an event cursor (an integer of 0 or more).", "after");
  return streamRemoteAttach({ remote, node, runId: c.runId, after: Number(after), res: c.res, keepaliveMs: c.keepaliveMs, shutdown: c.shutdown });
}

export async function fleetAliases(c: FleetRouteCall): Promise<void> {
  const remote = remoteOf(c);
  const member = c.url.searchParams.get("member");
  if (member === null || !validate("common#node", member).ok) throw invalid("Query parameter member must name a fleet member (a node name).", "member");
  if (member === c.node) throw invalid(`${member} is this core; its aliases are in its own fleet alias file.`, "member");
  const list = await remote.request(member, { method: "GET", path: "/v1/fleet/aliases", status: 200, schema: "remote#alias_list" });
  return sendJson(c.res, 200, "remote#alias_list", list);
}

/** An optional integer query parameter from 0 (or `min`) to `max`. */
function queryInt(c: FleetRouteCall, name: string, min: number, max: number, fallback: number): number {
  const raw = c.url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,16}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw invalid(`Query parameter ${name} must be an integer from ${min} to ${max}.`, name);
  return Number(raw);
}

const since33 = { since: REMOTE_RESULTS_SINCE, what: REMOTE_RESULTS_WHAT } as const;

export async function fleetRunsLogs(c: FleetRouteCall): Promise<void> {
  const remote = remoteOf(c);
  const node = memberOfRun(c);
  const after = queryInt(c, "after", 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = queryInt(c, "limit", 1, MAX_MEMBER_PAGE, MAX_MEMBER_PAGE);
  const path = runPath(c.runId, `/events?after=${after}&limit=${limit}`);
  const page = await remote.request(node, { method: "GET", path, status: 200, schema: "event#event_page", maxBytes: MAX_PAGE_BYTES, ...since33 });
  markUnredacted(c.res);
  return sendJson(c.res, 200, "event#event_page", page);
}

export async function fleetRunsResult(c: FleetRouteCall): Promise<void> {
  const remote = remoteOf(c);
  const result = await remote.request(memberOfRun(c), { method: "GET", path: runPath(c.runId, "/result"), status: 200, schema: "run#run_result", maxBytes: MAX_PAGE_BYTES, ...since33 }); // a summary may pass 1 MiB
  return sendJson(c.res, 200, "run#run_result", result);
}

export async function fleetRunsBundle(c: FleetRouteCall): Promise<void> {
  const remote = remoteOf(c);
  return relayRunBundle(remote, memberOfRun(c), c.runId, c.res);
}
