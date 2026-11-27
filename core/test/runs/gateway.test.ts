/** t31: the capability report reads the model gateway's admission object. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { gatewayFromPayload, readGateway, type GatewaySource } from "../../src/runs/gateway.js";
import { readAdmission, submitWarnings } from "../../src/runs/admission.js";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const body = (over: Record<string, unknown> = {}) => JSON.stringify({ admission: { admit: true, at: new Date(NOW.getTime() - 1000).toISOString(), stale_after_s: 10, ...over } });
const reply = (text: string, status = 200, headers: Record<string, string> = {}) => async () => new Response(text, { status, headers });
const source = (fetchFn: typeof fetch, extra: Partial<GatewaySource> = {}): GatewaySource => ({ harnesses: ["opencode"], url: "http://127.0.0.1:8001/v1", fetch: fetchFn, timeoutMs: 50, ...extra });

test("admit, hold and unknown come from the admission object", () => {
  assert.deepEqual([gatewayFromPayload(body(), NOW).state, gatewayFromPayload(body(), NOW).consulted], ["admit", true]);
  const hold = gatewayFromPayload(body({ admit: false, reason: "queue full" }), NOW);
  assert.equal(hold.state, "hold");
  assert.match(hold.reason ?? "", /queue full/);
  assert.equal(gatewayFromPayload(body(), NOW).observed_at, new Date(NOW.getTime() - 1000).toISOString());
});

test("a missing field, a stale or future sample, or bad JSON reads unknown, never admit", () => {
  const bads = [
    "not json", "[]", JSON.stringify({ admission: null }),
    body({ admit: undefined }), body({ admit: "yes" }), body({ at: undefined }), body({ at: "yesterday" }), body({ at: 12345 }),
    body({ stale_after_s: undefined }), body({ stale_after_s: 0 }),
    body({ at: new Date(NOW.getTime() - 11_000).toISOString() }),
    body({ at: new Date(NOW.getTime() + 60_000).toISOString() }),
  ];
  for (const bad of bads) assert.equal(gatewayFromPayload(bad, NOW).state, "unknown", bad);
  assert.match(gatewayFromPayload(body({ at: new Date(NOW.getTime() - 11_000).toISOString() }), NOW).reason ?? "", /stale/);
  assert.match(gatewayFromPayload(body({ at: new Date(NOW.getTime() + 60_000).toISOString() }), NOW).reason ?? "", /future/);
});

test("the reader asks /status at the configured gateway's origin", async () => {
  let asked = "";
  const s = await readGateway(source(async (u) => { asked = String(u); return new Response(body()); }), NOW);
  assert.equal(asked, "http://127.0.0.1:8001/status");
  assert.equal(s.state, "admit");
});

test("a timeout, a refusal, a bad status or a non-loopback redirect reads unknown", async () => {
  const never = () => new Promise<Response>(() => {});
  const t0 = Date.now();
  assert.equal((await readGateway(source(never), NOW)).state, "unknown");
  assert.ok(Date.now() - t0 < 1000, "a slow gateway cannot delay the call past the timeout");
  const refused = async (): Promise<Response> => { throw new TypeError("fetch failed: ECONNREFUSED"); };
  assert.equal((await readGateway(source(refused), NOW)).state, "unknown");
  assert.equal((await readGateway(source(reply(body(), 500)), NOW)).state, "unknown");
  const redirect = reply("", 302, { location: "http://example.invalid/status" });
  const r = await readGateway(source(redirect), NOW);
  assert.equal(r.state, "unknown");
  assert.match(r.reason ?? "", /redirect/);
  // A redirect to loopback is followed once and read.
  let calls = 0;
  const hop = async () => (calls++ === 0 ? new Response("", { status: 302, headers: { location: "http://127.0.0.1:9/status" } }) : new Response(body()));
  assert.equal((await readGateway(source(hop), NOW)).state, "admit");
});

test("a harness that does not use the gateway stays not consulted; one that does is consulted", async () => {
  let calls = 0;
  const s = source(async () => { calls++; return new Response(body()); });
  const env = { HEAT_GOVERNOR_STATE: "/x" };
  const other = await readAdmission(env, NOW, () => "", s, "claude-code");
  assert.deepEqual([other.gateway.consulted, other.gateway.state, calls], [false, "unknown", 0]);
  assert.equal((await readAdmission(env, NOW, () => "", undefined, "opencode")).gateway.consulted, false);
  const used = await readAdmission(env, NOW, () => "", s, "opencode");
  assert.deepEqual([used.gateway.consulted, used.gateway.state, calls], [true, "admit", 1]);
});

test("an unknown gateway warns; a hold does not refuse or warn", async () => {
  const env = { HEAT_GOVERNOR_STATE: "/x" };
  const heat = JSON.stringify({ at: NOW.getTime() / 1000 - 1, stale_after_s: 10, level: "normal", admit: true });
  const unknown = await readAdmission(env, NOW, () => heat, source(reply(JSON.stringify({ admission: { admit: "yes" } }))), "opencode");
  assert.deepEqual(submitWarnings(unknown).map((w) => [w.code, w.signal]), [["signal_unknown", "gateway"]]);
  const absent = await readAdmission(env, NOW, () => heat, source(reply("{}")), "opencode");
  assert.deepEqual([absent.gateway.consulted, submitWarnings(absent)], [false, []], "no admission field: not consulted, no warning");
  const hold = await readAdmission(env, NOW, () => heat, source(reply(body({ admit: false }))), "opencode");
  assert.equal(hold.gateway.state, "hold");
  assert.deepEqual(submitWarnings(hold), []);
});

test("through the daemon: capability and submit read the gateway; unknown warns, hold does not refuse, a hung gateway delays nothing past the timeout", async (t) => {
  const { createServer } = await import("node:http");
  const { HANG, makeEnv, ok, startDaemon, submitBody } = await import("./support.js");
  type Caps = import("../../src/contract/index.js").Capabilities;
  type Sub = import("../../src/contract/index.js").SubmitResponse;
  let mode: "admit" | "hold" | "missing" | "malformed" | "hang" = "admit";
  const server = createServer((_req, res) => {
    if (mode === "hang") return; // never answers
    const at = new Date().toISOString();
    res.setHeader("content-type", "application/json");
    res.end(mode === "missing" ? "{}" : mode === "malformed" ? JSON.stringify({ admission: { admit: "yes" } }) : JSON.stringify({ admission: { admit: mode === "admit", at, stale_after_s: 30, reason: "busy" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  const env = makeEnv(t, [HANG]);
  env.vars["FAKE_GATEWAY_URL"] = `http://127.0.0.1:${port}/v1`;
  env.vars["HEAT_GOVERNOR_STATE"] = "/nonexistent/heat.json";
  await startDaemon(t, env);
  const report = () => ok<Caps>(env, "GET", "/v1/harnesses/fake", 200, "capabilities");
  assert.deepEqual([(await report()).admission?.gateway.consulted, (await report()).admission?.gateway.state], [true, "admit"]);
  mode = "hold";
  assert.equal((await report()).admission?.gateway.state, "hold");
  const held = await ok<Sub>(env, "POST", "/v1/runs", 201, "control-action#submit_response", submitBody("fake", env.repoA));
  assert.deepEqual(held.warnings?.map((w) => w.signal), ["heat"], "a hold is admitted in part one, with no gateway warning");
  mode = "missing";
  const absent = await ok<Sub>(env, "POST", "/v1/runs", 201, "control-action#submit_response", submitBody("fake", env.repoB));
  assert.deepEqual(absent.warnings?.map((w) => w.signal), ["heat"], "no admission field: the gateway is not consulted, so it does not warn");
  mode = "malformed";
  const unknown = await ok<Sub>(env, "POST", "/v1/runs", 201, "control-action#submit_response", submitBody("fake", env.repoB));
  assert.deepEqual(unknown.warnings?.map((w) => w.signal).sort(), ["gateway", "heat"]);
  mode = "hang";
  const t0 = Date.now();
  const slow = await report();
  assert.equal(slow.admission?.gateway.state, "unknown");
  assert.ok(Date.now() - t0 < 2500, "the call returns within the timeout plus a margin");
});

test("the core asks the gateway on loopback when the harness is configured with the sandbox's name for the host", async () => {
  const { hostView } = await import("../../src/daemon/harness-catalog.js");
  assert.equal(hostView("http://host.openshell.internal:8001/v1"), "http://127.0.0.1:8001/v1");
  assert.equal(hostView("http://HOST.openshell.internal:9000/v1"), "http://127.0.0.1:9000/v1");
  assert.equal(hostView("http://127.0.0.1:8001/v1"), "http://127.0.0.1:8001/v1");
  assert.equal(hostView("https://gateway.example/v1"), "https://gateway.example/v1");
  assert.equal(hostView("not a url"), "not a url");
});

