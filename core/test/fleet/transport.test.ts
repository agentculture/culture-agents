// Acceptance 1 of t21: two cores connect over an encrypted channel authenticated in both directions by
// key; an unknown key is refused before any request is read; no private key or reusable secret
// crosses the network (asserted on captured bytes).
import assert from "node:assert/strict";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect, createServer as createTlsServer } from "node:tls";
import { after, test } from "node:test";

import { certificateFor, fingerprint, fleetKeyText, newFleetKey } from "../../src/fleet/cert.js";
import { allowReplyFor, FleetCallError, fleetCall } from "../../src/fleet/transport.js";
import { LOOPBACK, recordingProxy, servingCore, sleep, tmp, trustOf } from "./support.js";

const t = tmp();
after(() => t.cleanup());

const version = { method: "GET", path: "/v1/version" } as const;

test("two cores authenticate each other by key and the caller reads the version", async () => {
  const caller = newFleetKey(); // the calling core
  const serving = await servingCore(t, [caller]); // the serving core trusts the caller's key only
  try {
    const res = await fleetCall({ key: caller, trust: trustOf(t, "caller", [serving.key]), host: LOOPBACK, port: serving.port, ...version });
    assert.equal(res.status, 200);
    assert.equal((JSON.parse(res.body.toString()) as { node: string }).node, "thor");
    assert.equal(res.member.fingerprint, fingerprint(serving.key), "the caller identified the serving core by its key");
    assert.equal(serving.requests.length, 1);
    assert.equal(serving.requests[0]?.fingerprint, fingerprint(caller), "the serving core identified the caller by its key");
  } finally {
    await serving.server.stop();
  }
});

test("the captured bytes hold no private key, no certificate and no plaintext request", async () => {
  const caller = newFleetKey();
  const serving = await servingCore(t, [caller]);
  const proxy = await recordingProxy(serving.port);
  try {
    const res = await fleetCall({ key: caller, trust: trustOf(t, "caller-cap", [serving.key]), host: LOOPBACK, port: proxy.port, ...version });
    assert.equal(res.status, 200);
    const wire = proxy.bytes();
    assert.ok(wire.length > 500, `bytes were captured (${wire.length})`);
    const needles: [string, Buffer][] = [
      ["plaintext request line", Buffer.from("GET /v1/version")],
      ["plaintext response field", Buffer.from("api_version")],
    ];
    for (const [who, key] of [["caller", caller], ["serving", serving.key]] as const) {
      const pkcs8 = key.export({ type: "pkcs8", format: "der" });
      needles.push([`${who} PKCS#8 DER`, pkcs8], [`${who} 32-byte seed`, pkcs8.subarray(pkcs8.length - 32)]);
      needles.push([`${who} key text`, Buffer.from(fleetKeyText(key))], [`${who} key PEM`, Buffer.from(key.export({ type: "pkcs8", format: "pem" }))]);
      needles.push([`${who} certificate DER (TLS 1.3 encrypts it)`, certificateFor(key).der]);
    }
    for (const [label, needle] of needles) assert.ok(!wire.includes(needle), `${label} is not on the wire`);
  } finally {
    proxy.close();
    await serving.server.stop();
  }
});

test("no session can be resumed on the fleet server, while a default TLS server resumes one", async () => {
  const caller = newFleetKey();
  const serving = await servingCore(t, [caller]);
  const opts = (port: number) => ({ host: LOOPBACK, port, key: caller.export({ type: "pkcs8", format: "pem" }), cert: certificateFor(caller).pem, ca: [certificateFor(serving.key).pem], minVersion: "TLSv1.3" as const, checkServerIdentity: () => undefined });
  const firstSession = (port: number): Promise<Buffer | null> =>
    new Promise((resolve) => {
      let got: Buffer | null = null;
      const s = tlsConnect(opts(port));
      s.on("session", (sess: Buffer) => (got = sess));
      s.on("secureConnect", () => s.write("GET /v1/version HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      s.on("data", () => undefined);
      s.on("close", () => resolve(got));
      s.on("error", () => undefined);
    });
  const resumes = async (port: number): Promise<boolean> => {
    const session = await firstSession(port);
    if (!session) return false;
    return new Promise((resolve) => {
      const s = tlsConnect({ ...opts(port), session });
      s.once("secureConnect", () => {
        resolve(s.isSessionReused());
        s.destroy();
      });
      s.on("error", () => resolve(false));
    });
  };
  const control = createTlsServer({ key: serving.key.export({ type: "pkcs8", format: "pem" }), cert: certificateFor(serving.key).pem, minVersion: "TLSv1.3" }, (s) => s.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"));
  await new Promise<void>((r) => control.listen(0, LOOPBACK, r));
  try {
    const addr = control.address();
    assert.equal(await resumes(typeof addr === "object" && addr ? addr.port : 0), true, "the check sees a resumption when a server allows one");
    assert.equal(await resumes(serving.port), false, "the fleet server resumed no session");
  } finally {
    control.close();
    await serving.server.stop();
  }
});

test("a core with an unknown key is refused before any request is read", async () => {
  const caller = newFleetKey();
  const stranger = newFleetKey(); // a key the serving core does not trust
  const serving = await servingCore(t, [caller]);
  try {
    await assert.rejects(fleetCall({ key: stranger, trust: trustOf(t, "stranger", [serving.key]), host: LOOPBACK, port: serving.port, ...version }));
    await sleep(50);
    assert.equal(serving.requests.length, 0, "no request reached the application");
    assert.ok(serving.logs.some((l) => l.includes("refused a peer before reading any request")), serving.logs.join("\n"));
    assert.ok(!serving.logs.join("\n").includes(fleetKeyText(stranger)), "the log holds no key");
  } finally {
    await serving.server.stop();
  }
});

test("a peer with no certificate at all is refused before any request is read", async () => {
  const serving = await servingCore(t, [newFleetKey()]);
  try {
    await new Promise<void>((resolve) => {
      const s = tlsConnect({ host: LOOPBACK, port: serving.port, minVersion: "TLSv1.3", rejectUnauthorized: false });
      s.on("secureConnect", () => s.write("GET /v1/version HTTP/1.1\r\nHost: x\r\n\r\n"));
      s.on("data", () => undefined);
      s.on("close", () => resolve());
      s.on("error", () => undefined);
    });
    assert.equal(serving.requests.length, 0);
  } finally {
    await serving.server.stop();
  }
});

test("the caller refuses a server whose key it does not trust, and the server reads nothing from it", async () => {
  const caller = newFleetKey();
  const impostor = await servingCore(t, [caller]); // trusts the caller, but is not the key the caller expects
  try {
    const err = await fleetCall({ key: caller, trust: trustOf(t, "expects-other", [newFleetKey()]), host: LOOPBACK, port: impostor.port, ...version }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof FleetCallError && err.code === "EUNTRUSTED", String(err));
    await sleep(50);
    assert.equal(impostor.requests.length, 0);
  } finally {
    await impostor.server.stop();
  }
});

test("a handshake that never starts is cut off by the handshake timeout", async () => {
  const serving = await servingCore(t, [newFleetKey()], { handshakeTimeoutMs: 100 });
  try {
    await new Promise<void>((resolve) => {
      const s = netConnect(serving.port, LOOPBACK); // connects, then sends nothing
      s.on("close", () => resolve());
      s.on("error", () => undefined);
    });
    assert.equal(serving.requests.length, 0);
  } finally {
    await serving.server.stop();
  }
});

test("stopping the server also ends a connection still in its handshake", async () => {
  const serving = await servingCore(t, [newFleetKey()], { handshakeTimeoutMs: 600_000 });
  const closed = new Promise<void>((resolve) => {
    const s = netConnect(serving.port, LOOPBACK);
    s.on("connect", () => {
      setTimeout(() => {
        serving.server.stop().catch(() => undefined);
      }, 50);
    });
    s.on("close", () => resolve());
    s.on("error", () => undefined);
  });
  await closed;
  await serving.server.stop();
});

test("a call reads at most the response cap and gives up after its timeout", async () => {
  const caller = newFleetKey();
  const flood = await servingCore(t, [caller], { onRequest: (_m, _q, res) => res.end(Buffer.alloc(64 * 1024, 0x61)) });
  const silent = await servingCore(t, [caller], { onRequest: () => undefined, requestTimeoutMs: 60_000 });
  try {
    const big = await fleetCall({ key: caller, trust: trustOf(t, "flood", [flood.key]), host: LOOPBACK, port: flood.port, maxResponseBytes: 1024, ...version }).catch((e: unknown) => e);
    assert.ok(big instanceof FleetCallError && big.code === "ETOOLARGE", String(big));
    const slow = await fleetCall({ key: caller, trust: trustOf(t, "silent", [silent.key]), host: LOOPBACK, port: silent.port, timeoutMs: 200, ...version }).catch((e: unknown) => e);
    assert.ok(slow instanceof FleetCallError && slow.code === "ETIMEDOUT", String(slow));
  } finally {
    await flood.server.stop();
    await silent.server.stop();
  }
});

test("only the version route is served to a member; a local control route is not reachable", async () => {
  const caller = newFleetKey();
  const serving = await servingCore(t, [caller]);
  try {
    const res = await fleetCall({ key: caller, trust: trustOf(t, "routes", [serving.key]), host: LOOPBACK, port: serving.port, method: "GET", path: "/v1/runs" });
    assert.equal(res.status, 404);
    assert.equal((JSON.parse(res.body.toString()) as { error: { code: string } }).error.code, "not_found");
  } finally {
    await serving.server.stop();
  }
});

test("a route that needs longer than the idle limit can lift it for its own reply; without that the socket is closed", async () => {
  const caller = newFleetKey();
  const slow = (lift: boolean) => servingCore(t, [caller], {
    requestTimeoutMs: 200,
    onRequest: (_m, req, res) => {
      if (lift) allowReplyFor(req, 5000);
      setTimeout(() => res.end("ok"), 600);
    },
  });
  const lifted = await slow(true);
  const plain = await slow(false);
  try {
    const ok = await fleetCall({ key: caller, trust: trustOf(t, "lifted", [lifted.key]), host: LOOPBACK, port: lifted.port, timeoutMs: 5000, ...version });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.toString(), "ok");
    const cut = await fleetCall({ key: caller, trust: trustOf(t, "plain", [plain.key]), host: LOOPBACK, port: plain.port, timeoutMs: 5000, ...version }).catch((e: unknown) => e);
    assert.ok(cut instanceof Error, "without the lift the serving core closes the socket at its idle limit");
  } finally {
    await lifted.server.stop();
    await plain.server.stop();
  }
});
