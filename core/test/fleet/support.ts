// Shared plumbing for the fleet transport tests. Each "core" here is thor's fixture: a key, a trust
// file and, for a serving core, a fleet server on loopback. Two of them stand for two cores; they are
// named by role (the serving core, the calling core), never by a made-up host name.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { createServer, connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { certificateFor, newFleetKey } from "../../src/fleet/cert.js";
import { memberRoutes } from "../../src/fleet/index.js";
import { startFleetServer, type FleetServer, type FleetServerOptions } from "../../src/fleet/transport.js";
import { loadTrust, type TrustEntry, type TrustList } from "../../src/fleet/trust.js";

export const LOOPBACK = "127.0.0.1";

export interface Tmp {
  dir: string;
  cleanup(): void;
}

export function tmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "ca-fleet-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A trust entry for `key` under the example node name. */
export const entry = (key: KeyObject): { node: string; cert: string } => ({ node: "thor", cert: certificateFor(key).text });

export function writeTrust(path: string, keys: readonly KeyObject[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keys.map(entry)));
}

/** A trust list held in memory, as a calling core passes it to `fleetCall`. */
export function trustOf(t: Tmp, name: string, keys: readonly KeyObject[]): TrustList {
  const path = join(t.dir, `${name}.json`);
  writeTrust(path, keys);
  return loadTrust(path);
}

export interface ServingCore {
  key: KeyObject;
  trustPath: string;
  server: FleetServer;
  port: number;
  /** Members whose requests reached the application. */
  requests: TrustEntry[];
  logs: string[];
}

/** A serving core on loopback that trusts `trusted`. Its routes are the transport's own unless given. */
export async function servingCore(t: Tmp, trusted: readonly KeyObject[], extra: Partial<FleetServerOptions> = {}): Promise<ServingCore> {
  const key = extra.key ?? newFleetKey();
  const trustPath = join(t.dir, `serving-${Math.random().toString(36).slice(2)}.json`);
  writeTrust(trustPath, trusted);
  const requests: TrustEntry[] = [];
  const logs: string[] = [];
  const routes = extra.onRequest ?? memberRoutes("thor");
  const server = await startFleetServer({
    host: LOOPBACK,
    port: 0,
    log: (l) => logs.push(l),
    ...extra,
    key,
    trustPath,
    onRequest: (member, req, res) => {
      requests.push(member);
      routes(member, req, res);
    },
  });
  return { key, trustPath, server, port: server.address.port, requests, logs };
}

/** A TCP proxy that records every byte in both directions. */
export async function recordingProxy(targetPort: number): Promise<{ port: number; bytes: () => Buffer; close: () => void }> {
  const captured: Buffer[] = [];
  const server: Server = createServer((client) => {
    const upstream = connect(targetPort, LOOPBACK);
    client.on("data", (d: Buffer) => {
      captured.push(Buffer.from(d));
      upstream.write(d);
    });
    upstream.on("data", (d: Buffer) => {
      captured.push(Buffer.from(d));
      client.write(d);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, bytes: () => Buffer.concat(captured), close: () => server.close() };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
