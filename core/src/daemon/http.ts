import type { IncomingMessage, ServerResponse } from "node:http";

import { httpStatusFor, validate, type ErrorBody, type SchemaName } from "../contract/index.js";
import { ControlError, invalid } from "./errors.js";

const MAX_BODY_BYTES = 1024 * 1024;

/** Read and parse a JSON request body; an empty, oversized or malformed body is `invalid`. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw invalid("Request body is larger than 1 MiB.");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw invalid("Request body is required and must be a JSON object.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid("Request body is not valid JSON.");
  }
}

/** Validate a body against its contract schema; the first violation becomes an `invalid` error. */
export function checkBody<N extends SchemaName>(name: N, value: unknown): void {
  const result = validate(name, value);
  if (result.ok) return;
  const first = result.issues[0];
  const where = first?.path ? first.path : "(root)";
  throw invalid(`Request body does not match the contract at ${where}: ${first?.message ?? "invalid"}.`, first?.path || undefined);
}

function write(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Send a success body after validating it against its response schema. A body that does not validate is
 * a core bug: it is reported as `internal` and never sent (README: the CLI must not pass on invalid payloads).
 */
export function sendJson(res: ServerResponse, status: number, schema: SchemaName, payload: unknown): void {
  const result = validate(schema, payload);
  if (!result.ok) {
    const first = result.issues[0];
    process.stderr.write(`culture-agents core: response for ${schema} failed validation at ${first?.path ?? ""}: ${first?.message ?? ""}\n`);
    throw new ControlError("internal", "The core produced a response that does not match the contract.");
  }
  write(res, status, payload);
}

/** Send a typed error. Anything that is not a `ControlError` becomes `internal` without leaking details. */
export function sendError(res: ServerResponse, error: unknown): void {
  let body: ErrorBody;
  if (error instanceof ControlError) body = error.body;
  else {
    process.stderr.write(`culture-agents core: unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    body = { code: "internal", message: "The core hit an unexpected failure.", retryable: false };
  }
  let payload: unknown = { error: body };
  if (!validate("error", payload).ok) {
    payload = { error: { code: "internal", message: "The core produced an invalid error body.", retryable: false } };
    body = (payload as { error: ErrorBody }).error;
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  write(res, httpStatusFor(body.code), payload);
}

/** One SSE message: id, event, single-line data, blank line (README: attach). */
export function sseFrame(cursor: number, kind: string, data: unknown): string {
  return `id: ${cursor}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}
