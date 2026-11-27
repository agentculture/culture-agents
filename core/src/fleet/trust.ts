/**
 * A core's trust list (docs/d2/part-two-design.md, Decision 1): the members it accepts, as
 * `[{ "node": "thor", "cert": "<base64 DER>" }]` in `${XDG_CONFIG_HOME:-$HOME/.config}/culture-agents/fleet/trust.json`.
 * The file is local and untracked, like the allow-list. It holds certificates only, which are public:
 * no member's trust list holds anything that gives access to another member's private key.
 *
 * Adding a member is adding its certificate; removing it revokes the member on its next connection.
 * A list that gives one node name to two keys, or one key to two names, is refused: the core does
 * not start with it, and a running transport that reads it refuses every peer until it is fixed.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { X509Certificate } from "node:crypto";

import { FleetKeyError, fingerprint, parseMemberCertificate } from "./cert.js";

export interface TrustEntry {
  readonly node: string;
  /** The certificate's one-line form, as written in the file. */
  readonly cert: string;
  readonly pem: string;
  /** SHA-256 of the member's public key, hex. */
  readonly fingerprint: string;
}

export type TrustList = readonly TrustEntry[];

export class TrustConfigError extends Error {
  override readonly name = "TrustConfigError";
}

/** The most a trust file may hold. A member entry is about 300 bytes. */
export const MAX_TRUST_FILE_BYTES = 1024 * 1024;
const NODE_NAME = /^[a-z0-9]{1,32}$/;

type Env = Readonly<Record<string, string | undefined>>;

export function resolveTrustPath(env: Env = process.env): string {
  const config = env["XDG_CONFIG_HOME"] || join(env["HOME"] || homedir(), ".config");
  return join(config, "culture-agents", "fleet", "trust.json");
}

function parseEntry(raw: unknown, index: number, path: string): TrustEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TrustConfigError(`entry ${index} in ${path} must be an object`);
  const extra = Object.keys(raw).filter((k) => k !== "node" && k !== "cert");
  if (extra.length > 0) throw new TrustConfigError(`entry ${index} in ${path} has unknown field ${extra[0]} (known: node, cert)`);
  const { node, cert } = raw as { node?: unknown; cert?: unknown };
  if (typeof node !== "string" || !NODE_NAME.test(node)) throw new TrustConfigError(`entry ${index} in ${path}: node must be 1 to 32 lowercase letters or digits`);
  if (typeof cert !== "string") throw new TrustConfigError(`entry ${index} in ${path}: cert must be a string`);
  let parsed: { cert: X509Certificate; pem: string };
  try {
    parsed = parseMemberCertificate(cert);
  } catch (e) {
    throw new TrustConfigError(`entry ${index} in ${path} (${node}): ${e instanceof FleetKeyError ? e.message : "not a member certificate"}`);
  }
  return { node, cert, pem: parsed.pem, fingerprint: fingerprint(parsed.cert) };
}

/** Parse the text of a trust file. Throws `TrustConfigError` on anything but a valid, unambiguous list. */
export function parseTrust(text: string, path: string): TrustList {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TrustConfigError(`${path} is not valid JSON`);
  }
  if (!Array.isArray(raw)) throw new TrustConfigError(`${path} must hold a JSON array of { node, cert } entries`);
  const entries = raw.map((r, i) => parseEntry(r, i, path));
  const names = new Map<string, string>();
  const keys = new Map<string, string>();
  for (const e of entries) {
    if (names.has(e.node)) throw new TrustConfigError(`${path} gives the node name ${e.node} to two keys; one name, one key`);
    if (keys.has(e.fingerprint)) throw new TrustConfigError(`${path} gives one key to two node names (${keys.get(e.fingerprint) ?? ""} and ${e.node})`);
    names.set(e.node, e.fingerprint);
    keys.set(e.fingerprint, e.node);
  }
  return entries;
}

/** The file's text, read with a cap; null when it does not exist. */
export function readTrustText(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new TrustConfigError(`cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_TRUST_FILE_BYTES) throw new TrustConfigError(`${path} is larger than ${MAX_TRUST_FILE_BYTES} bytes`);
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The trust list in `path`; empty when the file does not exist (nobody is trusted). */
export function loadTrust(path: string): TrustList {
  const text = readTrustText(path);
  return text === null ? [] : parseTrust(text, path);
}

/** The entry for a peer's certificate, matched on its public key; undefined when the peer is not a member. */
export function memberFor(peer: X509Certificate | undefined, trust: TrustList): TrustEntry | undefined {
  if (!peer) return undefined;
  const fp = fingerprint(peer);
  return trust.find((t) => t.fingerprint === fp);
}

/**
 * A trust list read again on every call, for the transport's per-connection check. When the file
 * changes to something invalid, the list is empty (every peer refused) and `onError` says why.
 * `changed` tells the caller to install the new list in the TLS context.
 */
export function trustSource(path: string, onError: (message: string) => void): () => { list: TrustList; changed: boolean } {
  let lastText: string | null | undefined;
  let list: TrustList = [];
  return () => {
    let text: string | null;
    try {
      text = readTrustText(path);
    } catch (e) {
      lastText = undefined; // read again next time
      list = [];
      onError(`fleet trust list unreadable, every peer is refused: ${(e as Error).message}`);
      return { list, changed: true };
    }
    if (text === lastText) return { list, changed: false };
    lastText = text;
    try {
      list = text === null ? [] : parseTrust(text, path);
    } catch (e) {
      list = [];
      onError(`fleet trust list refused, every peer is refused until it is fixed: ${(e as Error).message}`);
    }
    return { list, changed: true };
  };
}
