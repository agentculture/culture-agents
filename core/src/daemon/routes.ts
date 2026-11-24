import type { IncomingMessage, ServerResponse } from "node:http";

import {
  API_VERSION_HEADER,
  apiVersion,
  isCompatible,
  parseApiVersion,
  validate,
  type RunState,
  type SchemaName,
  type SubmitRequest,
} from "../contract/index.js";
import { matchAllowlist, type AllowlistState } from "./allowlist.js";
import { ControlError, invalid, notFound, unsupported } from "./errors.js";
import { checkBody, readJsonBody, sendJson } from "./http.js";
import type { RunService } from "./ports.js";
import { streamAttach } from "./sse.js";

export interface RouteContext {
  service: RunService;
  allowlist: () => AllowlistState;
  node: string;
  coreVersion: string;
  now: () => Date;
  keepaliveMs: number;
  /** Aborted when the daemon shuts down, so open streams end. */
  shutdown: AbortSignal;
}

interface Match {
  id: string;
  methods: string[];
  params: Record<string, string>;
}

type Pattern = readonly [id: string, method: string, ...segments: string[]];

// Every route in contract/api.json. `:name` segments are path parameters.
const PATTERNS: readonly Pattern[] = [
  ["version", "GET", "v1", "version"],
  ["agents.list", "GET", "v1", "agents"],
  ["agents.status", "GET", "v1", "agents", ":agent_id"],
  ["harnesses.list", "GET", "v1", "harnesses"],
  ["harnesses.show", "GET", "v1", "harnesses", ":harness"],
  ["runs.submit", "POST", "v1", "runs"],
  ["runs.list", "GET", "v1", "runs"],
  ["runs.show", "GET", "v1", "runs", ":run_id"],
  ["runs.attach", "GET", "v1", "runs", ":run_id", "attach"],
  ["runs.logs", "GET", "v1", "runs", ":run_id", "events"],
  ["runs.result", "GET", "v1", "runs", ":run_id", "result"],
  ["runs.steer", "POST", "v1", "runs", ":run_id", "steer"],
  ["runs.cancel", "POST", "v1", "runs", ":run_id", "cancel"],
  ["runs.pause", "POST", "v1", "runs", ":run_id", "pause"],
  ["runs.resume", "POST", "v1", "runs", ":run_id", "resume"],
  ["runs.answer", "POST", "v1", "runs", ":run_id", "answer"],
];

/** Deferred control routes: always `unsupported`, naming the capability. Value is the request schema. */
const DEFERRED = {
  "runs.pause": ["pause", "control-action#pause_request"],
  "runs.resume": ["resume", "control-action#resume_request"],
  "runs.answer": ["answer", "control-action#answer_request"],
} as const;

const PARAM_SCHEMAS: Record<string, SchemaName> = {
  agent_id: "common#mesh_id",
  harness: "common#harness_id",
  run_id: "common#run_id",
};

/** Match a path against the route table. `null` means no route has this path. */
function matchPath(pathname: string, method: string): Match | null {
  const parts = pathname.split("/").filter((p, i) => !(i === 0 && p === ""));
  const methods = new Set<string>();
  let hit: Match | null = null;
  for (const [id, m, ...segs] of PATTERNS) {
    if (segs.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = segs.every((seg, i) => {
      const part = parts[i] ?? "";
      if (seg.startsWith(":")) {
        params[seg.slice(1)] = decodeURIComponent(part);
        return part !== "";
      }
      return seg === part;
    });
    if (!ok) continue;
    methods.add(m);
    if (m === method && !hit) hit = { id, methods: [], params };
  }
  if (hit) return hit;
  if (methods.size > 0) return { id: "", methods: [...methods], params: {} };
  return null;
}

function checkVersionHeader(req: IncomingMessage): void {
  const raw = req.headers[API_VERSION_HEADER.toLowerCase()];
  if (raw === undefined) return;
  const client = Array.isArray(raw) ? raw.join(",") : raw;
  if (isCompatible(client, apiVersion)) return;
  if (parseApiVersion(client) === null) {
    // The contract only defines incompatible_version with a MAJOR.MINOR client version; see the report.
    throw invalid(`The ${API_VERSION_HEADER} header must be MAJOR.MINOR, for example ${apiVersion}.`, API_VERSION_HEADER);
  }
  throw new ControlError("incompatible_version", `This core speaks API ${apiVersion}, which is not compatible with client API ${client}; upgrade the older side.`, {
    client_api_version: client,
    server_api_version: apiVersion,
  });
}

function parseIntParam(url: URL, name: string, min: number, max: number, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw invalid(`Query parameter ${name} must be an integer from ${min} to ${max}.`, name);
  return Number(raw);
}

function optionalCursor(url: URL, req: IncomingMessage): number {
  if (url.searchParams.has("after")) return parseIntParam(url, "after", 0, Number.MAX_SAFE_INTEGER, 0);
  const last = req.headers["last-event-id"];
  if (typeof last === "string" && /^\d+$/.test(last)) return Number(last);
  return 0;
}

/** Everything the control routes check before the service is asked: id format is done; run must exist. */
async function requireRun(ctx: RouteContext, runId: string) {
  const run = await ctx.service.getRun(runId);
  if (!run) throw notFound(`No run ${runId}.`, { run_id: runId });
  return run;
}

function checkSubmit(ctx: RouteContext, body: unknown): SubmitRequest {
  checkBody("control-action#submit_request", body);
  const request = body as SubmitRequest;
  if (request.deadline !== undefined && Date.parse(request.deadline) <= ctx.now().getTime()) {
    throw invalid("The deadline must be later than the core's clock.", "/deadline");
  }
  // Allow-list: before any worker or sandbox exists. Dispatch is denied by default.
  const repo = matchAllowlist(ctx.allowlist().entries, request);
  if (repo === null) {
    throw new ControlError("denied", `No allow-list entry permits agent ${request.agent_id} with harness ${request.harness} on ${request.repo}; the operator must add one to the allow-list file.`);
  }
  return { ...request, repo };
}

/** Handle one request. Throws `ControlError` for refusals; the caller renders it. */
export async function handle(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const isVersion = url.pathname === "/v1/version";
  // The version route is never refused for version reasons; every other request is checked before anything else.
  if (!isVersion) checkVersionHeader(req);

  const match = matchPath(url.pathname, method);
  if (!match) throw notFound(`No route ${url.pathname}.`);
  if (match.id === "") throw invalid(`Method ${method} is not allowed on ${url.pathname}; use ${match.methods.join(" or ")}.`);

  for (const [name, value] of Object.entries(match.params)) {
    const schema = PARAM_SCHEMAS[name];
    if (schema && !validate(schema, value).ok) throw invalid(`Path parameter ${name} is malformed.`, name);
  }
  const p = match.params;
  const svc = ctx.service;

  switch (match.id) {
    case "version":
      return sendJson(res, 200, "version", { api_version: apiVersion, core_version: ctx.coreVersion, node: ctx.node });
    case "agents.list":
      return sendJson(res, 200, "agent#agent_list", await svc.listAgents());
    case "agents.status": {
      const agent = await svc.getAgent(p["agent_id"] ?? "");
      if (!agent) throw notFound(`No agent ${p["agent_id"]}.`);
      return sendJson(res, 200, "agent", agent);
    }
    case "harnesses.list":
      return sendJson(res, 200, "capabilities#capabilities_list", { harnesses: await svc.listHarnesses() });
    case "harnesses.show": {
      const harness = await svc.getHarness(p["harness"] ?? "");
      if (!harness) throw notFound(`No harness ${p["harness"]}.`);
      return sendJson(res, 200, "capabilities", harness);
    }
    case "runs.submit": {
      const request = checkSubmit(ctx, await readJsonBody(req));
      return sendJson(res, 201, "control-action#submit_response", { run: await svc.submit(request) });
    }
    case "runs.list": {
      const state = url.searchParams.get("state");
      if (state !== null && !validate("run#state", state).ok) throw invalid("Query parameter state is not a run state.", "state");
      const agent = url.searchParams.get("agent_id");
      if (agent !== null && !validate("common#mesh_id", agent).ok) throw invalid("Query parameter agent_id is malformed.", "agent_id");
      const query = { limit: parseIntParam(url, "limit", 1, 500, 50), ...(state !== null && { state: state as RunState }), ...(agent !== null && { agent_id: agent }) };
      return sendJson(res, 200, "run#run_list", { runs: await svc.listRuns(query) });
    }
    case "runs.show":
      return sendJson(res, 200, "run", await requireRun(ctx, p["run_id"] ?? ""));
    case "runs.attach": {
      const run = await requireRun(ctx, p["run_id"] ?? "");
      const after = optionalCursor(url, req);
      if (after > run.cursor) throw invalid(`after (${after}) is beyond the run's newest cursor (${run.cursor}).`, "after");
      return streamAttach(ctx, res, run.id, after);
    }
    case "runs.logs": {
      const runId = p["run_id"] ?? "";
      const run = await requireRun(ctx, runId);
      const after = parseIntParam(url, "after", 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = parseIntParam(url, "limit", 1, 5000, 500);
      if (after > run.cursor) throw invalid(`after (${after}) is beyond the run's newest cursor (${run.cursor}).`, "after");
      const page = await svc.readEvents(runId, after, limit);
      if (!page) throw notFound(`No run ${runId}.`, { run_id: runId });
      return sendJson(res, 200, "event#event_page", page);
    }
    case "runs.result":
      await requireRun(ctx, p["run_id"] ?? "");
      return sendJson(res, 200, "run#run_result", await svc.getResult(p["run_id"] ?? ""));
    case "runs.steer":
    case "runs.cancel": {
      const runId = p["run_id"] ?? "";
      await requireRun(ctx, runId);
      const body = await readJsonBody(req);
      if (match.id === "runs.steer") {
        checkBody("control-action#steer_request", body);
        return sendJson(res, 202, "control-action#accepted_response", { action: await svc.steer(runId, body as never) });
      }
      checkBody("control-action#cancel_request", body);
      return sendJson(res, 202, "control-action#accepted_response", { action: await svc.cancel(runId, body as never) });
    }
    default: {
      const deferred = DEFERRED[match.id as keyof typeof DEFERRED];
      if (!deferred) throw new ControlError("internal", "Route table and handlers disagree.");
      await requireRun(ctx, p["run_id"] ?? "");
      checkBody(deferred[1], await readJsonBody(req));
      throw unsupported(deferred[0], `The ${deferred[0]} action is not supported in this API version.`);
    }
  }
}
