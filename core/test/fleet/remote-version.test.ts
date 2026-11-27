// t23 acceptance 3: two cores on different MINOR versions of API major 3 call each other in both
// directions. thor stands for a core that has not been upgraded: it reports API 3.1 in its version,
// its announcements and the header of its calls. The calling core speaks this build's 3.3. Under the
// client rule (C == S and y >= x) a 3.3 caller would refuse a 3.1 core; between cores the rule is
// "same MAJOR" (contract/README.md, "Calls between cores"), and a route is sent only to a member whose
// MINOR has it. A core reporting 4.0 is refused both ways.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { apiVersion, isCompatible, isPeerCompatible, servesSince, validate, type ErrorBody, type MemberList } from "../../src/contract/index.js";
import { newFleetKey } from "../../src/fleet/cert.js";
import { fleetCall, type FleetResponse } from "../../src/fleet/transport.js";
import { loadTrust } from "../../src/fleet/trust.js";
import { call } from "../daemon/harness.js";
import { CALLER_NODE, startCore, submitBody, type Core } from "./remote-support.js";
import { LOOPBACK } from "./support.js";

const errorOf = (json: unknown): ErrorBody => (json as { error: ErrorBody }).error;

/** One call from `from` to `to` over the fleet transport, sending `version` as `from`'s API version. */
const direct = (from: Core, to: Core, path: string, version: string, body?: unknown): Promise<FleetResponse> =>
  fleetCall({ key: from.key, trust: loadTrust(join(from.fleetDir, "trust.json")), host: LOOPBACK, port: to.port(), method: body === undefined ? "GET" : "POST", path, ...(body !== undefined && { body: JSON.stringify(body) }), headers: { "Agents-Api-Version": version }, expectNode: to.node });

test("the rule between cores is the same MAJOR, whatever the MINORs; the client rule is not symmetric", () => {
  assert.equal(apiVersion, "3.3");
  assert.equal(isCompatible("3.3", "3.1"), false, "a 3.3 client refuses a 3.1 core");
  assert.equal(isPeerCompatible("3.2", "3.1"), true);
  assert.equal(isPeerCompatible("3.1", "3.2"), true);
  assert.equal(isPeerCompatible("3.2", "4.0"), false);
  assert.equal(isPeerCompatible("3.2", "three"), false);
  assert.deepEqual([servesSince("3.1", "3.2"), servesSince("3.2", "3.2"), servesSince("3.9", "3.2"), servesSince("4.2", "3.2")], [false, true, true, false]);
});

test("this core (3.3) and a core that reports 3.1 call each other in both directions", async () => {
  const thorKey = newFleetKey();
  const callerKey = newFleetKey();
  const thor = await startCore("thor", thorKey, [[CALLER_NODE, callerKey]], { apiVersion: "3.1" });
  const caller = await startCore(CALLER_NODE, callerKey, [["thor", thorKey]]);
  try {
    // 3.3 -> 3.1: the announcement (header 3.3) is accepted, and each core lists the other with its version.
    caller.announceTo(thor);
    await caller.fleet.announce();
    assert.equal(thor.fleet.members.view().members[0]?.api_version, apiVersion);
    assert.equal(caller.fleet.members.view().members[0]?.api_version, "3.1");
    const down = await Promise.all(["/v1/version", "/v1/fleet/members"].map((path) => direct(caller, thor, path, "3.3")));
    assert.deepEqual(down.map((r) => r.status), [200, 200], down.map((r) => r.body.toString()).join("; "));
    assert.ok(validate("fleet", JSON.parse((await direct(caller, thor, "/v1/fleet/members", "3.3")).body.toString())).ok);
    // A route thor's 3.1 does not have is never sent to it: refused on the caller, nothing reaches thor.
    const submit = await call(caller.env.socket, "POST", "/v1/fleet/runs", { body: submitBody() });
    assert.equal(errorOf(submit.json).code, "unsupported", submit.text);
    assert.match(errorOf(submit.json).message, /thor speaks API 3\.1; runs on another member need API 3\.2/);
    assert.equal(thor.service.received.length, 0);

    // 3.1 -> 3.3: thor announces with header 3.1 and reads the caller's version and member list.
    thor.announceTo(caller);
    await thor.fleet.announce();
    const up = await Promise.all(["/v1/version", "/v1/fleet/members"].map((path) => direct(thor, caller, path, "3.1")));
    assert.deepEqual(up.map((r) => r.status), [200, 200], up.map((r) => r.body.toString()).join("; "));
    const listed = JSON.parse((await direct(thor, caller, "/v1/fleet/members", "3.1")).body.toString()) as MemberList;
    assert.equal(listed.members[0]?.api_version, "3.1", "the 3.3 core lists the 3.1 core");
    // The 3.3 core serves its 3.3 routes to a caller that sends a lower MINOR (here thor's 3.1 header).
    const agent = `${CALLER_NODE}-culture-agents`;
    writeFileSync(caller.env.allowlistPath, JSON.stringify({ version: 1, entries: [] }));
    const aliases = await direct(thor, caller, "/v1/fleet/aliases", "3.1");
    assert.equal(aliases.status, 200, aliases.body.toString());
    const remote = await direct(thor, caller, "/v1/fleet/runs", "3.1", submitBody({ agent_id: agent }));
    assert.equal(errorOf(JSON.parse(remote.body.toString())).code, "not_found", "served (the caller defines no alias), not refused for its version");
  } finally {
    await caller.stop();
    await thor.stop();
  }
});

test("a core of another MAJOR is refused both ways: never listed, and its calls answered incompatible_version", async () => {
  const thorKey = newFleetKey();
  const nextKey = newFleetKey();
  const thor = await startCore("thor", thorKey, [[CALLER_NODE, nextKey]]);
  const next = await startCore(CALLER_NODE, nextKey, [["thor", thorKey]], { apiVersion: "4.0" });
  try {
    next.announceTo(thor);
    await next.fleet.announce();
    assert.deepEqual(thor.fleet.members.view().members, [], "an announcement from 4.0 is refused");
    assert.deepEqual(next.fleet.members.view().members, [], "and gets no reply that would list thor");
    const both = await Promise.all([direct(next, thor, "/v1/fleet/runs", "4.0", submitBody()), direct(thor, next, "/v1/fleet/runs", apiVersion, submitBody())]);
    assert.deepEqual(both.map((r) => r.status), [412, 412]);
    const [intoThor, intoNext] = both.map((r) => errorOf(JSON.parse(r.body.toString())));
    assert.deepEqual([intoThor?.code, intoThor?.client_api_version, intoThor?.server_api_version], ["incompatible_version", "4.0", apiVersion]);
    assert.deepEqual([intoNext?.code, intoNext?.client_api_version, intoNext?.server_api_version], ["incompatible_version", apiVersion, "4.0"]);
    const noHeader = await fleetCall({ key: nextKey, trust: loadTrust(join(next.fleetDir, "trust.json")), host: LOOPBACK, port: thor.port(), method: "GET", path: "/v1/fleet/aliases" });
    assert.equal(errorOf(JSON.parse(noHeader.body.toString())).code, "invalid", "a remote-run route requires the version header");
  } finally {
    await next.stop();
    await thor.stop();
  }
});
