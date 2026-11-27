// How a failed call to a member is reported: only a member that does not answer reads unreachable
// (`Unreached`, `no_answer`). One that answers too much, or with a key its trust entry does not
// hold, answered: that is a typed `unavailable` saying what happened, never "did not answer".
import assert from "node:assert/strict";
import { test } from "node:test";

import { ControlError } from "../../src/daemon/errors.js";
import { newFleetKey } from "../../src/fleet/cert.js";
import type { Members } from "../../src/fleet/members.js";
import { createRemote, Unreached } from "../../src/fleet/remote.js";
import { FleetCallError, type FleetResponse } from "../../src/fleet/transport.js";

const members = { view: () => ({ members: [{ node: "thor", api_version: "3.3" }] }) } as unknown as Members;

function remoteFailingWith(error: Error) {
  return createRemote({
    key: newFleetKey(),
    trust: () => [],
    members,
    addressOf: () => ({ host: "127.0.0.1", port: 1 }),
    call: (): Promise<FleetResponse> => Promise.reject(error),
  });
}

const get = { method: "GET", path: "/v1/fleet/runs/x/result", status: 200, schema: "run#run_result" } as const;

for (const [code, words] of [
  ["ETOOLARGE", /more than/],
  ["EUNTRUSTED", /trust/],
] as const) {
  test(`a member whose answer fails with ${code} answered: unavailable, not unreachable`, async () => {
    const e = await remoteFailingWith(new FleetCallError(code, "detail")).request("thor", get).catch((x: unknown) => x);
    assert.ok(e instanceof ControlError, String(e));
    assert.equal(e.body.code, "unavailable");
    assert.ok(!(e instanceof Unreached), "it answered, so it is not read as unreachable");
    assert.match(e.message, words);
    assert.doesNotMatch(e.message, /did not answer/);
  });
}

for (const error of [new FleetCallError("ETIMEDOUT", "late"), new FleetCallError("ECLOSED", "closed"), Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })]) {
  test(`a member that does not answer (${error.message}) reads unreachable, no_answer`, async () => {
    const e = await remoteFailingWith(error).request("thor", get).catch((x: unknown) => x);
    assert.ok(e instanceof Unreached, String(e));
    assert.match(e.message, /did not answer/);
  });
}
