/** t24: admission across hosts: the executing core decides on harness, limits and signals. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Admission, Capabilities, ErrorBody, Signal, SubmitRequest } from "../../src/contract/index.js";
import { ControlError } from "../../src/daemon/errors.js";
import { admitSubmit, readAdmission } from "../../src/runs/admission.js";
import { gatewayFromPayload, GATEWAY_NO_FIELD, readGateway } from "../../src/runs/gateway.js";
import type { HarnessCatalog } from "../../src/runs/ports.js";
import { StoreRunService } from "../../src/runs/service.js";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const nowS = NOW.getTime() / 1000;
const heatFile = (admit: boolean, at = nowS - 1) => JSON.stringify({ host: "thor", at, stale_after_s: 10, level: admit ? "normal" : "hot", admit, concurrency_factor: 1 });
const sig = (state: Signal["state"], consulted = true): Signal => ({ state, consulted, reason: state === "admit" ? null : "why", observed_at: state === "unknown" ? null : NOW.toISOString() });
const adm = (heat: Signal, gateway: Signal = sig("unknown", false)): Admission => ({ heat, gateway });
const heldBy = (fn: () => unknown): ErrorBody => {
  try { fn(); } catch (e) { assert.ok(e instanceof ControlError); return e.body; }
  assert.fail("expected a refusal");
};

test("remote: admit passes; hold is a typed admission_held naming the signal, state and observed_at", () => {
  assert.deepEqual(admitSubmit(adm(sig("admit")), "remote"), []);
  const body = heldBy(() => admitSubmit(adm(sig("hold")), "remote"));
  assert.deepEqual([body.code, body.retryable, body.signal], ["admission_held", true, { name: "heat", state: "hold", observed_at: NOW.toISOString() }]);
  const gw = heldBy(() => admitSubmit(adm(sig("admit"), sig("hold")), "remote"));
  assert.equal(gw.signal?.name, "gateway");
});

test("a hold refuses a local submit's remote twin only: local admits a hold in part one's way (no refusal)", () => {
  assert.deepEqual(admitSubmit(adm(sig("hold")), "local"), []);
});

test("unknown: a remote submit is refused, a local one admitted with a warning", () => {
  const body = heldBy(() => admitSubmit(adm(sig("unknown")), "remote"));
  assert.deepEqual([body.code, body.signal], ["admission_held", { name: "heat", state: "unknown", observed_at: null }]);
  assert.deepEqual(admitSubmit(adm(sig("unknown")), "local").map((w) => [w.code, w.signal]), [["signal_unknown", "heat"]]);
  assert.deepEqual(admitSubmit(adm(sig("admit"), sig("unknown", false)), "remote"), [], "a signal that was not consulted never refuses");
});

test("a missing or stale heat reading reads unknown and never throws out of the reader", async () => {
  const missing = await readAdmission({ HEAT_GOVERNOR_STATE: "/x" }, NOW, () => { throw new Error("ENOENT"); });
  const stale = await readAdmission({ HEAT_GOVERNOR_STATE: "/x" }, NOW, () => heatFile(true, nowS - 60));
  for (const a of [missing, stale]) {
    assert.equal(a.heat.state, "unknown");
    assert.equal(heldBy(() => admitSubmit(a, "remote")).signal?.state, "unknown");
    assert.equal(admitSubmit(a, "local").length, 1);
  }
});

const status = (admission?: unknown) => JSON.stringify(admission === undefined ? { version: "0.99.0" } : { admission });

test("the gateway is read only from the admit field with a timestamp; with the field absent it is not consulted", async () => {
  const absent = gatewayFromPayload(status(), NOW);
  assert.deepEqual([absent.consulted, absent.state, absent.reason], [false, "unknown", GATEWAY_NO_FIELD]);
  assert.equal(gatewayFromPayload("{}", NOW).consulted, false);
  assert.deepEqual(admitSubmit(adm(sig("admit"), absent), "remote"), [], "an absent field never refuses a remote submit");
  assert.deepEqual(admitSubmit(adm(sig("admit"), absent), "local"), [], "nor warns a local one");
  // Something that looks like admission elsewhere in the body is not read.
  assert.equal(gatewayFromPayload(JSON.stringify({ admit: false, at: NOW.toISOString(), stale_after_s: 10, status: { admit: false } }), NOW).consulted, false);
  // With the field: read; a hold refuses remote, a broken one is consulted-unknown.
  const at = new Date(NOW.getTime() - 1000).toISOString();
  const present = gatewayFromPayload(status({ admit: false, at, stale_after_s: 10, reason: "busy" }), NOW);
  assert.deepEqual([present.consulted, present.state], [true, "hold"]);
  assert.equal(heldBy(() => admitSubmit(adm(sig("admit"), present), "remote")).signal?.name, "gateway");
  const broken = gatewayFromPayload(status({ admit: "yes" }), NOW);
  assert.deepEqual([broken.consulted, broken.state], [true, "unknown"]);
  const fetched = await readGateway({ harnesses: ["h"], url: "http://127.0.0.1:1/v1", fetch: async () => new Response(status()) }, NOW);
  assert.equal(fetched.consulted, false);
});

function service(root: string, over: { available?: boolean; limits?: boolean; heat: string }): StoreRunService {
  const caps = { harness: "fake", available: over.available ?? true } as unknown as Capabilities; // the submit path reads only `available`
  const entry = { id: "fake", capabilities: () => Promise.resolve(caps), driver: { module: "/nonexistent.js", options: {} } };
  const catalog: HarnessCatalog = { list: () => [entry], get: (id) => (id === "fake" ? entry : undefined) };
  return new StoreRunService({
    stateDir: root, node: "thor", catalog, allowlist: () => ({ entries: [] }) as never, now: () => NOW,
    env: { HEAT_GOVERNOR_STATE: "/heat" }, readHeatFile: () => over.heat,
    ...(over.limits === true && { limits: { runs_per_repository: null, runs_per_host: 0 } }),
  });
}
const request: SubmitRequest = { agent_id: "thor-culture-agents", harness: "fake", repo: "/nowhere", task: "t", caller: { kind: "operator", id: "thor-operator" } };

test("through the service: harness first, then limits, then the signals; a refused remote submit queues nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "t24-"));
  try {
    const refusal = async (svc: StoreRunService, remote: boolean): Promise<ErrorBody> => {
      try { await svc.submit(request, undefined, { remote }); } catch (e) { assert.ok(e instanceof ControlError); return e.body; }
      return assert.fail("expected a refusal");
    };
    const held = await refusal(service(root, { heat: heatFile(false) }), true);
    assert.deepEqual([held.code, held.signal?.name, held.signal?.state], ["admission_held", "heat", "hold"]);
    const unknown = await refusal(service(root, { heat: "not json" }), true);
    assert.deepEqual([unknown.code, unknown.signal?.state], ["admission_held", "unknown"]);
    assert.equal((await refusal(service(root, { heat: heatFile(false), available: false }), true)).code, "unavailable", "the harness is checked before the signals");
    assert.equal((await refusal(service(root, { heat: heatFile(false), limits: true }), true)).code, "limit_reached", "a limit is checked before the signals");
    assert.deepEqual(await service(root, { heat: heatFile(false) }).listRuns({ limit: 50 }), [], "nothing was queued");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
