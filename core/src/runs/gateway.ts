/**
 * The model gateway's admission signal (lobes-cli 0.99.0). `GET /status` answers with an
 * `admission` object: `admit` (boolean), `at` (RFC 3339), `stale_after_s` (number) and an optional
 * `reason`. It is read with Node's fetch (injectable), under a short timeout, from the origin of
 * the gateway URL the OpenCode harness is configured with. Anything but a fresh, well-formed
 * sample reads unknown, never admit: a missing field, a stale or future-stamped sample, a timeout,
 * a refused connection, a bad status, or a redirect to anywhere but loopback, or a configured host that is not loopback (no request is sent). The body is read
 * with a 64 KiB cap, content-length included. NOT VERIFIED against
 * a live gateway from the build sandbox (no network); the live row is in part-one-acceptance.md.
 */
import type { Signal } from "../contract/index.js";

export const GATEWAY_TIMEOUT_MS = 1000;
const FUTURE_SKEW_MS = 5000;
const MAX_BODY = 65536;
const MAX_HOPS = 3;

export interface GatewaySource {
  /** Catalog ids of the harnesses that use the gateway. */
  harnesses: readonly string[];
  /** The gateway URL the harness is configured with; `/status` is asked at its origin. */
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const GATEWAY_NO_FIELD = "not consulted: the gateway's status has no admission field (lobes-cli issue 346 not released)";
export const GATEWAY_NOT_USED = "not consulted: this harness does not use the model gateway";

const unknown = (reason: string, observedAt: string | null = null): Signal => ({ state: "unknown", consulted: true, reason, observed_at: observedAt });
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** Interpret one `/status` body at `now`. */
export function gatewayFromPayload(text: string, now: Date): Signal {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return unknown("the gateway's status is not valid JSON");
  }
  const root = doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  // The admit field of lobes-cli issue 346 is the only source: a status without it is not consulted.
  if (root !== null && !("admission" in root)) return { state: "unknown", consulted: false, reason: GATEWAY_NO_FIELD, observed_at: null };
  const a = root?.["admission"];
  const o = a !== null && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : null;
  const at = o?.["at"];
  const window = o?.["stale_after_s"];
  if (o === null || typeof o["admit"] !== "boolean" || typeof at !== "string" || !RFC3339.test(at) || typeof window !== "number" || !Number.isFinite(window) || window <= 0) {
    return unknown("the gateway's status lacks an admission object with a boolean admit, an RFC 3339 at and a positive stale_after_s");
  }
  const observed = new Date(at);
  if (Number.isNaN(observed.getTime())) return unknown("the gateway's admission has an unusable at");
  const observedAt = observed.toISOString();
  const ageMs = now.getTime() - observed.getTime();
  if (ageMs > window * 1000) return unknown(`the gateway reading is stale: ${Math.round(ageMs / 1000)}s old, stale after ${window}s`, observedAt);
  if (ageMs < -FUTURE_SKEW_MS) return unknown("the gateway reading is stamped in the future", observedAt);
  if (o["admit"]) return { state: "admit", consulted: true, reason: null, observed_at: observedAt };
  const why = typeof o["reason"] === "string" && o["reason"] !== "" ? o["reason"].slice(0, 200) : "no reason given";
  return { state: "hold", consulted: true, reason: `the gateway says hold (${why})`, observed_at: observedAt };
}

const isLoopback = (u: URL): boolean => u.hostname === "localhost" || u.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(u.hostname);

/** Where the redirect `res` from `url` points; throws unless that is a loopback http or https URL. */
function redirectTarget(res: Response, url: URL): URL {
  const loc = res.headers.get("location");
  let next: URL | null = null;
  try { next = loc ? new URL(loc, url) : null; } catch { next = null; }
  if (next === null || !isLoopback(next) || (next.protocol !== "http:" && next.protocol !== "https:")) throw new Error("redirect to a non-loopback address");
  return next;
}

/** The body of `res` as text, read from the stream and abandoned as soon as it passes MAX_BODY bytes. */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("body too large");
  }
  if (res.body === null) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving the loop by the throw ends the iteration, which cancels the stream: no more is read.
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchStatus(source: GatewaySource, signal: AbortSignal): Promise<string> {
  const doFetch = source.fetch ?? fetch;
  let url = new URL("/status", source.url);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await doFetch(url, { redirect: "manual", signal, headers: { accept: "application/json" } });
    if (res.status >= 300 && res.status < 400) {
      url = redirectTarget(res, url);
      continue;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    return readCapped(res);
  }
  throw new Error("too many redirects");
}

/** The core reads the gateway's status on loopback only; any other host is not asked at all. */
function notOnThisHost(url: string): Signal | null {
  let host: URL | null = null;
  try { host = new URL(url); } catch { host = null; }
  if (host !== null && isLoopback(host)) return null;
  return unknown("the gateway is not on this host: its status is read on loopback only, so no request was sent");
}

const inflight = new WeakMap<GatewaySource, Promise<Signal>>();

/** Read the gateway signal. Never throws and never waits longer than the timeout. Concurrent reads of one source share a request. */
export function readGateway(source: GatewaySource, now: Date): Promise<Signal> {
  const off = notOnThisHost(source.url);
  if (off !== null) return Promise.resolve(off);
  const running = inflight.get(source);
  if (running) return running;
  const ms = source.timeoutMs ?? GATEWAY_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Signal>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(unknown(`the gateway did not answer within ${ms} ms`)); }, ms);
  });
  const read = fetchStatus(source, controller.signal).then(
    (text) => gatewayFromPayload(text, now),
    (err: unknown) => unknown(`the gateway could not be read: ${err instanceof Error && /redirect/.test(err.message) ? err.message : "unreachable, refused or an error status"}`),
  );
  const p = Promise.race([read, deadline]).finally(() => { clearTimeout(timer); inflight.delete(source); });
  inflight.set(source, p);
  return p;
}
