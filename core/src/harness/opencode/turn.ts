/**
 * One OpenCode v2 turn. Output comes from the event stream, which is volatile: it is
 * reconnected when it drops (and the gap is reported), but it is never trusted to say the turn
 * ended. The authority is the wait route (the session loop is idle) confirmed by the session
 * route (a new idle time and an `outcome`) and the active-session list.
 */
import { SandboxTimeoutError, withTimeout } from "../../sandbox/timeout.js";
import { EventQueue, errorMessage, sleep, within } from "../common/queue.js";
import type { Sink, TurnEvent, TurnHandle, TurnOutcome } from "../common/types.js";
import { again, finish, stepUntil, type Step } from "../../util/sequence.js";
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
  /** Longest a session read, a prompt or a steer may take. Default 30 s. */
  callMs?: number;
  /** Longest one long-poll for the session to go idle may stay open before the session is checked. Default 60 s. */
  waitMs?: number;
  /** Receives every raw server event (live-test recording). */
  tap?: (raw: unknown) => void;
}

/** Longest one request to the OpenCode server may take when it should answer at once (not the long-poll wait). */
export const OPENCODE_CALL_TIMEOUT_MS = 30_000;

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

  let droppedBlocks = 0;
  const dropped = (): void => {
    droppedBlocks += 1;
    // Say so once, then at each tenfold step: a harness output event was lost, the run goes on.
    if (/^10*$/.test(String(droppedBlocks))) queue.push(diag(`${droppedBlocks} OpenCode event(s) could not be parsed or were over the size limit and were not recorded`));
  };

  const streamOnce = async (): Promise<void> => {
    try {
      // The server sends `server.connected` first, so the first event marks the subscription live.
      for await (const event of client.events(stop, dropped)) {
        markConnected();
        timing.tap?.(event);
        for (const e of mapper.map(event)) queue.push(e);
      }
    } catch {
      // Connection refused or dropped; retried by the pump while the turn lives.
    }
  };
  let attempt = 0;
  // One connection after another, with a growing pause, until the turn or the backend stops.
  const pump = (): Promise<void> =>
    stepUntil(
      async (): Promise<Step<void>> => {
        await streamOnce();
        if (stop.aborted) return finish(undefined);
        attempt += 1;
        queue.push(diag(`the OpenCode event stream dropped (reconnect ${attempt}); output in the gap is not recorded`));
        return again(Math.min(2000, 200 * attempt));
      },
      { signal: stop, onAbort: () => undefined },
    );
  void pump();
  await within(timing.connectMs ?? 5000, connected);

  // These answer at once on a healthy server. Each is bounded, and released when the backend closes.
  const callMs = timing.callMs ?? OPENCODE_CALL_TIMEOUT_MS;
  let idleBefore: number;
  try {
    const before = await withTimeout("reading the OpenCode session", callMs, (bound) => client.getSession(sessionId, bound), stop);
    idleBefore = before.time.idle ?? 0;
    await withTimeout("sending the task to OpenCode", callMs, (bound) => client.prompt(sessionId, task, undefined, bound), stop);
  } catch (err) {
    turnAbort.abort(); // no turn: stop the event stream opened above
    queue.end();
    throw err;
  }

  const longPoll = async (): Promise<void> => {
    try {
      await withTimeout("waiting for the OpenCode session", timing.waitMs ?? 60_000, (bound) => client.wait(sessionId, bound), closed);
    } catch (err) {
      if (!(err instanceof SandboxTimeoutError)) throw err;
    }
  };

  let failures = 0;
  /** One authority check: the session's outcome, or another check after the poll pause. */
  const check = async (): Promise<Step<SessionOutcome>> => {
    try {
      // The long-poll is legitimately open for a whole turn, so its bound only forces a look at the
      // session. The two reads answer at once on a healthy server: a hung one counts as a failure.
      if (failures === 0) await longPoll();
      const info = await withTimeout("reading the OpenCode session", callMs, (bound) => client.getSession(sessionId, bound), closed);
      const active = await withTimeout("listing the active OpenCode sessions", callMs, (bound) => client.activeSessions(bound), closed);
      failures = 0;
      if (!active.has(sessionId) && info.outcome && (info.time.idle ?? 0) > idleBefore) return finish(info.outcome);
    } catch (err) {
      if (closed.aborted) return finish("closed");
      failures += 1;
      if (failures >= (timing.maxFailures ?? 30)) throw new Error(`the OpenCode server stopped answering: ${errorMessage(err)}`);
    }
    return again(pollMs);
  };
  const authority = (): Promise<SessionOutcome> => stepUntil<SessionOutcome>(check, { signal: closed, onAbort: () => "closed" });

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
    steer: (text) => withTimeout("delivering the steer to OpenCode", callMs, (bound) => client.prompt(sessionId, text, "steer", bound), stop),
    interrupt: async () => {
      const interrupted = await withTimeout("interrupting the OpenCode session", callMs, (bound) => client.interrupt(sessionId, bound), closed);
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
