/**
 * Remote runs on the executing core (docs/d2/part-two-design.md, Decisions 4 and 5; contract 3.2):
 * the routes the fleet transport serves an authenticated member besides version, announce and the
 * member list. Each request comes from a member the transport authenticated against the trust list
 * before any request byte was read (transport.ts); `member` is that member's trust-list entry.
 *
 * - `POST /v1/fleet/runs`: a submit. The repository is an alias this host defines (aliases.ts),
 *   resolved to an allow-listed path; the allow-list applies to that path unchanged. A named
 *   `base_commit` the aliased checkout lacks is refused `invalid`, and nothing is fetched; without
 *   one the run starts from this host's HEAD at acceptance, which the response returns. The deadline
 *   arrives as a duration and becomes an absolute time on this core's clock (spec c42). The run's
 *   submitter is the member, `{ kind: "member", node }`, never a request field.
 * - `GET /v1/fleet/runs/{id}`, `GET .../events`, `POST .../steer`, `POST .../cancel`: only on a run
 *   that this member submitted (`denied` otherwise). The local operator keeps full control of every
 *   run through the control socket; nothing here widens what a member may do.
 * - `GET /v1/fleet/aliases`: this host's aliases and what the allow-list permits on each, no path.
 *
 * Every one of these routes requires the `Agents-Api-Version` header and serves a caller of the same
 * MAJOR whatever its MINOR (contract/README.md, "Calls between cores"). Bodies are capped (1 MiB).
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  API_VERSION_HEADER,
  isPeerCompatible,
  parseApiVersion,
  parseMeshId,
  validate,
  type RemoteRun,
  type RemoteSubmitRequest,
  type Run,
  type SubmitRequest,
  type Submitter,
} from "../contract/index.js";
import { matchAllowlist, type AllowlistState } from "../daemon/allowlist.js";
import { ControlError, invalid, notFound, unsupported } from "../daemon/errors.js";
import { checkBody, readJsonBody, sendJson } from "../daemon/http.js";
import type { RunService } from "../daemon/ports.js";
import { hostEnv, runCommand } from "../sandbox/host-command.js";
import { aliasList, resolveAlias, type AliasState } from "./aliases.js";
import type { TrustEntry } from "./trust.js";

/** The most events one page over the fleet transport carries (the caller asks for fewer). */
export const MAX_MEMBER_PAGE = 50;

export interface RunsDeps {
  service: RunService;
  allowlist: () => AllowlistState;
  aliases: () => AliasState;
  /** This core's node name. */
  node: string;
  /** The API version this core reports (api.json; tests inject an older MINOR). */
  apiVersion: string;
  now: () => Date;
  /** Whether `repo` holds commit `sha`. Default: `git cat-file -e`. */
  hasCommit?: (repo: string, sha: string) => Promise<boolean>;
}

interface Call {
  d: RunsDeps;
  member: TrustEntry;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  runId: string;
}

async function gitHasCommit(repo: string, sha: string): Promise<boolean> {
  // `sha` is a 40-hex commit id (checked by the schema), never an option or a ref expression.
  const res = await runCommand("git", ["cat-file", "-e", "--end-of-options", `${sha}^{commit}`], { cwd: repo, env: hostEnv() });
  return res.code === 0;
}

/** Same MAJOR, any MINOR. Required on the remote-run routes; checked when present on the 3.1 routes (announce, members). */
export function checkPeerVersion(req: IncomingMessage, own: string, required = true): void {
  const raw = req.headers[API_VERSION_HEADER.toLowerCase()];
  const caller = Array.isArray(raw) ? raw.join(",") : raw;
  if (caller === undefined && !required) return;
  if (caller === undefined || parseApiVersion(caller) === null) throw invalid(`A call between cores must carry the ${API_VERSION_HEADER} header as MAJOR.MINOR.`, API_VERSION_HEADER);
  if (isPeerCompatible(caller, own)) return;
  throw new ControlError("incompatible_version", `This core speaks API ${own} and the calling core ${caller}; cores call each other only within one MAJOR version.`, {
    client_api_version: caller,
    server_api_version: own,
  });
}

/** The run as another member sees it: no repository path. */
export function remoteView(run: Run): RemoteRun {
  if (run.submitter === undefined || run.base_commit === undefined) throw new ControlError("internal", `Run ${run.id} has no recorded submitter or base commit.`);
  const { id, agent_id, harness, state, terminal, cursor, submitter, base_commit, deadline, created_at, updated_at } = run;
  return { id, agent_id, harness, state, terminal, cursor, submitter, base_commit, deadline, created_at, updated_at };
}

/** A run this member submitted, or `not_found` / `denied`. */
async function ownRun(c: Call): Promise<Run> {
  const run = await c.d.service.getRun(c.runId);
  if (!run) throw notFound(`No run ${c.runId} on ${c.d.node}.`, { run_id: c.runId });
  const by = run.submitter;
  if (by?.kind !== "member" || by.node !== c.member.node) {
    throw new ControlError("denied", `Run ${c.runId} on ${c.d.node} was not submitted by ${c.member.node}; a member acts only on the runs it submitted, and the operator of ${c.d.node} keeps control of every run.`);
  }
  return run;
}

/** The checks of a remote submit, in order, then the request the run service takes. */
async function localRequest(d: RunsDeps, r: RemoteSubmitRequest): Promise<SubmitRequest> {
  if (parseMeshId(r.agent_id)?.node !== d.node) throw unsupported("placement", `Agent ${r.agent_id} is not on ${d.node}; a core runs only its own agents and never forwards a submit.`);
  const aliased = resolveAlias(d.aliases(), r.alias);
  if (aliased === null) throw notFound(`${d.node} defines no alias ${r.alias}; its operator adds it to the fleet alias file (aliases.json).`);
  const repo = matchAllowlist(d.allowlist().entries, { agent_id: r.agent_id, harness: r.harness, repo: aliased });
  if (repo === null) throw new ControlError("denied", `No allow-list entry on ${d.node} permits agent ${r.agent_id} with harness ${r.harness} on alias ${r.alias}; that host's operator must add one.`);
  if (r.base_commit !== undefined && !(await (d.hasCommit ?? gitHasCommit)(repo, r.base_commit))) {
    throw invalid(`The checkout that alias ${r.alias} names on ${d.node} has no commit ${r.base_commit}; push or fetch it there first (nothing was fetched).`, "/base_commit");
  }
  return {
    agent_id: r.agent_id,
    harness: r.harness,
    repo,
    task: r.task,
    caller: r.caller,
    ...(r.idempotency_key !== undefined && { idempotency_key: r.idempotency_key }),
    // A duration, counted on this core's clock from acceptance: the caller's clock is never read (c42).
    ...(r.deadline_ms !== undefined && { deadline: new Date(d.now().getTime() + r.deadline_ms).toISOString() }),
  };
}

async function submit({ d, member, req, res }: Call): Promise<void> {
  const body = await readJsonBody(req);
  checkBody("remote#submit_request", body);
  const r = body as RemoteSubmitRequest;
  const request = await localRequest(d, r);
  const submitter: Submitter = { kind: "member", node: member.node };
  const sent = await d.service.submit(request, submitter, { keyNamespace: `member:${member.node}`, digestOf: r, ...(r.base_commit !== undefined && { baseRef: r.base_commit }) });
  return sendJson(res, 201, "remote#submit_response", { run: remoteView(sent.run), ...(sent.replayed === true && { replayed: true }), ...(sent.warnings && { warnings: sent.warnings }) });
}

function intParam(url: URL, name: string, max: number, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,16}$/.test(raw) || Number(raw) > max) throw invalid(`Query parameter ${name} must be an integer from 0 to ${max}.`, name);
  return Number(raw);
}

async function events(c: Call): Promise<void> {
  const run = await ownRun(c);
  const after = intParam(c.url, "after", Number.MAX_SAFE_INTEGER, 0);
  const limit = Math.max(1, intParam(c.url, "limit", MAX_MEMBER_PAGE, MAX_MEMBER_PAGE));
  if (after > run.cursor) throw invalid(`after (${after}) is beyond the run's newest cursor (${run.cursor}).`, "after");
  const page = await c.d.service.readEvents(run.id, after, limit);
  if (!page) throw notFound(`No run ${run.id} on ${c.d.node}.`, { run_id: run.id });
  return sendJson(c.res, 200, "event#event_page", page);
}

async function control(c: Call, kind: "steer" | "cancel"): Promise<void> {
  await ownRun(c);
  const body = await readJsonBody(c.req);
  checkBody(`control-action#${kind}_request`, body);
  const accepted = kind === "steer" ? await c.d.service.steer(c.runId, body as never) : await c.d.service.cancel(c.runId, body as never);
  return sendJson(c.res, 202, "control-action#accepted_response", accepted);
}

type Handler = (c: Call) => Promise<void>;

const RUN_ROUTES: Record<string, Handler> = {
  "GET ": async (c) => sendJson(c.res, 200, "remote", remoteView(await ownRun(c))),
  "GET events": events,
  "POST steer": (c) => control(c, "steer"),
  "POST cancel": (c) => control(c, "cancel"),
};

/** The handler for `method path`, with the run id of the path as sent; null when it is none of these routes. */
function route(method: string, path: string): { handler: Handler; rawId: string } | null {
  if (method === "POST" && path === "/v1/fleet/runs") return { handler: submit, rawId: "" };
  if (method === "GET" && path === "/v1/fleet/aliases") return { handler: async (c) => sendJson(c.res, 200, "remote#alias_list", aliasList(c.d.node, c.d.aliases(), c.d.allowlist().entries)), rawId: "" };
  const m = /^\/v1\/fleet\/runs\/([^/]+)(?:\/(events|steer|cancel))?$/.exec(path);
  const handler = m ? RUN_ROUTES[`${method} ${m[2] ?? ""}`] : undefined;
  return m && handler ? { handler, rawId: m[1] ?? "" } : null;
}

function runIdOf(raw: string): string {
  let runId: string;
  try {
    runId = decodeURIComponent(raw);
  } catch {
    throw invalid("The request path holds a malformed percent-encoding.");
  }
  if (!validate("common#run_id", runId).ok) throw invalid("Path parameter run_id is malformed.", "run_id");
  return runId;
}

/** Serve one remote-run route; false when `method path` is not one (the caller answers `not_found`). The version is checked first. */
export async function serveRuns(d: RunsDeps, member: TrustEntry, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const found = route(req.method ?? "", url.pathname);
  if (!found) return false;
  checkPeerVersion(req, d.apiVersion);
  const runId = found.rawId === "" ? "" : runIdOf(found.rawId);
  await found.handler({ d, member, req, res, url, runId });
  return true;
}
