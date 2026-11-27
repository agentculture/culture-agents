/**
 * The control socket's remote-run routes (contract 3.2): the local operator submits, shows, attaches
 * to, steers and cancels a run on another fleet member, and reads a member's aliases. Each request is
 * checked here against its schema, then sent to the member over the fleet transport (fleet/remote.ts),
 * which answers with the same shapes. The caller chooses the member: the node of the agent id for a
 * submit, the node of the run id afterwards, the `member` query for aliases. Nothing schedules, and
 * nothing about a remote run is stored on this core.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { parseMeshId, parseScopedId, validate, type RemoteSubmitRequest } from "../contract/index.js";
import { streamRemoteAttach } from "../fleet/remote-attach.js";
import type { Remote } from "../fleet/remote.js";
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
