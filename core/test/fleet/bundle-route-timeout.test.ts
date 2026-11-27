// The member's bundle route lifts its socket's idle limit before git starts: making a bundle may take
// up to the bundle limit, while the transport closes a socket idle for 5 s.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { BUNDLE_TIMEOUT_MS } from "../../src/fleet/bundle.js";
import { serveRuns, type RunsDeps } from "../../src/fleet/serve-runs.js";
import { FLEET_TIMEOUT_MS } from "../../src/fleet/transport.js";
import type { TrustEntry } from "../../src/fleet/trust.js";

const RUN = "thor-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5";

test("GET bundle sets the socket's idle limit past the bundle limit before reading the run", async () => {
  const limits: number[] = [];
  let read = false;
  const req = { method: "GET", headers: { "agents-api-version": "3.3" }, socket: { setTimeout: (ms: number) => limits.push(ms) } } as unknown as IncomingMessage;
  const deps = {
    node: "thor",
    apiVersion: "3.3",
    service: {
      getRun: () => {
        read = true;
        assert.ok(limits.length === 1, "the limit was lifted before the run was read");
        return Promise.resolve(null);
      },
    },
  } as unknown as RunsDeps;
  const member = { node: "xxxxxxxx", fingerprint: "f".repeat(64) } as TrustEntry;
  const url = new URL(`https://fleet.invalid/v1/fleet/runs/${RUN}/bundle`);
  await assert.rejects(serveRuns(deps, member, req, {} as ServerResponse, url), /No run/);
  assert.ok(read);
  assert.deepEqual(limits, [BUNDLE_TIMEOUT_MS + FLEET_TIMEOUT_MS]);
  assert.ok((limits[0] ?? 0) > FLEET_TIMEOUT_MS);
});
