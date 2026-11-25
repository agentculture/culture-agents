import type { ServerResponse } from "node:http";

import { isTerminal, validate, type StateData } from "../contract/index.js";
import { sseFrame } from "./http.js";
import type { RouteContext } from "./routes.js";

/** Resolves when the response can take more data, or the connection closed. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

/**
 * Serve `runs.attach`: replay events after `after`, then follow live ones, in cursor order. The stream
 * closes right after the terminal `run.state` event, or when the service's iterable ends. A comment line
 * keeps an idle stream alive. Errors raised before this point were ordinary JSON errors.
 */
export async function streamAttach(ctx: RouteContext, res: ServerResponse, runId: string, after: number): Promise<void> {
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  res.once("close", stop);
  ctx.shutdown.addEventListener("abort", stop, { once: true });
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), ctx.keepaliveMs);
  try {
    for await (const event of ctx.service.streamEvents(runId, after, abort.signal)) {
      if (abort.signal.aborted) break;
      const checked = validate("event", event);
      if (!checked.ok) {
        process.stderr.write(`culture-agents core: dropping stream for ${runId}: event ${event.cursor} failed validation\n`);
        break;
      }
      // A client that does not read must not make the core buffer the log for it: wait for the socket.
      if (!res.write(sseFrame(event.cursor, event.kind, event))) await drained(res);
      if (event.kind === "run.state" && isTerminal((event.data as StateData).to)) break;
    }
  } catch (e) {
    process.stderr.write(`culture-agents core: stream for ${runId} ended with an error: ${e instanceof Error ? e.message : String(e)}\n`);
  } finally {
    clearInterval(keepalive);
    res.off("close", stop);
    ctx.shutdown.removeEventListener("abort", stop);
    abort.abort();
    if (!res.writableEnded) res.end();
  }
}
