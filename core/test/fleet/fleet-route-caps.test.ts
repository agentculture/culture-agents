// The caller's routes for a remote run read the member's answer under a cap that fits it: a
// result carries a summary of every text line of the run, so it may pass the transport's 1 MiB.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fleetRunsResult } from "../../src/daemon/fleet-routes.js";
import { MAX_PAGE_BYTES } from "../../src/fleet/remote-attach.js";
import type { Remote, RemoteRequest } from "../../src/fleet/remote.js";
import { MAX_RESPONSE_BYTES } from "../../src/fleet/transport.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contract", "fixtures");
const result = JSON.parse(readFileSync(join(FIXTURES, "valid", "run", "run_result.succeeded.json"), "utf8")) as { run_id: string; summary: string };

test("a remote run's result is read under the page cap, not the transport's 1 MiB", async () => {
  const asked: RemoteRequest[] = [];
  const big = { ...result, summary: "x".repeat(MAX_RESPONSE_BYTES + 1000) };
  const remote: Remote = {
    apiVersion: "3.3",
    request: (_node, r) => {
      asked.push(r);
      return Promise.resolve(big);
    },
    fetchBytes: () => Promise.reject(new Error("not used")),
  };
  let sent = "";
  const res = { writeHead: () => res, end: (text: string) => (sent = text) } as unknown as ServerResponse;
  await fleetRunsResult({ remote, node: "caller", req: {} as IncomingMessage, res, url: new URL("https://fleet.invalid/"), runId: result.run_id } as never);
  assert.equal(asked[0]?.maxBytes, MAX_PAGE_BYTES);
  assert.ok(sent.length > MAX_RESPONSE_BYTES, "the whole summary reached the caller");
});
