// t23 acceptance 1, 2 and 4 in-process: a submit on the calling core's control socket runs on the
// executing core (thor), named by an alias that core defines, and is shown, attached, steered and
// cancelled from the caller; the run's submitter is the authenticated member. The deadline crosses
// as a duration and is evaluated on the executing core's injected clock.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { validate, type ErrorBody, type RemoteRun, type RemoteSubmitResponse, type SubmitRequest } from "../../src/contract/index.js";
import { loadAliases } from "../../src/fleet/aliases.js";
import { certificateFor, fingerprint, newFleetKey } from "../../src/fleet/cert.js";
import { startDaemon } from "../../src/daemon/daemon.js";
import { hostEnv } from "../../src/sandbox/host-command.js";
import { FakeRunService } from "../daemon/fake-service.js";
import { makeEnv } from "../daemon/harness.js";
import { GIT } from "../harness/helpers.js";
import { fleetCall } from "../../src/fleet/transport.js";
import { loadTrust } from "../../src/fleet/trust.js";
import { call } from "../daemon/harness.js";
import { AGENT, ALIAS, CALLER_NODE, eventsOf, gitRepo, OTHER_NODE, pair, sseEvents, startCore, submitBody, type Core } from "./remote-support.js";
import { LOOPBACK } from "./support.js";

const errorOf = (json: unknown): ErrorBody => (json as { error: ErrorBody }).error;

async function submitRemote(caller: Core, extra: Record<string, unknown> = {}): Promise<RemoteSubmitResponse> {
  const reply = await call(caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody(extra) });
  assert.equal(reply.status, 201, reply.text);
  assert.ok(validate("remote#submit_response", reply.json).ok, reply.text);
  return reply.json as RemoteSubmitResponse;
}

test("a submit from the calling core runs on thor and is shown, attached, steered and cancelled from the caller; the submitter is the member", async () => {
  const { exec, caller, repo } = await pair();
  try {
    const { run } = await submitRemote(caller);
    const member = { kind: "member", node: CALLER_NODE, key: fingerprint(caller.key) };
    assert.ok(run.id.startsWith(`${AGENT}.run.`), "the run id names the executing core");
    assert.deepEqual(run.submitter, member, "the authenticated member and its key, not a request field");
    assert.equal(JSON.stringify(run).includes(repo), false, "no path of the executing host reaches the caller");
    const got = exec.service.received[0];
    assert.equal(got?.request.repo, repo, "the alias resolved to the allow-listed path on thor");
    assert.deepEqual(got?.submitter, member);
    assert.equal(got?.options?.keyNamespace, `member:${CALLER_NODE}`, "a member's keys never meet another submitter's");
    const local = await call(exec.env.socket, "GET", `/v1/runs/${run.id}`);
    assert.deepEqual((local.json as { submitter: unknown }).submitter, member, "thor's own view agrees");

    const shown = await call(caller.env.socket, "GET", `/v1/fleet/runs/${run.id}`);
    assert.equal(shown.status, 200, shown.text);
    assert.equal((shown.json as RemoteRun).state, "queued");

    const steer = await call(caller.env.socket, "POST", `/v1/fleet/runs/${run.id}/steer`, { body: { caller: { kind: "operator", id: `${CALLER_NODE}-operator` }, message: "Also cover the null case." } });
    assert.equal(steer.status, 202, steer.text);
    assert.ok(validate("control-action#accepted_response", steer.json).ok);
    const cancel = await call(caller.env.socket, "POST", `/v1/fleet/runs/${run.id}/cancel`, { body: { caller: { kind: "operator", id: `${CALLER_NODE}-operator` }, reason: "enough" } });
    assert.equal(cancel.status, 202, cancel.text);
    assert.deepEqual(exec.service.calls.filter((c) => c === "steer" || c === "cancel"), ["steer", "cancel"], "both reached thor's run service");
    assert.deepEqual(exec.service.controlNamespaces, [`member:${CALLER_NODE}`, `member:${CALLER_NODE}`], "a member's steer and cancel keys never meet another submitter's");

    // Attach: the events already on thor, then live ones, each once, closing after the terminal one.
    const attached = call(caller.env.socket, "GET", `/v1/fleet/runs/${run.id}/attach?after=0`);
    for (const e of eventsOf("steered-then-succeeded.jsonl", run.id).slice(1)) exec.service.append(e);
    const stream = await attached;
    assert.equal(stream.status, 200);
    const events = sseEvents(stream.text);
    assert.deepEqual(events.map((e) => e.cursor), eventsOf("steered-then-succeeded.jsonl", run.id).map((e) => e.cursor));
    assert.ok(events.every((e) => validate("event", e).ok && e.run_id === run.id));
    const again = await call(caller.env.socket, "GET", `/v1/fleet/runs/${run.id}/attach?after=${events.at(-1)?.cursor ?? 0}`);
    assert.deepEqual([again.status, sseEvents(again.text)], [200, []], "attached after the end of a finished run: closes at once");
  } finally {
    await caller.stop();
    await exec.stop();
  }
});

/** The run length thor records for a remote submit of `deadline_ms`, with thor's clock `offset` ms from the caller's. */
async function runLengthWith(offset: number, deadlineMs: number): Promise<number> {
  // The caller's clock is the real one; thor's is fixed, `offset` ms away from a fixed moment.
  const thorNow = new Date(Date.UTC(2026, 10, 27, 12, 0, 0) + offset);
  const { exec, caller } = await pair({ execOptions: { now: () => thorNow } });
  try {
    const { run } = await submitRemote(caller, { deadline_ms: deadlineMs });
    const request = exec.service.received[0]?.request as SubmitRequest;
    assert.equal(Date.parse(request.deadline ?? "") - thorNow.getTime(), deadlineMs, "deadline = thor's clock at acceptance + the duration");
    return Date.parse(run.deadline ?? "") - Date.parse(run.created_at);
  } finally {
    await caller.stop();
    await exec.stop();
  }
}

test("the deadline crosses as a duration: with the two clocks 1 hour apart either way the run gets the same length on thor's clock", async () => {
  const behind = await runLengthWith(-3_600_000, 90_000);
  const ahead = await runLengthWith(3_600_000, 90_000);
  assert.deepEqual([behind, ahead], [90_000, 90_000]);
  // No absolute time from the caller is accepted: the 3.0 `deadline` field is not part of the remote submit.
  assert.equal(validate("remote#submit_request", submitBody({ deadline: "2026-11-27T13:00:00Z" })).ok, false);
});

test("the repository is an alias thor defines, resolved to an allow-listed path; paths, unknown aliases and other checkouts are refused", async () => {
  const { exec, caller } = await pair();
  try {
    const asPath = await call(caller.env.socket, "POST", "/v1/fleet/runs", { body: { ...submitBody(), repo: "/srv/repos/demo" } });
    assert.equal(errorOf(asPath.json).code, "invalid", "a path is not part of the remote submit");
    const unknown = await call(caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody({ alias: "demo" }) });
    assert.equal(errorOf(unknown.json).code, "not_found", unknown.text);
    assert.match(errorOf(unknown.json).message, /^thor: thor defines no alias demo/);
    // An alias to a checkout the allow-list does not name: denied, as a local submit to that path would be.
    const other = gitRepo(exec, "other").path;
    writeFileSync(join(exec.fleetDir, "aliases.json"), JSON.stringify({ version: 1, aliases: [{ alias: "demo", repo: other }] }));
    const denied = await call(caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody({ alias: "demo" }) });
    assert.equal(errorOf(denied.json).code, "denied", denied.text);
    assert.equal(exec.service.received.length, 0, "nothing reached thor's run service");
    // What a caller may use: aliases and permits, never a path.
    const aliases = await call(caller.env.socket, "GET", "/v1/fleet/aliases?member=thor");
    assert.equal(aliases.status, 200, aliases.text);
    assert.deepEqual(aliases.json, { node: "thor", aliases: [{ alias: "demo", permits: [] }] });
    assert.equal(aliases.text.includes(other), false);
  } finally {
    await caller.stop();
    await exec.stop();
  }
});

test("a named base commit thor's checkout lacks is refused invalid; one it has is the run's base; none means thor's HEAD", async () => {
  const { exec, caller } = await pair();
  try {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const refused = await call(caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody({ base_commit: missing }) });
    assert.equal(errorOf(refused.json).code, "invalid", refused.text);
    assert.equal(errorOf(refused.json).field, "/base_commit");
    assert.match(errorOf(refused.json).message, new RegExp(missing));
    const head = gitRepo(exec, "repo-head").head; // a commit in no aliased checkout
    assert.equal(errorOf((await call(caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody({ base_commit: head }) })).json).code, "invalid");
    assert.equal(exec.service.received.length, 0);
    const own = execFileSync(GIT, ["rev-parse", "HEAD"], { cwd: aliasRepo(exec), env: hostEnv(), encoding: "utf8" }).trim();
    const { run } = await submitRemote(caller, { base_commit: own });
    assert.equal(run.base_commit, own);
    assert.equal(exec.service.received[0]?.options?.baseRef, own, "the run service starts from the named commit");
    await submitRemote(caller);
    assert.equal(exec.service.received[1]?.options?.baseRef, undefined, "no commit named: the service resolves thor's HEAD at acceptance");
  } finally {
    await caller.stop();
    await exec.stop();
  }
});

function aliasRepo(core: Core): string {
  const file = JSON.parse(readFileSync(join(core.fleetDir, "aliases.json"), "utf8")) as { aliases: { repo: string }[] };
  return file.aliases[0]?.repo ?? "";
}

test("a member acts only on the runs it submitted; thor's own operator keeps control of every run", async () => {
  const otherKey = newFleetKey();
  const { exec, caller } = await pair();
  // A third member, trusted by thor as OTHER_NODE.
  const trusted = JSON.parse(readFileSync(join(exec.fleetDir, "trust.json"), "utf8")) as unknown[];
  writeFileSync(join(exec.fleetDir, "trust.json"), JSON.stringify([...trusted, { node: OTHER_NODE, cert: certificateFor(otherKey).text }]));
  const other = await startCore(OTHER_NODE, otherKey, [["thor", exec.key]]);
  try {
    const { run } = await submitRemote(caller);
    const asOther = (method: "GET" | "POST", path: string, body?: unknown) =>
      fleetCall({ key: otherKey, trust: loadTrust(join(other.fleetDir, "trust.json")), host: LOOPBACK, port: exec.port(), method, path, ...(body !== undefined && { body: JSON.stringify(body) }), headers: { "Agents-Api-Version": "3.3" }, expectNode: "thor" });
    const by = { caller: { kind: "operator", id: `${OTHER_NODE}-operator` }, message: "take over" };
    const tries = [
      asOther("GET", `/v1/fleet/runs/${run.id}`),
      asOther("GET", `/v1/fleet/runs/${run.id}/events`),
      asOther("POST", `/v1/fleet/runs/${run.id}/steer`, by),
      asOther("POST", `/v1/fleet/runs/${run.id}/cancel`, { caller: by.caller }),
    ];
    const answers = await Promise.all(tries);
    assert.deepEqual(answers.map((r) => r.status), [403, 403, 403, 403], answers.map((r) => r.body.toString()).join("; "));
    assert.ok(answers.every((r) => errorOf(JSON.parse(r.body.toString())).code === "denied"));
    assert.equal(exec.service.calls.filter((c) => c === "steer" || c === "cancel").length, 0, "nothing reached the run");
    const local = await call(exec.env.socket, "POST", `/v1/runs/${run.id}/cancel`, { body: { caller: { kind: "operator", id: "thor-operator" } } });
    assert.equal(local.status, 202, "thor's operator cancels a member's run on the control socket");
  } finally {
    await other.stop();
    await caller.stop();
    await exec.stop();
  }
});

test("a member that does not answer is unavailable within the call timeout; an unlisted one and a core with the transport off are refused at once", async () => {
  const { exec, caller } = await pair();
  try {
    const { run } = await submitRemote(caller);
    await exec.fleet.stop(); // thor's listener is gone; the caller still lists it until the silence passes
    const started = Date.now();
    const gone = await call(caller.env.socket, "POST", `/v1/fleet/runs/${run.id}/steer`, { body: { caller: { kind: "operator", id: `${CALLER_NODE}-operator` }, message: "hello?" } });
    assert.equal(errorOf(gone.json).code, "unavailable", gone.text);
    assert.equal(errorOf(gone.json).retryable, true);
    assert.ok(Date.now() - started < 6000, "within one call timeout (5 s)");
    const attach = await call(caller.env.socket, "GET", `/v1/fleet/runs/${run.id}/attach`);
    assert.equal(errorOf(attach.json).code, "unavailable", "an attach that cannot start is a typed error, not a stream");
    const unlisted = await call(caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody({ agent_id: `${OTHER_NODE}-culture-agents` }) });
    assert.equal(errorOf(unlisted.json).code, "unavailable");
    assert.match(errorOf(unlisted.json).message, /not a listed fleet member/);
    const own = await call(caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody({ agent_id: `${CALLER_NODE}-culture-agents` }) });
    assert.equal(errorOf(own.json).code, "invalid", "this core's own agent is submitted with runs.submit");
  } finally {
    await caller.stop();
    await exec.stop();
  }
  const env = makeEnv();
  const off = await startDaemon({ service: new FakeRunService(), node: "thor", env: env.vars });
  try {
    const reply = await call(env.socket, "POST", "/v1/fleet/runs", { body: submitBody({ agent_id: `${CALLER_NODE}-culture-agents` }) });
    assert.equal(errorOf(reply.json).code, "unsupported");
    assert.equal(errorOf(reply.json).capability, "placement");
  } finally {
    await off.stop();
    env.cleanup();
  }
});

test("the alias file is local and checked: a duplicate alias or a relative path defines nothing", async () => {
  const core = await startCore("thor", newFleetKey(), []);
  try {
    const path = join(core.fleetDir, "aliases.json");
    assert.deepEqual(loadAliases(path), { path, aliases: [], problem: null }, "a missing file defines no alias");
    writeFileSync(path, JSON.stringify({ version: 1, aliases: [{ alias: ALIAS, repo: "/a" }, { alias: ALIAS, repo: "/b" }] }));
    assert.match(loadAliases(path).problem ?? "", /defines alias culture-agents twice/);
    writeFileSync(path, JSON.stringify({ version: 1, aliases: [{ alias: ALIAS, repo: "relative" }] }));
    assert.deepEqual(loadAliases(path).aliases, []);
  } finally {
    await core.stop();
  }
});
