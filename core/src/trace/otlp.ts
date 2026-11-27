/**
 * OTLP over HTTP (JSON) for spans, sent with Node's `fetch`. Trace and span ids are derived from the
 * run id and span key, so sending the same span again carries the same ids.
 */
import { createHash } from "node:crypto";

import type { Attr, Span } from "./spans.js";

const hex = (text: string, bytes: number): string => createHash("sha256").update(text).digest("hex").slice(0, bytes * 2);
export const traceIdOf = (runId: string): string => hex(`trace:${runId}`, 16);
export const spanIdOf = (runId: string, key: string): string => hex(`span:${runId}:${key}`, 8);

const nanos = (iso: string): string => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

function attribute(key: string, value: Attr): { key: string; value: Record<string, unknown> } {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
}

export interface ExportSpan {
  traceId: string;
  runId: string;
  span: Span;
}

export function payloadFor(spans: readonly ExportSpan[], node: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [attribute("service.name", "culture-agents-core"), attribute("host.name", node)] },
        scopeSpans: [
          {
            scope: { name: "culture-agents.trace" },
            spans: spans.map(({ traceId, runId, span }) => ({
              traceId,
              spanId: spanIdOf(runId, span.key),
              ...(span.parent === null ? {} : { parentSpanId: spanIdOf(runId, span.parent) }),
              name: span.name,
              kind: 1,
              startTimeUnixNano: nanos(span.start),
              endTimeUnixNano: nanos(span.end),
              attributes: Object.entries(span.attrs).map(([k, v]) => attribute(k, v)),
              status: { code: span.attrs["culture.state"] === "failed" ? 2 : 1 },
            })),
          },
        ],
      },
    ],
  });
}

/** Resolves once the receiver took the spans; rejects at once or after `timeoutMs`. Never waits without bound. */
export async function postSpans(url: string, authorization: string | null, body: string, timeoutMs = 5000): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-langfuse-ingestion-version": "4" };
  if (authorization !== null) headers["authorization"] = authorization;
  const response = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`the trace receiver answered ${response.status}`);
}
