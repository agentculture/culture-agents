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

function serve(socket: Socket, handler: ControlHandler): void {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_REQUEST) {
      socket.end(`${JSON.stringify(invalid("The control request is too large."))}\n`);
      return;
    }
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    socket.removeAllListeners("data");
    const parsed = parseRequest(buf.slice(0, nl));
    const reply = "op" in parsed ? Promise.resolve().then(() => handler(parsed)) : Promise.resolve(parsed);
    reply
      .catch((err: unknown) => ({ ok: false as const, error: { code: "internal" as const, message: String(err), retryable: false } }))
      .then((r) => socket.end(`${JSON.stringify(r)}\n`));
  });
}

/** Listen on the run's control socket (replacing a stale socket file). */
export async function listenControl(dir: string, handler: ControlHandler): Promise<Server> {
  rmSync(join(dir, RUN_FILES.socket), { force: true });
  const server = createServer((socket) => serve(socket, handler));
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

/** Stop listening and remove the socket file. */
export async function closeControl(dir: string, server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(join(dir, RUN_FILES.socket), { force: true });
}

/** The control socket could not be reached (no worker listening, or it did not answer). */
export class ControlUnavailableError extends Error {
  constructor(message: string) {
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
        const socket = createConnection(path);
        const fail = (message: string) => {
          socket.destroy();
          reject(new ControlUnavailableError(message));
        };
        socket.setTimeout(timeoutMs, () => fail("The worker did not answer on its control socket in time."));
        socket.setEncoding("utf8");
        socket.on("error", (err) => fail(`The worker's control socket is unreachable: ${err.message}`));
        socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", (chunk: string) => (buf += chunk));
        socket.on("end", () => {
          try {
            resolve(JSON.parse(buf) as ControlReply);
          } catch {
            fail("The worker sent an unreadable control reply.");
          }
        });
      }),
  );
}
