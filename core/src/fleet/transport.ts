/**
 * The network transport between cores (docs/d2/part-two-design.md, Decision 1), beside the Unix
 * socket and off unless configured (fleet/config.ts). Node's standard library only.
 *
 * - TLS 1.3 only, authenticated in both directions. Each core presents the certificate derived in
 *   memory from its Ed25519 key (cert.ts) and trusts exactly the certificates in its trust list
 *   (trust.ts). A member is its key, not a name: the host name check is replaced by the trust check.
 * - Server: the trust file is read again as each TCP connection arrives, before its handshake, and a
 *   changed list is installed with `setSecureContext`, so adding or removing a member takes effect on
 *   the next connection. After the handshake the peer's public key must match an entry of that list;
 *   otherwise the socket is destroyed and no request byte is read. Only then is the socket handed to
 *   the HTTP server. Every handshake has a timeout, every connection a request timeout, headers a cap.
 * - No session resumption: `SSL_OP_NO_TICKET` stops the stateless ticket that would let a peer resume
 *   without presenting its certificate again (a reusable secret). In TLS 1.3 OpenSSL then still sends
 *   a stateful ticket, a session id, but Node keeps no server-side session cache unless asked to
 *   (no `newSession` listener here), so no session can be resumed. One connection per call, no keep-alive.
 * - Client: it checks the server against its own trust list after the handshake and writes nothing
 *   before that check passes. Every call has one timeout and a cap on the response it reads.
 */
import { constants, type KeyObject } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server, Socket } from "node:net";
import { connect as tlsConnect, createServer as createTlsServer, type SecureContextOptions, type TLSSocket } from "node:tls";

import { certificateFor, fingerprint } from "./cert.js";
import { memberFor, trustSource, type TrustEntry, type TrustList } from "./trust.js";

/** One interval of the announcement (Decision 3): no handshake or call may take longer by default. */
export const FLEET_TIMEOUT_MS = 5000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

function contextOptions(key: KeyObject, trust: TrustList): SecureContextOptions {
  return {
    key: key.export({ type: "pkcs8", format: "pem" }),
    cert: certificateFor(key).pem,
    ca: trust.map((t) => t.pem), // always an array: never the system's root certificates
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
  };
}

const serverContext = (key: KeyObject, trust: TrustList): SecureContextOptions => ({ ...contextOptions(key, trust), secureOptions: constants.SSL_OP_NO_TICKET });

export interface FleetServerOptions {
  key: KeyObject;
  trustPath: string;
  /** An IP address (config.ts refuses a name). */
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** Called for each request of an authenticated member, never for anyone else. */
  onRequest: (member: TrustEntry, req: IncomingMessage, res: ServerResponse) => void;
  log: (line: string) => void;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxConnections?: number;
  /** The most connections one remote address may hold at once, before or after authentication (default 8). */
  maxPerAddress?: number;
  /** Refused and failed handshakes are logged at most once per address in this window (default 60 s). */
  logEveryMs?: number;
}

/**
 * A log that writes at most one line per key in each `everyMs` window; the rest are counted and the
 * count is reported with the next line written. Keys older than a window are dropped as it grows.
 */
function windowedLog(log: (line: string) => void, everyMs: number): (key: string, line: string) => void {
  const seen = new Map<string, { at: number; dropped: number }>();
  return (key, line) => {
    const now = Date.now();
    const last = seen.get(key);
    if (last && now - last.at < everyMs) {
      last.dropped += 1;
      return;
    }
    if (seen.size > 1000) for (const [k, v] of seen) if (now - v.at >= everyMs) seen.delete(k);
    seen.set(key, { at: now, dropped: 0 });
    log(last && last.dropped > 0 ? `${line} (and ${last.dropped} more from this address in the last window)` : line);
  };
}

export interface FleetServer {
  readonly address: { host: string; port: number };
  stop(): Promise<void>;
}

const shortPrint = (fp: string | undefined): string => fp?.slice(0, 16) ?? "none";

/** The trust-list entry of a peer whose handshake finished, or undefined after logging why it is refused. */
function admit(socket: TLSSocket, trust: TrustList, log: (line: string) => void): TrustEntry | undefined {
  const peer = socket.getPeerX509Certificate();
  const member = socket.authorized ? memberFor(peer, trust) : undefined;
  if (member) return member;
  const reason = socket.authorized ? "not in the trust list" : String(socket.authorizationError ?? "no certificate");
  log(`culture-agents core: fleet: refused a peer before reading any request (${reason}; key ${shortPrint(peer && fingerprint(peer))})`);
  return undefined;
}

function listenOn(server: Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.off("error", reject);
      const bound = server.address();
      resolve(typeof bound === "object" && bound ? bound.port : port);
    });
  });
}

/** Start listening. Rejects when the address cannot be bound. */
export async function startFleetServer(o: FleetServerOptions): Promise<FleetServer> {
  const source = trustSource(o.trustPath, (m) => o.log(`culture-agents core: fleet: ${m}`));
  let current = source().list;
  const members = new WeakMap<TLSSocket, TrustEntry>();
  const live = new Set<Socket>(); // every TCP connection, authenticated or not, so a stop ends them all
  const requestTimeoutMs = o.requestTimeoutMs ?? FLEET_TIMEOUT_MS;
  const http = createHttpServer({ maxHeaderSize: MAX_HEADER_BYTES, requestTimeout: requestTimeoutMs, headersTimeout: requestTimeoutMs }, (req, res) => {
    const member = members.get(req.socket as TLSSocket);
    res.setHeader("Connection", "close");
    if (member) o.onRequest(member, req, res);
    else res.destroy(); // unreachable: only checked sockets reach this server
  });
  http.maxRequestsPerSocket = 1;
  const maxPerAddress = o.maxPerAddress ?? 8;
  const perAddress = new Map<string, number>();
  const limited = windowedLog(o.log, o.logEveryMs ?? 60_000);
  const tls = createTlsServer({ ...serverContext(o.key, current), requestCert: true, rejectUnauthorized: false, handshakeTimeout: o.handshakeTimeoutMs ?? FLEET_TIMEOUT_MS });
  tls.maxConnections = o.maxConnections ?? 64;
  // Before the TLS layer sees the connection: the trust list this handshake is checked against.
  tls.prependListener("connection", (raw: Socket) => {
    const address = raw.remoteAddress ?? "";
    const held = perAddress.get(address) ?? 0;
    if (held >= maxPerAddress) {
      // Before any read: one address may not take the slots every member needs.
      limited(address, `culture-agents core: fleet: refused a connection from ${address}: it already holds ${held}, the most one address may`);
      raw.destroy();
      return;
    }
    perAddress.set(address, held + 1);
    live.add(raw);
    raw.once("close", () => {
      live.delete(raw);
      const left = (perAddress.get(address) ?? 1) - 1;
      if (left > 0) perAddress.set(address, left);
      else perAddress.delete(address);
    });
    const { list, changed } = source();
    current = list;
    if (changed) tls.setSecureContext(serverContext(o.key, list));
  });
  tls.on("secureConnection", (socket: TLSSocket) => {
    const member = admit(socket, current, (line) => limited(socket.remoteAddress ?? "", line));
    if (!member) {
      socket.destroy();
      return;
    }
    members.set(socket, member);
    socket.setTimeout(requestTimeoutMs, () => socket.destroy());
    http.emit("connection", socket);
  });
  // With a listener here Node leaves the socket open (a handshake timeout included): close it.
  tls.on("tlsClientError", (e: Error, socket: TLSSocket) => {
    limited(socket.remoteAddress ?? "", `culture-agents core: fleet: a handshake failed (${(e as NodeJS.ErrnoException).code ?? e.message})`);
    socket.destroy();
  });
  const port = await listenOn(tls, o.host, o.port);
  tls.on("error", (e: Error) => o.log(`culture-agents core: fleet: the listener reported an error: ${e.message}`));
  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped ??= new Promise<void>((resolve) => {
      tls.close(() => resolve());
      for (const s of live) s.destroy();
      http.close();
    });
    return stopped;
  };
  return { address: { host: o.host, port }, stop };
}

/**
 * Lift the idle limit of the socket a request came on, for a route whose reply takes longer than
 * `FLEET_TIMEOUT_MS` to start (a run's bundle). The socket is still closed after `ms` idle.
 */
export function allowReplyFor(req: IncomingMessage, ms: number): void {
  req.socket.setTimeout(ms);
}

// ---------------------------------------------------------------- client

export class FleetCallError extends Error {
  override readonly name = "FleetCallError";
  constructor(
    readonly code: "ETIMEDOUT" | "EUNTRUSTED" | "ETOOLARGE" | "ECLOSED",
    message: string,
  ) {
    super(message);
  }
}

export interface FleetCallOptions {
  key: KeyObject;
  trust: TrustList;
  host: string;
  port: number;
  method: "GET" | "POST";
  path: string;
  body?: string;
  /** When set, the server's key must be the one the trust list gives this node name. */
  expectNode?: string;
  /** Extra request headers (the remote calls send `Agents-Api-Version`). */
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface FleetResponse {
  status: number;
  body: Buffer;
  /** The trust-list entry of the server that answered. */
  member: TrustEntry;
}

/** OpenSSL's verification codes: the server presented a certificate the trust list does not hold. */
const isTrustFailure = (e: NodeJS.ErrnoException): boolean => /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(e.code ?? "");

type Finish = (error: Error | null, value?: FleetResponse) => void;

/** The server's entry in the trust list, or why it is not trusted. */
function checkServer(socket: TLSSocket, o: FleetCallOptions): TrustEntry | string {
  if (!socket.authorized) return `the server's certificate is not in the trust list (${String(socket.authorizationError)})`;
  const member = memberFor(socket.getPeerX509Certificate(), o.trust);
  if (!member) return "the server's key is not in the trust list";
  if (o.expectNode !== undefined && member.node !== o.expectNode) return `the server is ${member.node}, not ${o.expectNode}`;
  return member;
}

function readCapped(res: IncomingMessage, max: number, member: TrustEntry, finish: Finish): void {
  const declared = Number(res.headers["content-length"] ?? "0");
  if (declared > max) {
    finish(new FleetCallError("ETOOLARGE", `the response is larger than ${max} bytes`));
    return;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  res.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > max) finish(new FleetCallError("ETOOLARGE", `the response is larger than ${max} bytes`));
    else chunks.push(chunk);
  });
  res.on("end", () => finish(null, { status: res.statusCode ?? 0, body: Buffer.concat(chunks), member }));
  res.on("error", (e) => finish(e));
}

function sendRequest(socket: TLSSocket, member: TrustEntry, o: FleetCallOptions, finish: Finish): void {
  const headers: Record<string, string> = { ...o.headers, host: "culture-agents-fleet", connection: "close" };
  if (o.body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(o.body));
  }
  const req = httpRequest({ createConnection: () => socket, method: o.method, path: o.path, headers });
  req.on("response", (res) => readCapped(res, o.maxResponseBytes ?? MAX_RESPONSE_BYTES, member, finish));
  req.on("error", (e) => finish(e));
  req.end(o.body);
}

/** One call to a member over one fresh connection. Rejects with `FleetCallError` or the socket's error. */
export function fleetCall(o: FleetCallOptions): Promise<FleetResponse> {
  return new Promise((resolve, reject) => {
    const timeoutMs = o.timeoutMs ?? FLEET_TIMEOUT_MS;
    const socket = tlsConnect({ ...contextOptions(o.key, o.trust), host: o.host, port: o.port, rejectUnauthorized: true, checkServerIdentity: () => undefined });
    let settled = false;
    const finish: Finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const timer = setTimeout(() => finish(new FleetCallError("ETIMEDOUT", `no answer from the member within ${timeoutMs} ms`)), timeoutMs);
    socket.once("secureConnect", () => {
      const member = checkServer(socket, o);
      if (typeof member === "string") finish(new FleetCallError("EUNTRUSTED", member));
      else sendRequest(socket, member, o, finish);
    });
    socket.once("error", (e: NodeJS.ErrnoException) => finish(isTrustFailure(e) ? new FleetCallError("EUNTRUSTED", `the server's certificate is not in the trust list (${e.code ?? ""})`) : e));
    socket.once("close", () => finish(new FleetCallError("ECLOSED", "the member closed the connection")));
  });
}
