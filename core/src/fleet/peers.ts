/**
 * The local address list a core announces itself to (docs/d2/part-two-design.md, Decision 3):
 * `${XDG_CONFIG_HOME:-$HOME/.config}/culture-agents/fleet/peers.json`, beside the trust list, as a
 * JSON array of `"<ip>:<port>"` or `"[<ipv6>]:<port>"` strings. It is configuration, not membership:
 * an address with no live core behind it is never listed, and a core is listed only under the name
 * its key holds in the trust list. It is local and untracked, and it is the only place a core keeps
 * an address. IP addresses only: nothing here resolves a name, so no name can redirect a call.
 * A missing file announces to nobody; the core still hears the peers that announce to it.
 */
import { join } from "node:path";

import { FleetConfigError, parseAddress } from "./config.js";
import { readTrustText, resolveTrustPath } from "./trust.js";

export interface PeerAddress {
  host: string;
  port: number;
}

/** The most peers one core announces to; each costs one TLS handshake per interval. */
export const MAX_PEERS = 64;

type Env = Readonly<Record<string, string | undefined>>;

export function resolvePeersPath(env: Env = process.env): string {
  return join(resolveTrustPath(env), "..", "peers.json");
}

/** Parse the text of an address list. Throws `FleetConfigError` on anything but a valid list. */
export function parsePeers(text: string, path: string): PeerAddress[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FleetConfigError(`${path} is not valid JSON`);
  }
  if (!Array.isArray(raw)) throw new FleetConfigError(`${path} must hold a JSON array of "<ip>:<port>" strings`);
  if (raw.length > MAX_PEERS) throw new FleetConfigError(`${path} lists ${raw.length} addresses; at most ${MAX_PEERS}`);
  const seen = new Set<string>();
  const out: PeerAddress[] = [];
  raw.forEach((value: unknown, i) => {
    if (typeof value !== "string") throw new FleetConfigError(`entry ${i} in ${path} must be a string`);
    const address = parseAddress(value, `entry ${i} in ${path}`, 1);
    const id = `${address.host} ${address.port}`;
    if (!seen.has(id)) out.push(address);
    seen.add(id);
  });
  return out;
}

/** The address list in `path`; empty when the file does not exist. Read with the trust file's cap. */
export function loadPeers(path: string): PeerAddress[] {
  let text: string | null;
  try {
    text = readTrustText(path);
  } catch (e) {
    throw new FleetConfigError((e as Error).message);
  }
  return text === null ? [] : parsePeers(text, path);
}

/**
 * The address list read again on every call, so the operator can change it without a restart. A
 * list that turns invalid announces to nobody until it is fixed; `onError` says why, once per change.
 */
export function peersSource(path: string, onError: (message: string) => void): () => PeerAddress[] {
  let lastError: string | null = null;
  return () => {
    try {
      const peers = loadPeers(path);
      lastError = null;
      return peers;
    } catch (e) {
      const message = (e as Error).message;
      if (message !== lastError) onError(`fleet address list refused, announcing to nobody until it is fixed: ${message}`);
      lastError = message;
      return [];
    }
  };
}
