// t26: a run's commits come back from the executing core (thor) as a git bundle served through the
// control API and the fleet transport, never over a shell; the bundle holds only that run's ref; it,
// the result and the logs are served only to a caller allowed to read the run, and logs and attach
// across hosts are not redacted. Cross-host log responses carry the sensitivity header.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { validate, type ErrorBody, type EventPage, type RemoteSubmitResponse, type RunResult } from "../../src/contract/index.js";
import { BUNDLE_CONTENT_TYPE, SENSITIVITY_HEADER } from "../../src/fleet/bundle.js";
import { certificateFor, fingerprint as fingerprintOf, newFleetKey } from "../../src/fleet/cert.js";
import { fleetCall } from "../../src/fleet/transport.js";
import { loadTrust } from "../../src/fleet/trust.js";
import { hostEnv } from "../../src/sandbox/host-command.js";
import { call } from "../daemon/harness.js";
import { GIT } from "../harness/helpers.js";
import { CALLER_NODE, eventsOf, OTHER_NODE, pair, startCore, submitBody, type Core } from "./remote-support.js";
import { LOOPBACK } from "./support.js";

const errorOf = (json: unknown): ErrorBody => (json as { error: ErrorBody }).error;
const git = (cwd: string, ...args: string[]): string => execFileSync(GIT, args, { cwd, env: hostEnv(), encoding: "utf8" }).trim();
const commit = (cwd: string, message: string): string => {
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

/** A raw GET on the control socket: status, headers and the body bytes. */
function rawGet(socket: string, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return import("node:http").then(
    ({ request }) =>
      new Promise((resolve, reject) => {
        const req = request({ socketPath: socket, path, method: "GET", headers: { "Agents-Api-Version": "3.3" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.end();
      }),
  );
}

interface Finished {
  exec: Core;
  caller: Core;
  repo: string;
  runId: string;
  base: string;
  commits: string[];
  /** A commit on another branch of thor's repository, which no bundle may carry. */
  secret: string;
}

/** A remote run on thor that finished with two commits on `runs/<id>`, built on its base commit. */
async function finishedRun(o: Parameters<typeof pair>[0] = {}): Promise<Finished> {
  const { exec, caller, repo } = await pair(o);
  const base = git(repo, "rev-parse", "HEAD");
  const reply = await call(caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody({ base_commit: base }) });
  assert.equal(reply.status, 201, reply.text);
  const runId = (reply.json as RemoteSubmitResponse).run.id;
  git(repo, "checkout", "-q", "-b", "elsewhere");
  const secret = commit(repo, "a commit of thor's own, on no run branch");
  git(repo, "checkout", "-q", "-b", `runs/${runId}`, base);
  const commits = [commit(repo, "run commit one"), commit(repo, "run commit two")];
  git(repo, "checkout", "-q", "main");
  for (const e of eventsOf("steered-then-succeeded.jsonl", runId).slice(1)) exec.service.append(e);
  exec.service.results.set(runId, { branch: `runs/${runId}`, commits });
  return { exec, caller, repo, runId, base, commits, secret };
}

async function stopAll(...cores: Core[]): Promise<void> {
  await Promise.all(cores.map((c) => c.stop()));
}

test("the caller fetches a remote run's result and its commits as a bundle through the control API; the bundle holds only that run's ref", async () => {
  const f = await finishedRun();
  try {
    const result = await call(f.caller.env.socket, "GET", `/v1/fleet/runs/${f.runId}/result`);
    assert.equal(result.status, 200, result.text);
    assert.ok(validate("run#run_result", result.json).ok, result.text);
    assert.deepEqual([(result.json as RunResult).branch, (result.json as RunResult).commits], [`runs/${f.runId}`, f.commits]);
    assert.equal(result.text.includes(f.repo), false, "no path of thor reaches the caller");

    const bundle = await rawGet(f.caller.env.socket, `/v1/fleet/runs/${f.runId}/bundle`);
    assert.equal(bundle.status, 200, bundle.body.toString());
    assert.equal(bundle.headers["content-type"], BUNDLE_CONTENT_TYPE);
    assert.equal(bundle.headers[SENSITIVITY_HEADER.toLowerCase()], "unredacted");
    const file = join(f.caller.env.root, "run.bundle");
    writeFileSync(file, bundle.body);
    const heads = git(f.caller.env.root, "bundle", "list-heads", file).split("\n");
    assert.deepEqual(heads, [`${f.commits[1]} refs/heads/runs/${f.runId}`], "exactly one ref: the run's");

    // The caller's checkout of the same project holds the base commit, so the thin bundle applies.
    const mine = join(f.caller.env.root, "mine");
    execFileSync(GIT, ["clone", "-q", "--branch", "main", f.repo, mine], { env: hostEnv() });
    git(mine, "fetch", "-q", file, `refs/heads/runs/${f.runId}:refs/heads/runs/${f.runId}`);
    assert.equal(git(mine, "rev-parse", `runs/${f.runId}`), f.commits[1]);
    assert.equal(git(mine, "rev-list", "--count", `${f.base}..runs/${f.runId}`), "2");
    // Nothing but the run's commits travelled: a bundle-only repository lacks thor's other commit.
    const bare = join(f.caller.env.root, "bare");
    git(f.caller.env.root, "init", "-q", "--bare", bare);
    const unbundle = spawnSync(GIT, ["bundle", "unbundle", file], { cwd: bare, env: hostEnv(), encoding: "utf8" });
    assert.notEqual(unbundle.status, 0, "the bundle needs the base commit: it carries only commits after it");
    assert.match(unbundle.stderr, new RegExp(f.base));
    assert.equal(bundle.body.includes(Buffer.from(f.secret)), false);
  } finally {
    await stopAll(f.caller, f.exec);
  }
});

test("logs and attach across hosts are the executing core's events unredacted, marked with the sensitivity header", async () => {
  const f = await finishedRun();
  try {
    const local = await call(f.exec.env.socket, "GET", `/v1/runs/${f.runId}/events?after=0&limit=50`);
    const remote = await rawGet(f.caller.env.socket, `/v1/fleet/runs/${f.runId}/events?after=0&limit=50`);
    assert.equal(remote.status, 200, remote.body.toString());
    const page = JSON.parse(remote.body.toString()) as EventPage;
    assert.ok(validate("event#event_page", page).ok);
    assert.deepEqual(page, local.json, "byte for byte what thor's operator reads: nothing redacted");
    assert.equal(remote.headers[SENSITIVITY_HEADER.toLowerCase()], "unredacted");
    const tooMany = await call(f.caller.env.socket, "GET", `/v1/fleet/runs/${f.runId}/events?limit=51`);
    assert.equal(errorOf(tooMany.json).code, "invalid", "one page over the transport is at most 50 events");

    const attach = await rawGet(f.caller.env.socket, `/v1/fleet/runs/${f.runId}/attach?after=0`);
    assert.equal(attach.status, 200);
    assert.equal(attach.headers[SENSITIVITY_HEADER.toLowerCase()], "unredacted");
    const texts = (local.json as EventPage).events.map((e) => JSON.stringify(e));
    assert.ok(texts.every((t) => attach.body.toString().includes(t)), "every event streams as thor stored it");
    const own = await rawGet(f.exec.env.socket, `/v1/runs/${f.runId}/events`);
    assert.equal(own.headers[SENSITIVITY_HEADER.toLowerCase()], undefined, "a local read carries no mark");
  } finally {
    await stopAll(f.caller, f.exec);
  }
});

test("only the member that submitted a run may read its result, bundle and logs over the transport; others are denied", async () => {
  const otherKey = newFleetKey();
  const f = await finishedRun();
  const trusted = JSON.parse(readFileSync(join(f.exec.fleetDir, "trust.json"), "utf8")) as unknown[];
  writeFileSync(join(f.exec.fleetDir, "trust.json"), JSON.stringify([...trusted, { node: OTHER_NODE, cert: certificateFor(otherKey).text }]));
  const other = await startCore(OTHER_NODE, otherKey, [["thor", f.exec.key]]);
  try {
    const asOther = (path: string) =>
      fleetCall({ key: otherKey, trust: loadTrust(join(other.fleetDir, "trust.json")), host: LOOPBACK, port: f.exec.port(), method: "GET", path, headers: { "Agents-Api-Version": "3.3" }, expectNode: "thor" });
    const answers = await Promise.all(["/result", "/bundle", "/events"].map((rest) => asOther(`/v1/fleet/runs/${f.runId}${rest}`)));
    assert.deepEqual(answers.map((r) => r.status), [403, 403, 403], answers.map((r) => r.body.toString()).join("; "));
    assert.ok(answers.every((r) => errorOf(JSON.parse(r.body.toString())).code === "denied"));
    assert.equal(f.exec.service.calls.includes("getResult"), false, "nothing of the run was read for them");
  } finally {
    await stopAll(other, f.caller, f.exec);
  }
});

test("a bundle of an active run is a conflict, of a run with no commits not_found, and a 3.2 member is refused without a call", async () => {
  const f = await finishedRun();
  try {
    f.exec.service.results.set(f.runId, { branch: null, commits: [] });
    const none = await call(f.caller.env.socket, "GET", `/v1/fleet/runs/${f.runId}/bundle`);
    assert.equal(errorOf(none.json).code, "not_found", none.text);
    assert.match(errorOf(none.json).message, /^thor: .*no commits/);
    const second = await call(f.caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody() });
    const active = (second.json as RemoteSubmitResponse).run.id;
    const busy = await call(f.caller.env.socket, "GET", `/v1/fleet/runs/${active}/bundle`);
    assert.equal(errorOf(busy.json).code, "conflict", busy.text);
    const local = await call(f.caller.env.socket, "GET", `/v1/fleet/runs/${CALLER_NODE}-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5/bundle`);
    assert.equal(errorOf(local.json).code, "invalid", "a run on this core is not fetched over the fleet");
  } finally {
    await stopAll(f.caller, f.exec);
  }
  const old = await pair({ execOptions: { apiVersion: "3.2" } });
  try {
    const sent = await call(old.caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody() });
    const runId = (sent.json as RemoteSubmitResponse).run.id;
    const replies = await Promise.all(["/bundle", "/result", "/events"].map((rest) => call(old.caller.env.socket, "GET", `/v1/fleet/runs/${runId}${rest}`)));
    assert.deepEqual(replies.map((r) => [errorOf(r.json).code, errorOf(r.json).capability]), Array(3).fill(["unsupported", "placement"]));
    assert.ok(replies.every((r) => /3\.3/.test(errorOf(r.json).message)));
  } finally {
    await stopAll(old.caller, old.exec);
  }
});

test("a member is its key: the node name moved to a new key does not inherit the runs the old key submitted", async () => {
  const f = await finishedRun();
  const newKey = newFleetKey();
  try {
    const submitter = (await f.exec.service.getRun(f.runId))?.submitter;
    assert.deepEqual(submitter, { kind: "member", node: CALLER_NODE, key: fingerprintOf(f.caller.key) });
    // thor's operator points the caller's node name at another key (a reinstalled host, say).
    writeFileSync(join(f.exec.fleetDir, "trust.json"), JSON.stringify([{ node: CALLER_NODE, cert: certificateFor(newKey).text }]));
    const trustThor = join(f.caller.fleetDir, "trust.json");
    const asNewKey = await fleetCall({ key: newKey, trust: loadTrust(trustThor), host: LOOPBACK, port: f.exec.port(), method: "GET", path: `/v1/fleet/runs/${f.runId}/result`, headers: { "Agents-Api-Version": "3.3" }, expectNode: "thor" });
    assert.equal(asNewKey.status, 403, asNewKey.body.toString());
    assert.equal(errorOf(JSON.parse(asNewKey.body.toString())).code, "denied");
  } finally {
    await stopAll(f.caller, f.exec);
  }
});
