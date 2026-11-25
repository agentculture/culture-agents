import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { apiVersion, httpStatusFor, validate, type ErrorResponse, type SchemaName, type SubmitRequest } from "../../src/contract/index.js";
import { startDaemon, type Daemon } from "../../src/daemon/daemon.js";
import { FakeRunService, fixture, stream } from "./fake-service.js";
import { call, makeEnv, writeAllowlist, type Env, type Reply } from "./harness.js";

const RUN = "spark-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5";
const OTHER_RUN = "spark-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D6";
let env: Env;
let daemon: Daemon;
let service: FakeRunService;
let repo: string;

function submitBody(over: Partial<SubmitRequest> = {}): SubmitRequest {
  return { ...fixture<SubmitRequest>("valid/control-action/submit_request.minimal.json"), repo, ...over };
}

function allowEntry(): { agent_id: string; harness: string; repo: string } {
  return { agent_id: "spark-culture-agents", harness: "claude-code", repo };
}

before(async () => {
  env = makeEnv();
  repo = join(env.root, "repo");
  mkdirSync(repo);
  repo = realpathSync(repo);
  service = new FakeRunService();
  service.seed(fixture("valid/run/root.queued.json"), stream("succeeded.jsonl").slice(0, 3));
  daemon = await startDaemon({ service, node: "spark", env: env.vars, keepaliveMs: 100 });
});
after(async () => {
  await daemon.stop();
  env.cleanup();
});

/** Every non-2xx body is a valid error with the HTTP status the contract fixes for its code. */
function expectError(reply: Reply, code: string): ErrorResponse["error"] {
  assert.equal(validate("error", reply.json).ok, true, `error body must validate: ${reply.text}`);
  const body = (reply.json as ErrorResponse).error;
  assert.equal(body.code, code);
  assert.equal(reply.status, httpStatusFor(body.code));
  return body;
}

function expectOk(reply: Reply, status: number, schema: SchemaName): void {
  assert.equal(reply.status, status, reply.text);
  const result = validate(schema, reply.json);
  assert.equal(result.ok, true, `${schema}: ${reply.text}`);
}

test("version endpoint returns the contract's API version, even for an incompatible client", async () => {
  const reply = await call(env.socket, "GET", "/v1/version", { version: "9.9" });
  expectOk(reply, 200, "version");
  assert.equal((reply.json as { api_version: string }).api_version, apiVersion);
  assert.equal((reply.json as { node: string }).node, "spark");
});

test("an incompatible client version is refused with the typed error before anything else", async () => {
  const major = await call(env.socket, "GET", "/v1/agents", { version: "3.0" });
  const body = expectError(major, "incompatible_version");
  assert.equal(body.client_api_version, "3.0");
  assert.equal(body.server_api_version, apiVersion);
  // Wrong version wins over an unknown path, a bad body and a missing run.
  expectError(await call(env.socket, "GET", "/v1/nope", { version: "3.0" }), "incompatible_version");
  expectError(await call(env.socket, "POST", "/v1/runs", { version: "0.1", rawBody: "{" }), "incompatible_version");
  // A client newer than the core in MINOR is incompatible too.
  expectError(await call(env.socket, "GET", "/v1/runs", { version: "2.99" }), "incompatible_version");
  // An absent header is accepted.
  expectOk(await call(env.socket, "GET", "/v1/agents", { version: null }), 200, "agent#agent_list");
  assert.equal(service.calls.includes("submit"), false);
});

test("read routes return bodies that validate against the contract", async () => {
  expectOk(await call(env.socket, "GET", "/v1/agents"), 200, "agent#agent_list");
  expectOk(await call(env.socket, "GET", "/v1/agents/spark-culture-agents"), 200, "agent");
  expectOk(await call(env.socket, "GET", "/v1/harnesses"), 200, "capabilities#capabilities_list");
  expectOk(await call(env.socket, "GET", "/v1/harnesses/claude-code"), 200, "capabilities");
  expectOk(await call(env.socket, "GET", "/v1/runs?limit=5&state=queued"), 200, "run#run_list");
  expectOk(await call(env.socket, "GET", `/v1/runs/${RUN}`), 200, "run");
  const page = await call(env.socket, "GET", `/v1/runs/${RUN}/events?after=1&limit=1`);
  expectOk(page, 200, "event#event_page");
  assert.deepEqual((page.json as { events: { cursor: number }[] }).events.map((e) => e.cursor), [2]);
  assert.equal((page.json as { more: boolean }).more, true);
});

test("unknown ids, bad parameters, unknown paths and wrong methods get typed errors", async () => {
  expectError(await call(env.socket, "GET", `/v1/runs/${OTHER_RUN}`), "not_found");
  expectError(await call(env.socket, "GET", "/v1/agents/spark-nobody"), "not_found");
  expectError(await call(env.socket, "GET", "/v1/harnesses/nope"), "not_found");
  expectError(await call(env.socket, "GET", "/v1/elsewhere"), "not_found");
  expectError(await call(env.socket, "GET", "/v1/runs/%zz"), "invalid");
  expectError(await call(env.socket, "GET", "/v1/agents/%E0%A4%A"), "invalid");
  expectInvalid(await call(env.socket, "GET", "/v1/runs/not-a-run-id"), "run_id");
  expectInvalid(await call(env.socket, "GET", "/v1/runs?limit=0"), "limit");
  expectInvalid(await call(env.socket, "GET", "/v1/runs?limit=501"), "limit");
  expectInvalid(await call(env.socket, "GET", "/v1/runs?state=sleeping"), "state");
  expectInvalid(await call(env.socket, "GET", `/v1/runs/${RUN}/events?after=999`), "after");
  expectInvalid(await call(env.socket, "DELETE", "/v1/runs"));
  expectInvalid(await call(env.socket, "GET", `/v1/runs/${RUN}/steer`));
  // result of an active run is a retryable conflict
  const conflict = expectError(await call(env.socket, "GET", `/v1/runs/${RUN}/result`), "conflict");
  assert.equal(conflict.retryable, true);
  assert.equal(conflict.run_id, RUN);

  function expectInvalid(reply: Reply, field?: string): void {
    const body = expectError(reply, "invalid");
    if (field) assert.equal(body.field, field);
  }
});

test("a fresh install refuses every submit and never reaches the service", async () => {
  // No allow-list file exists in this environment.
  const reply = await call(env.socket, "POST", "/v1/runs", { body: submitBody() });
  expectError(reply, "denied");
  assert.equal(daemon.allowlistState().status, "missing");
  assert.equal(service.submitted.length, 0);
  assert.equal(service.calls.includes("submit"), false);
});

test("a malformed or invalid allow-list file counts as empty and is reported", async () => {
  writeAllowlist(env, "{ not json");
  expectError(await call(env.socket, "POST", "/v1/runs", { body: submitBody() }), "denied");
  assert.equal(daemon.allowlistState().status, "invalid");
  writeAllowlist(env, { version: 1, entries: [{ agent_id: "spark-culture-agents", harness: "*", repo: "*" }] } as never);
  expectError(await call(env.socket, "POST", "/v1/runs", { body: submitBody() }), "denied");
  assert.equal(daemon.allowlistState().status, "invalid");
  assert.equal(service.submitted.length, 0);
});

test("body validation comes before the allow-list, and a past deadline is invalid", async () => {
  writeAllowlist(env, { version: 1, entries: [] });
  const bad = await call(env.socket, "POST", "/v1/runs", { body: { agent_id: "spark-culture-agents" } });
  expectError(bad, "invalid");
  expectError(await call(env.socket, "POST", "/v1/runs", { rawBody: "{ nope" }), "invalid");
  expectError(await call(env.socket, "POST", "/v1/runs", { rawBody: "" }), "invalid");
  expectError(await call(env.socket, "POST", "/v1/runs", { body: { ...submitBody(), extra: 1 } }), "invalid");
  const past = expectError(await call(env.socket, "POST", "/v1/runs", { body: submitBody({ deadline: "2020-01-01T00:00:00Z" }) }), "invalid");
  assert.equal(past.field, "/deadline");
  assert.equal(service.submitted.length, 0);
});

test("allow-list matches agent, harness and repo exactly; a symlinked repo path is canonicalized", async () => {
  writeAllowlist(env, { version: 1, entries: [allowEntry()] });
  assert.equal(daemon.allowlistState().entries.length, 1);
  // each field differing is denied
  expectError(await call(env.socket, "POST", "/v1/runs", { body: submitBody({ agent_id: "spark-other" }) }), "denied");
  expectError(await call(env.socket, "POST", "/v1/runs", { body: submitBody({ harness: "opencode" }) }), "denied");
  const sibling = join(env.root, "other-repo");
  mkdirSync(sibling);
  expectError(await call(env.socket, "POST", "/v1/runs", { body: submitBody({ repo: sibling }) }), "denied");
  expectError(await call(env.socket, "POST", "/v1/runs", { body: submitBody({ repo: join(env.root, "missing") }) }), "denied");
  assert.equal(service.submitted.length, 0);

  const ok = await call(env.socket, "POST", "/v1/runs", { body: submitBody() });
  expectOk(ok, 201, "control-action#submit_response");
  assert.equal(service.submitted.length, 1);

  const link = join(env.root, "repo-link");
  symlinkSync(repo, link);
  const viaLink = await call(env.socket, "POST", "/v1/runs", { body: submitBody({ repo: link }) });
  expectOk(viaLink, 201, "control-action#submit_response");
  assert.equal(service.submitted[1]?.repo, repo, "the service receives the canonical repo");
});

test("service refusals surface as typed errors", async () => {
  const original = service.submit.bind(service);
  const { ControlError } = await import("../../src/daemon/errors.js");
  service.submit = () => Promise.reject(new ControlError("busy", "The repository already has an active run.", { active_run_id: RUN, repo }));
  const busy = expectError(await call(env.socket, "POST", "/v1/runs", { body: submitBody() }), "busy");
  assert.equal(busy.active_run_id, RUN);
  service.submit = () => Promise.reject(new Error("boom with /secret/path"));
  const internal = expectError(await call(env.socket, "POST", "/v1/runs", { body: submitBody() }), "internal");
  assert.doesNotMatch(internal.message, /secret/);
  service.submit = original;
});

test("pause, resume and answer are always unsupported, after id, existence and body checks", async () => {
  const caller = { kind: "operator", id: "spark-operator" };
  const bodies = { pause: { caller }, resume: { caller }, answer: { caller, question_id: "q1", answer: "yes" } };
  for (const [verb, body] of Object.entries(bodies)) {
    const reply = await call(env.socket, "POST", `/v1/runs/${RUN}/${verb}`, { body });
    const refusal = expectError(reply, "unsupported");
    assert.equal(refusal.capability, verb);
    // The route hands the refusal to the service, which records it when the run is live and controlled.
    assert.deepEqual(service.refusals.at(-1), { runId: RUN, kind: verb, caller, error: refusal });
    expectError(await call(env.socket, "POST", `/v1/runs/${OTHER_RUN}/${verb}`, { body }), "not_found");
    expectError(await call(env.socket, "POST", `/v1/runs/${RUN}/${verb}`, { body: { nope: true } }), "invalid");
    expectError(await call(env.socket, "POST", `/v1/runs/bad/${verb}`, { body }), "invalid");
  }
  assert.equal(service.refusals.length, 3, "only a refusal at step 4 is handed over, never an earlier one");
  // A service that fails to record changes nothing for the caller.
  const original = service.recordRefusal.bind(service);
  service.recordRefusal = () => Promise.reject(new Error("the worker is gone"));
  assert.equal(expectError(await call(env.socket, "POST", `/v1/runs/${RUN}/pause`, { body: bodies.pause }), "unsupported").capability, "pause");
  service.recordRefusal = original;
});

test("steer and cancel validate then reach the service", async () => {
  const caller = { kind: "operator", id: "spark-operator" };
  expectOk(await call(env.socket, "POST", `/v1/runs/${RUN}/steer`, { body: { caller, message: "use tabs" } }), 202, "control-action#accepted_response");
  expectOk(await call(env.socket, "POST", `/v1/runs/${RUN}/cancel`, { body: { caller } }), 202, "control-action#accepted_response");
  expectError(await call(env.socket, "POST", `/v1/runs/${RUN}/steer`, { body: { caller } }), "invalid");
  expectError(await call(env.socket, "POST", `/v1/runs/${OTHER_RUN}/cancel`, { body: { caller } }), "not_found");
});

interface Frame {
  id: string;
  event: string;
  data: string;
}

/** Open an SSE stream; resolves frames as they arrive and the final close. */
function attach(path: string, headers: Record<string, string> = {}): { frames: Frame[]; comments: string[]; status: Promise<number>; closed: Promise<void>; abort(): void } {
  const frames: Frame[] = [];
  const comments: string[] = [];
  let resolveStatus!: (n: number) => void;
  const status = new Promise<number>((r) => (resolveStatus = r));
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const req = request({ socketPath: env.socket, path, headers: { "Agents-Api-Version": "2.0", ...headers } }, (res) => {
    resolveStatus(res.statusCode ?? 0);
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
      let at;
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (block.startsWith(":")) comments.push(block);
        else {
          const f: Record<string, string> = {};
          for (const line of block.split("\n")) f[line.slice(0, line.indexOf(": "))] = line.slice(line.indexOf(": ") + 2);
          frames.push({ id: f["id"] ?? "", event: f["event"] ?? "", data: f["data"] ?? "" });
        }
      }
    });
    res.on("end", resolveClosed);
    res.on("close", resolveClosed);
  });
  req.on("error", () => resolveClosed());
  req.end();
  return { frames, comments, status, closed, abort: () => req.destroy() };
}

const until = async (cond: () => boolean): Promise<void> => {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("attach replays from a cursor, then follows live events and closes after the terminal state", async () => {
  const events = stream("succeeded.jsonl");
  const a = attach(`/v1/runs/${RUN}/attach?after=1`);
  assert.equal(await a.status, 200);
  await until(() => a.frames.length === 2); // cursors 2 and 3 replayed
  assert.deepEqual(a.frames.map((f) => f.id), ["2", "3"]);
  await until(() => a.comments.length > 0); // idle keepalive
  assert.equal(a.comments[0], ": keepalive");
  for (const e of events.slice(3)) service.append(e);
  await a.closed;
  assert.deepEqual(a.frames.map((f) => Number(f.id)), events.slice(1).map((e) => e.cursor));
  for (const f of a.frames) {
    assert.equal(validate("event", JSON.parse(f.data)).ok, true);
    assert.equal(f.event, (JSON.parse(f.data) as { kind: string }).kind);
  }
  assert.equal(JSON.parse(a.frames.at(-1)?.data ?? "{}").data.to, "succeeded");
});

test("attach on a terminal run: Last-Event-ID is the fallback, full replay from 0, and closing at once at the end", async () => {
  const total = stream("succeeded.jsonl").length;
  const all = attach(`/v1/runs/${RUN}/attach`);
  await all.closed;
  assert.equal(all.frames.length, total);
  const resumed = attach(`/v1/runs/${RUN}/attach`, { "Last-Event-ID": String(total - 1) });
  await resumed.closed;
  assert.deepEqual(resumed.frames.map((f) => f.id), [String(total)]);
  // A Last-Event-ID that is not a cursor is refused, never read as 0; a valid `after` still wins over it.
  for (const bad of ["abc", "1.5", "-1", "", "2,3", "99999999999999999999"]) {
    const reply = await call(env.socket, "GET", `/v1/runs/${RUN}/attach`, { headers: { "Last-Event-ID": bad } });
    assert.equal(expectError(reply, "invalid").field, "Last-Event-ID", JSON.stringify(bad));
  }
  const wins = attach(`/v1/runs/${RUN}/attach?after=${total - 1}`, { "Last-Event-ID": "abc" });
  await wins.closed;
  assert.deepEqual(wins.frames.map((f) => f.id), [String(total)]);
  const done = attach(`/v1/runs/${RUN}/attach?after=${total}`);
  await done.closed;
  assert.equal(done.frames.length, 0);
  assert.equal(await done.status, 200);
  // after beyond the cursor is an ordinary JSON error, no stream
  const beyond = await call(env.socket, "GET", `/v1/runs/${RUN}/attach?after=${total + 1}`);
  assert.equal(expectError(beyond, "invalid").field, "after");
  expectError(await call(env.socket, "GET", `/v1/runs/${RUN}/attach?after=-1`), "invalid");
  expectError(await call(env.socket, "GET", `/v1/runs/${OTHER_RUN}/attach`), "not_found");
});

test("shutdown ends open streams", async () => {
  const env2 = makeEnv();
  const svc = new FakeRunService();
  svc.seed(fixture("valid/run/root.queued.json"), stream("succeeded.jsonl").slice(0, 2));
  const d = await startDaemon({ service: svc, node: "spark", env: env2.vars });
  const req = request({ socketPath: env2.socket, path: `/v1/runs/${RUN}/attach`, headers: { "Agents-Api-Version": "2.0" } });
  let closed = false;
  const ended = new Promise<number | undefined>((resolve) =>
    req.on("response", (res) => {
      res.resume();
      res.on("close", () => {
        closed = true;
        resolve(res.statusCode);
      });
    }),
  );
  req.end();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(closed, false, "the stream is open until the daemon stops");
  await d.stop();
  assert.equal(await ended, 200, "the stream was open, and stopping the daemon closed it");
  env2.cleanup();
});
