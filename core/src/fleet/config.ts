/**
 * Whether the fleet transport runs, and with what (docs/d2/part-two-design.md, Decisions 1 and 2).
 *
 * The transport is OFF unless `CULTURE_AGENTS_FLEET_LISTEN` names an address to listen on, as
 * `<ip>:<port>` or `[<ipv6>]:<port>`. A name is refused: the operator says exactly which interface.
 * With it set, the core needs its key (`CULTURE_AGENTS_FLEET_KEY`, taken from the environment with
 * the other injected secrets before any socket listens; daemon/secrets.ts) and a valid trust list
 * (trust.ts), and the local address list beside it must be valid when present (peers.ts). Anything
 * wrong stops the core before its Unix socket listens, and no message prints the key. This module reads the listen variable, the trust file and the held key, and nothing
 * else: it never reads the chat mesh's configuration or its link password.
 */
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import type { KeyObject } from "node:crypto";

import { FLEET_KEY_ENV, FleetKeyError, parseFleetKey } from "./cert.js";
import { loadPeers } from "./peers.js";
import { loadTrust, resolveTrustPath, TrustConfigError, type TrustList } from "./trust.js";

export const FLEET_LISTEN_ENV = "CULTURE_AGENTS_FLEET_LISTEN";

export class FleetConfigError extends Error {
  override readonly name = "FleetConfigError";
}

export interface FleetConfig {
  host: string;
  port: number;
  key: KeyObject;
  trustPath: string;
  /** The list as read at start; the transport reads the file again for each connection. */
  trust: TrustList;
  /** The local address list this core announces to (peers.ts), beside the trust list. */
  peersPath: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `<ip>:<port>` or `[<ipv6>]:<port>`, with an IP address, never a name (nothing is resolved). `what`
 * names the setting in the message; `minPort` is 0 for a listen address (a free port), 1 for a peer.
 */
export function parseAddress(value: string, what: string, minPort = 0): { host: string; port: number } {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(value) ?? /^([^:[\]]+):(\d{1,5})$/.exec(value);
  const host = m?.[1] ?? "";
  const port = Number(m?.[2] ?? "-1");
  if (!m || isIP(host) === 0) throw new FleetConfigError(`${what} must be <ip>:<port> or [<ipv6>]:<port> with an IP address, not a name`);
  if (port < minPort || port > 65535) throw new FleetConfigError(`${what}: the port must be ${minPort} to 65535`);
  return { host, port };
}

/** `<ip>:<port>` or `[<ipv6>]:<port>`; port 0 to 65535 (0 picks a free port). */
export function parseListen(value: string): { host: string; port: number } {
  return parseAddress(value, FLEET_LISTEN_ENV);
}

/**
 * The fleet configuration, or null when the transport is off. `heldKey` is the key text taken from
 * the environment at start (`heldSecret(FLEET_KEY_ENV)`); it is never read from `env` here.
 */
export function loadFleetConfig(env: Env, heldKey: string | undefined, trustPath?: string): FleetConfig | null {
  const listen = env[FLEET_LISTEN_ENV]?.trim();
  if (listen === undefined || listen === "") return null;
  const { host, port } = parseListen(listen);
  if (heldKey === undefined) throw new FleetConfigError(`${FLEET_LISTEN_ENV} is set but ${FLEET_KEY_ENV} is not; inject the key with grant run --inject`);
  let key: KeyObject;
  try {
    key = parseFleetKey(heldKey);
  } catch (e) {
    throw new FleetConfigError(e instanceof FleetKeyError ? e.message : `${FLEET_KEY_ENV} is not a valid key`);
  }
  const path = trustPath ?? resolveTrustPath(env);
  let trust: TrustList;
  try {
    trust = loadTrust(path);
  } catch (e) {
    throw new FleetConfigError(e instanceof TrustConfigError ? e.message : `cannot read ${path}`);
  }
  const peersPath = join(dirname(path), "peers.json");
  loadPeers(peersPath); // an invalid address list stops the core here, as an invalid trust list does
  return { host, port, key, trustPath: path, trust, peersPath };
}
