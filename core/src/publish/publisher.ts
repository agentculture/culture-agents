/**
 * The follower that publishes run events to the broker.
 *
 * It belongs to the core, never to a worker: workers append to their logs and know nothing of the
 * broker. The follower reads each run's log, publishes each event it has not published yet, in
 * cursor order, waits for the broker's acknowledgement, and only then records the new position on
 * disk. So:
 *
 * - an event is published after its append, never before, and the log stays the source of truth;
 * - a broker that is down or slow costs nothing but lateness: no request to the core and no worker
 *   waits on this loop, and the events stay in their logs until the broker takes them;
 * - after an outage or a core restart the follower goes on from the recorded position, so missed
 *   events are published with the ids they always had and none is skipped;
 * - a core that dies between the acknowledgement and the position write publishes that one event
 *   again, as the same bytes with the same id (delivery is at-least-once; consumers dedupe on id).
 *
 * A run whose log cannot be read past some point is held there with one warning. Nothing after
 * that point is published under a guessed cursor.
 */
import { setTimeout as delay } from "node:timers/promises";

import { isTerminal, type RunState } from "../contract/index.js";
import { runDir } from "../store/files.js";
import { listRunIds } from "../store/run-store.js";
import { EnvelopeError, buildMessage } from "./envelope.js";
import { pendingFacts, readPosition, writePosition, type PublishPosition } from "./log-tail.js";

/** The connection to the broker, as the follower needs it. */
export interface BrokerTransport {
  /**
   * Resolves once the broker acknowledged the message. Rejects when it did not: at once without a
   * connection, or after the transport's own time limit. It never waits without bound.
   */
  publish(topic: string, payload: string): Promise<void>;
  close(): Promise<void>;
}

export interface PublisherOptions {
  stateDir: string;
  /** The envelope `source` of this core (`sourceFor(node)`). */
  source: string;
  transport: BrokerTransport;
  /** Where one-line diagnostics go (the core's stderr). */
  warn: (line: string) => void;
  /** How long the loop sleeps when no run had anything new. Default 250 ms. */
  pollMs?: number;
  /** How long the loop sleeps after the broker refused an event. Default 1000 ms. */
  retryMs?: number;
  /** Most events published for one run before the next run gets its turn. Default 200. */
  batch?: number;
  /** How long `stop` waits for a publish in flight. Default 1000 ms. */
  stopTimeoutMs?: number;
}

export interface Publisher {
  /** Follow the logs until `stop`. */
  start(): void;
  /** One round over every run; resolves to the number of events published. */
  pass(): Promise<number>;
  /** Stop following and close the transport. Events not yet published stay in their logs. */
  stop(): Promise<void>;
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";

export function createPublisher(options: PublisherOptions): Publisher {
  const { stateDir, source, transport, warn } = options;
  const pollMs = options.pollMs ?? 250;
  const retryMs = options.retryMs ?? 1000;
  const batch = options.batch ?? 200;
  /** Position of every run this core is still following (read from disk the first time). */
  const positions = new Map<string, PublishPosition>();
  /** Runs with nothing left to publish, now or ever: terminal and fully published. */
  const finished = new Set<string>();
  /** Runs held at a point in their log, and runs whose position could not be written: warned once each. */
  const held = new Set<string>();
  const unwritable = new Set<string>();
  /** Whether the broker took the last event offered; null before the first attempt. */
  let up: boolean | null = null;
  let stopped = false;
  let loop: Promise<void> | null = null;
  const abort = new AbortController();

  const hold = (runId: string, err: unknown): void => {
    held.add(runId);
    positions.delete(runId);
    warn(`culture-agents core: run ${runId} is not published past this point: ${reasonOf(err)}. Its log is unchanged.`);
  };

  /** Publish what `runId` has pending. `refused` is true when the broker did not take an event. */
  async function publishRun(runId: string): Promise<{ count: number; refused: boolean }> {
    const dir = runDir(stateDir, runId);
    let position = positions.get(runId) ?? readPosition(dir);
    if (position.state !== null && isTerminal(position.state as RunState)) {
      finished.add(runId);
      positions.delete(runId);
      return { count: 0, refused: false };
    }
    positions.set(runId, position);
    let pending;
    try {
      pending = pendingFacts(dir, runId, position, batch);
    } catch (err) {
      hold(runId, err);
      return { count: 0, refused: false };
    }
    let count = 0;
    for (const item of pending) {
      let message;
      try {
        message = buildMessage(item.fact, source);
      } catch (err) {
        if (!(err instanceof EnvelopeError)) throw err;
        hold(runId, err);
        return { count, refused: false };
      }
      try {
        await transport.publish(message.topic, message.payload);
      } catch (err) {
        if (up !== false && !stopped) warn(`culture-agents core: the broker is not taking run events (${reasonOf(err)}); they stay in the run logs and are published when it is back.`);
        up = false;
        return { count, refused: true };
      }
      if (up === false) warn("culture-agents core: the broker takes run events again; publishing what was missed.");
      up = true;
      position = item.after;
      positions.set(runId, position); // kept in memory first: a failed write below must not make this core publish the event again
      try {
        writePosition(dir, position);
        unwritable.delete(runId);
      } catch (err) {
        if (!unwritable.has(runId)) warn(`culture-agents core: cannot record how far run ${runId} is published (${reasonOf(err)}); after a restart some of its events are published again with the same ids.`);
        unwritable.add(runId);
      }
      count += 1;
      if (stopped) break;
    }
    return { count, refused: false };
  }

  async function pass(): Promise<number> {
    let total = 0;
    for (const runId of listRunIds(stateDir)) {
      if (stopped) break;
      if (finished.has(runId) || held.has(runId)) continue;
      let result;
      try {
        result = await publishRun(runId);
      } catch (err) {
        if (!held.has(runId)) hold(runId, err);
        continue;
      }
      total += result.count;
      if (result.refused) break; // try again later, from the same event
    }
    return total;
  }

  async function follow(): Promise<void> {
    while (!stopped) {
      let count = 0;
      try {
        count = await pass();
      } catch (err) {
        warn(`culture-agents core: publishing run events failed for this round: ${reasonOf(err)}`);
      }
      if (stopped) return;
      // More may be waiting after a full batch: go on at once, but let other work in between.
      const wait = up === false ? retryMs : count > 0 ? 0 : pollMs;
      await delay(wait, undefined, { signal: abort.signal }).catch(() => undefined);
    }
  }

  return {
    start(): void {
      loop ??= follow();
    },
    pass,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      abort.abort();
      if (loop) {
        // A publish the broker never acknowledges must not keep the core from stopping.
        const limit = new AbortController();
        await Promise.race([loop, delay(options.stopTimeoutMs ?? 1000, undefined, { signal: limit.signal }).catch(() => undefined)]);
        limit.abort();
      }
      await transport.close().catch(() => undefined);
    },
  };
}
