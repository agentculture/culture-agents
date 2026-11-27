/**
 * `fleet.runs.attach` on the calling core: the events of a run on another member, as an SSE stream
 * on the control socket, read from the member one page at a time (`GET /v1/fleet/runs/{id}/events`).
 * Each page is one call with its own timeout and a byte cap, so no read from the network is
 * unbounded and no call can hang; a stream to the operator stays open as long as the run is active.
 *
 * - The first page is read before the response starts, so a refusal (`not_found`, `denied`,
 *   `unavailable`, ...) is an ordinary JSON error.
 * - Events go out in cursor order, each once; a duplicate is skipped, and a gap or an event of
 *   another run ends the stream (the client attaches again from its last cursor and gets the rest).
 * - The stream closes after the terminal `run.state` event, or at once when the run is already
 *   terminal with nothing after `after`. When the member stops answering mid-stream, the stream
 *   ends; the CLI reconnects with its last cursor, and a reconnect that fails is `unavailable`.
 */
import type { ServerResponse } from "node:http";

import { isTerminal, validate, type EventPage, type RemoteRun, type RunEvent, type StateData } from "../contract/index.js";
import { sseFrame } from "../daemon/http.js";
import type { Remote } from "./remote.js";

/** Events asked for per page: an event's text is at most 100 000 characters, so a page stays under the cap. */
export const ATTACH_PAGE = 10;
/** The most one page's response may hold. */
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
/** How long to wait before asking again when the member had nothing new. */
export const ATTACH_POLL_MS = 250;

export interface RemoteAttach {
  remote: Remote;
  node: string;
  runId: string;
  after: number;
  res: ServerResponse;
  keepaliveMs: number;
  shutdown: AbortSignal;
  pollMs?: number;
}

const page = (a: RemoteAttach, after: number): Promise<EventPage> =>
  a.remote.request(a.node, {
    method: "GET",
    path: `/v1/fleet/runs/${encodeURIComponent(a.runId)}/events?after=${after}&limit=${ATTACH_PAGE}`,
    status: 200,
    schema: "event#event_page",
    maxBytes: MAX_PAGE_BYTES,
  }) as Promise<EventPage>;

const terminalEvent = (e: RunEvent): boolean => e.kind === "run.state" && isTerminal((e.data as StateData).to);

/** Sleep `ms`, or less when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Write the page's new events; returns the new cursor and whether the stream is over. */
function writePage(a: RemoteAttach, p: EventPage, cursor: number, log: (line: string) => void): { cursor: number; over: boolean } {
  let at = cursor;
  for (const event of p.events) {
    if (event.cursor <= at) continue; // already sent
    if (event.cursor !== at + 1 || event.run_id !== a.runId || !validate("event", event).ok) {
      log(`culture-agents core: ending the stream of remote run ${a.runId}: ${a.node} sent event ${event.cursor} after ${at}, or an event that is not this run's`);
      return { cursor: at, over: true };
    }
    a.res.write(sseFrame(event.cursor, event.kind, event));
    at = event.cursor;
    if (terminalEvent(event)) return { cursor: at, over: true };
  }
  return { cursor: at, over: false };
}

/** Whether the run is terminal with nothing after `after`: then the stream closes at once. */
async function finishedAt(a: RemoteAttach, first: EventPage): Promise<boolean> {
  if (first.events.length > 0 || first.last_cursor > a.after) return false;
  const run = (await a.remote.request(a.node, { method: "GET", path: `/v1/fleet/runs/${encodeURIComponent(a.runId)}`, status: 200, schema: "remote" })) as RemoteRun;
  return run.terminal;
}

export async function streamRemoteAttach(a: RemoteAttach, log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Promise<void> {
  let current = await page(a, a.after); // refusals happen here, before the stream starts
  const done = await finishedAt(a, current);
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  a.res.once("close", stop);
  a.shutdown.addEventListener("abort", stop, { once: true });
  a.res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
  a.res.flushHeaders();
  const keepalive = setInterval(() => a.res.write(": keepalive\n\n"), a.keepaliveMs);
  let cursor = a.after;
  try {
    let over = done;
    while (!over && !abort.signal.aborted) {
      ({ cursor, over } = writePage(a, current, cursor, log));
      if (over) break;
      if (!current.more) await pause(a.pollMs ?? ATTACH_POLL_MS, abort.signal);
      if (abort.signal.aborted) break;
      current = await page(a, cursor); // the early exits above depend on each page
    }
  } catch (e) {
    log(`culture-agents core: the stream of remote run ${a.runId} ended after cursor ${cursor}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearInterval(keepalive);
    a.res.off("close", stop);
    a.shutdown.removeEventListener("abort", stop);
    if (!a.res.writableEnded) a.res.end();
  }
}
