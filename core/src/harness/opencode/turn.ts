/**
 * One OpenCode v2 turn. Output comes from the event stream, which is volatile: it is
 * reconnected when it drops (and the gap is reported), but it is never trusted to say the turn
 * ended. The authority is the wait route (the session loop is idle) confirmed by the session
 * route (a new idle time and an `outcome`) and the active-session list.
 */
import { EventQueue, errorMessage, sleep, within } from "../common/queue.js";
import type { Sink, TurnEvent, TurnHandle, TurnOutcome } from "../common/types.js";
import type { OpenCodeClient } from "./client.js";
import { OpenCodeEventMapper } from "./map.js";

export interface TurnTiming {
  /** Pause between authority checks while the session is not done. Default 300 ms. */
  pollMs?: number;
  /** Grace after the authority says done, so trailing stream events land. Default 500 ms. */
  drainMs?: number;
  /** How long to wait for the event stream before prompting anyway. Default 5 s. */
  connectMs?: number;
  /** Consecutive failed authority checks before the turn fails. Default 30. */
  maxFailures?: number;
  /** Receives every raw server event (live-test recording). */
  tap?: (raw: unknown) => void;
}

type Client = Pick<OpenCodeClient, "prompt" | "interrupt" | "wait" | "getSession" | "activeSessions" | "events">;

const diag = (text: string): TurnEvent => ({ type: "output", data: { channel: "diagnostic", text } });

export async function startOpenCodeTurn(
  client: Client,
  sessionId: string,
  task: string,
  closed: AbortSignal,
  sink: Sink,
  timing: TurnTiming = {},
): Promise<TurnHandle> {
  const pollMs = timing.pollMs ?? 300;
  const turnAbort = new AbortController();
  const stop = AbortSignal.any([turnAbort.signal, closed]);
  const queue = new EventQueue<TurnEvent>();
  const mapper = new OpenCodeEventMapper(sessionId);
  let markConnected!: () => void;
  const connected = new Promise<void>((resolve) => (markConnected = resolve));

  const pump = async () => {
    let attempt = 0;
    while (!stop.aborted) {
      try {
        // The server sends `server.connected` first, so the first event marks the subscription live.
        for await (const event of client.events(stop)) {
          markConnected();
          timing.tap?.(event);
          for (const e of mapper.map(event)) queue.push(e);
        }
      } catch {
        // Connection refused or dropped; retried below while the turn lives.
      }
      if (stop.aborted) break;
      attempt += 1;
      queue.push(diag(`the OpenCode event stream dropped (reconnect ${attempt}); output in the gap is not recorded`));
      await sleep(Math.min(2000, 200 * attempt), stop);
    }
  };
  void pump();
  await within(timing.connectMs ?? 5000, connected);

  const before = await client.getSession(sessionId);
  const idleBefore = before.time.idle ?? 0;
  await client.prompt(sessionId, task);

  const authority = async (): Promise<SessionOutcome> => {
    let failures = 0;
    while (!closed.aborted) {
      try {
        await client.wait(sessionId, closed);
        const info = await client.getSession(sessionId, closed);
        const active = await client.activeSessions(closed);
        failures = 0;
        if (!active.has(sessionId) && info.outcome && (info.time.idle ?? 0) > idleBefore) return info.outcome;
      } catch (err) {
        if (closed.aborted) break;
        failures += 1;
        if (failures >= (timing.maxFailures ?? 30)) throw new Error(`the OpenCode server stopped answering: ${errorMessage(err)}`);
      }
      await sleep(pollMs, closed);
    }
    return "closed";
  };

  const outcome = (async (): Promise<TurnOutcome> => {
    let result: TurnOutcome;
    try {
      const ended = await authority();
      if (ended !== "closed") await sleep(timing.drainMs ?? 500);
      result = toOutcome(ended, mapper);
    } catch (err) {
      result = { kind: "failed", error: { code: "unavailable", message: errorMessage(err).slice(0, 2000), retryable: true } };
    }
    turnAbort.abort();
    queue.end();
    return result;
  })();

  return {
    events: queue,
    outcome,
    steer: (text) => client.prompt(sessionId, text, "steer"),
    interrupt: async () => {
      const interrupted = await client.interrupt(sessionId);
      if (!interrupted) sink(diag("interrupt: the OpenCode session had no active execution"));
    },
  };
}

type SessionOutcome = "succeeded" | "failed" | "interrupted" | "closed";

function toOutcome(ended: SessionOutcome, mapper: OpenCodeEventMapper): TurnOutcome {
  switch (ended) {
    case "succeeded": {
      const summary = mapper.summary;
      return summary === undefined ? { kind: "completed" } : { kind: "completed", summary };
    }
    case "failed":
      return {
        kind: "failed",
        error: { code: "internal", message: `The OpenCode turn failed: ${mapper.executionError ?? "no error detail was streamed"}`, retryable: false },
      };
    case "interrupted":
    case "closed":
      return { kind: "interrupted" };
  }
}
