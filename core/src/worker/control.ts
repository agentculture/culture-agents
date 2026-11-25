/**
 * The worker's control channel: a Unix socket `control.sock` in the run directory (0600, inside
 * a 0700 directory). One newline-delimited JSON request per connection, one JSON reply.
 * The daemon uses it while both are alive; the worker never depends on it to keep running.
 *
 * Unix socket paths are limited to ~107 bytes. When the run directory's path is longer, both
 * sides address the socket through `/proc/self/fd/<dir fd>/control.sock` (Linux).
 */
import { chmodSync, closeSync, openSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { validate, type ActionRecord, type ErrorBody, type RunState } from "../contract/index.js";
import { FILE_MODE, RUN_FILES } from "../store/files.js";

export type ControlRequest =
  | { op: "ping" }
  | { op: "steer"; action: ActionRecord; message: string }
  | { op: "cancel"; action: ActionRecord; reason?: string }
  /** Record a refusal decided by the core as `run.refused` (the worker is the log's only writer). */
  | { op: "refuse"; action: ActionRecord };

export type ControlReply =
  | { ok: true; pid: number; state: RunState | null; cursor: number }
  | { ok: false; error: ErrorBody };

export type ControlHandler = (request: ControlRequest) => ControlReply | Promise<ControlReply>;

const MAX_PATH = 100;
const MAX_REQUEST = 256 * 1024;

/** Run `fn` with a socket path short enough to bind/connect; the directory fd stays open until `done`. */
async function withSocketPath<T>(dir: string, fn: (path: string) => Promise<T>): Promise<T> {
  const full = join(dir, RUN_FILES.socket);
  if (Buffer.byteLength(full) <= MAX_PATH) return fn(full);
  const fd = openSync(dir, "r");
  try {
    return await fn(`/proc/self/fd/${fd}/${RUN_FILES.socket}`);
  } finally {
    closeSync(fd);
  }
}

const invalid = (message: string): ControlReply => ({ ok: false, error: { code: "invalid", message, retryable: false } });

/** Parse and validate one request line. Payload text is data, never interpreted. */
export function parseRequest(line: string): ControlRequest | ControlReply {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return invalid("The control request is not JSON.");
  }
  const req = value as Record<string, unknown>;
  if (req === null || typeof req !== "object") return invalid("The control request is not an object.");
  if (req["op"] === "ping") return { op: "ping" };
  if (req["op"] !== "steer" && req["op"] !== "cancel" && req["op"] !== "refuse") return invalid("Unknown control op.");
  const action = validate("control-action#action_record", req["action"]);
  if (!action.ok) return invalid(`The action record is invalid at ${action.issues[0]?.path ?? ""}.`);
  if (req["op"] === "steer") {
    const message = validate("common#text", req["message"]);
    if (!message.ok) return invalid("The steer message is invalid.");
    return { op: "steer", action: action.value, message: message.value };
  }
  if (req["op"] === "cancel") {
    const reason = req["reason"];
    if (reason !== undefined && typeof reason !== "string") return invalid("The cancel reason is not a string.");
    return reason === undefined ? { op: "cancel", action: action.value } : { op: "cancel", action: action.value, reason };
  }
  return { op: "refuse", action: action.value };
}

/** How long a connection may take to send its request before the worker drops it. */
const REQUEST_IDLE_MS = 5000;
/** Default time `closeControl` gives connections with no request in flight. */
const CLOSE_GRACE_MS = 1000;
/** Hard cap on `closeControl`: a handler that never answers cannot keep the worker alive. */
const CLOSE_CAP_MS = 30_000;

/** Open connections of each control server, and which of them have a request in flight. */
interface Tracked {
  open: Set<Socket>;
  busy: Set<Socket>;
}
const tracked = new WeakMap<Server, Tracked>();

function serve(socket: Socket, handler: ControlHandler, track: Tracked): void {
  let buf = "";
  track.open.add(socket);
  socket.once("close", () => {
    track.open.delete(socket);
    track.busy.delete(socket);
  });
  socket.setEncoding("utf8");
  socket.setTimeout(REQUEST_IDLE_MS, () => {
    if (!track.busy.has(socket)) socket.destroy();
  });
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_REQUEST) {
      socket.removeAllListeners("data");
      socket.end(`${JSON.stringify(invalid("The control request is too large."))}\n`);
      return;
    }
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    socket.removeAllListeners("data");
    // From here the worker owes this connection a reply; closeControl waits for it.
    track.busy.add(socket);
    socket.setTimeout(0);
    const parsed = parseRequest(buf.slice(0, nl));
    const reply = "op" in parsed ? Promise.resolve().then(() => handler(parsed)) : Promise.resolve(parsed);
    reply
      .catch((err: unknown) => ({ ok: false as const, error: { code: "internal" as const, message: String(err), retryable: false } }))
      .then((r) => socket.end(`${JSON.stringify(r)}\n`))
      .catch((err: unknown) => {
        // The reply could not be written. The caller gets no reply instead of a broken one, and the worker's log says why.
        process.stderr.write(`worker ${process.pid}: could not send a control reply: ${err instanceof Error ? err.message : String(err)}\n`);
        socket.destroy();
      });
  });
}

/** Listen on the run's control socket (replacing a stale socket file). */
export async function listenControl(dir: string, handler: ControlHandler): Promise<Server> {
  rmSync(join(dir, RUN_FILES.socket), { force: true });
  const track: Tracked = { open: new Set(), busy: new Set() };
  const server = createServer((socket) => serve(socket, handler, track));
  tracked.set(server, track);
  await withSocketPath(
    dir,
    (path) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      }),
  );
  chmodSync(join(dir, RUN_FILES.socket), FILE_MODE);
  return server;
}

/**
 * Stop accepting connections, then wait until every accepted request has had its reply written
 * and its connection closed, and remove the socket file. A connection that has not sent a complete
 * request within `graceMs` is dropped unanswered: its request never reached the worker, which the
 * client reports as `no-reply` (see `ControlUnavailableError`).
 */
export async function closeControl(dir: string, server: Server, options: { graceMs?: number } = {}): Promise<void> {
  const track = tracked.get(server);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const timers: NodeJS.Timeout[] = [];
  if (track) {
    timers.push(
      setTimeout(() => {
        for (const s of track.open) if (!track.busy.has(s)) s.destroy();
      }, options.graceMs ?? CLOSE_GRACE_MS),
      setTimeout(() => {
        for (const s of track.open) s.destroy();
      }, CLOSE_CAP_MS),
    );
  }
  try {
    await closed;
  } finally {
    for (const t of timers) clearTimeout(t);
  }
  rmSync(join(dir, RUN_FILES.socket), { force: true });
}

/**
 * Why a control request got no reply:
 * - `unreachable`: no worker accepted the connection (no socket, or nothing listening). The
 *   request was not delivered.
 * - `no-reply`: the connection was dropped before any reply byte. A live worker answers every
 *   request it has read before it closes the channel, so this means the request was not read,
 *   unless the worker died while handling it.
 * - `timeout`: the worker did not answer in time; the request may still take effect.
 * - `bad-reply`: the reply could not be read.
 * Callers settle the outcome from the run's log (`settleFromLog`), never by retrying.
 */
export type ControlFailure = "unreachable" | "no-reply" | "timeout" | "bad-reply";

/** The control socket could not be reached (no worker listening, or it did not answer). */
export class ControlUnavailableError extends Error {
  constructor(
    message: string,
    readonly failure: ControlFailure = "unreachable",
  ) {
    super(message);
    this.name = "ControlUnavailableError";
  }
}

/** Send one request to a run's worker and wait for its reply. */
export async function controlRequest(dir: string, request: ControlRequest, timeoutMs = 2000): Promise<ControlReply> {
  return withSocketPath(
    dir,
    (path) =>
      new Promise<ControlReply>((resolve, reject) => {
        let buf = "";
        let connected = false;
        let settled = false;
        const socket = createConnection(path);
        const fail = (message: string, failure: ControlFailure) => {
          socket.destroy();
          if (settled) return;
          settled = true;
          reject(new ControlUnavailableError(message, failure));
        };
        socket.setTimeout(timeoutMs, () => fail("The worker did not answer on its control socket in time.", "timeout"));
        socket.setEncoding("utf8");
        socket.on("error", (err) => {
          if (connected && buf === "") fail(`The worker closed its control socket without answering: ${err.message}`, "no-reply");
          else fail(`The worker's control socket is unreachable: ${err.message}`, connected ? "bad-reply" : "unreachable");
        });
        socket.on("connect", () => {
          connected = true;
          socket.write(`${JSON.stringify(request)}\n`);
        });
        socket.on("data", (chunk: string) => (buf += chunk));
        socket.on("end", () => {
          if (buf === "") return fail("The worker closed its control socket without answering.", "no-reply");
          try {
            const reply = JSON.parse(buf) as ControlReply;
            settled = true;
            socket.destroy();
            resolve(reply);
          } catch {
            fail("The worker sent an unreadable control reply.", "bad-reply");
          }
        });
      }),
  );
}
