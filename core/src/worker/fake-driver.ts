/**
 * A scripted driver for tests: it plays a list of steps with delays, and can fail, ignore
 * cancel, or hang. It runs inside a real worker process (the worker loads it by module path),
 * so tests exercise the real process, files and control socket.
 */
import { setTimeout as delay } from "node:timers/promises";

import type { ErrorBody, OutputData } from "../contract/index.js";
import type { Driver, DriverContext, DriverEvent } from "./driver.js";

export type FakeStep =
  | { op: "sleep"; ms: number }
  | { op: "started" }
  | { op: "output"; data: OutputData }
  | { op: "error"; error: ErrorBody }
  | { op: "completed"; summary?: string; collected?: { branch: string; commits: string[] } }
  | { op: "failed"; error: ErrorBody; retained?: { sandbox: string; until: string } }
  /** Throw from the event stream (an unexpected driver crash). */
  | { op: "throw"; message: string }
  /** Wait until cancelled, or forever when cancel is ignored. */
  | { op: "hang" };

export interface FakeDriverOptions {
  steps: FakeStep[];
  /** When true, `cancel` is acknowledged but the harness never stops. */
  ignoreCancel?: boolean;
  /** Delay between `cancel` and `stopped`. Default 0. */
  stopDelayMs?: number;
  /** Echo each steer as `run.output` (channel `diagnostic`). Default true. */
  echoSteer?: boolean;
  /** How long `steer` takes to deliver. Default 0. */
  steerDelayMs?: number;
  /** When set, `steer` fails with this message (the harness did not take the steer). */
  steerError?: string;
}

class Queue<T> {
  private items: T[] = [];
  private waiters: ((value: T) => void)[] = [];
  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }
  next(): Promise<T> {
    const item = this.items.shift();
    return item !== undefined ? Promise.resolve(item) : new Promise((resolve) => this.waiters.push(resolve));
  }
}

type Signal = { kind: "event"; event: DriverEvent } | { kind: "end" } | { kind: "throw"; message: string };

export class FakeDriver implements Driver {
  private readonly queue = new Queue<Signal>();
  private readonly abort = new AbortController();
  private stopped = false;

  constructor(private readonly options: FakeDriverOptions) {}

  start(): AsyncIterable<DriverEvent> {
    void this.play();
    const queue = this.queue;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const signal = await queue.next();
          if (signal.kind === "end") return;
          if (signal.kind === "throw") throw new Error(signal.message);
          yield signal.event;
        }
      },
    };
  }

  private emit(event: DriverEvent): void {
    if (!this.stopped) this.queue.push({ kind: "event", event });
  }

  private async play(): Promise<void> {
    const { signal } = this.abort;
    try {
      for (const step of this.options.steps) {
        if (this.stopped) return;
        switch (step.op) {
          case "sleep":
            await delay(step.ms, undefined, { signal });
            break;
          case "hang":
            await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
            break;
          case "throw":
            this.queue.push({ kind: "throw", message: step.message });
            return;
          case "started":
            this.emit({ type: "started" });
            break;
          case "output":
            this.emit({ type: "output", data: step.data });
            break;
          case "error":
            this.emit({ type: "error", error: step.error });
            break;
          case "completed":
            this.emit({ type: "completed", ...(step.summary === undefined ? {} : { summary: step.summary }), ...(step.collected ? { collected: step.collected } : {}) });
            this.finish();
            return;
          case "failed":
            this.emit({ type: "failed", error: step.error, ...(step.retained ? { retained: step.retained } : {}) });
            this.finish();
            return;
        }
      }
      this.finish();
    } catch {
      // Aborted by cancel or dispose: the stop path emits what follows.
    }
  }

  private finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.push({ kind: "end" });
  }

  async steer(message: string): Promise<void> {
    if (this.options.steerDelayMs) await delay(this.options.steerDelayMs);
    if (this.options.steerError !== undefined) throw new Error(this.options.steerError);
    if (this.options.echoSteer ?? true) this.emit({ type: "output", data: { channel: "diagnostic", text: `steer: ${message}` } });
  }

  async cancel(): Promise<void> {
    if (this.options.ignoreCancel) return;
    const stopDelay = this.options.stopDelayMs ?? 0;
    this.abort.abort();
    setTimeout(() => {
      this.emit({ type: "stopped" });
      this.finish();
    }, stopDelay);
  }

  async dispose(): Promise<void> {
    this.abort.abort();
    this.finish();
  }
}

export function createDriver(context: DriverContext): Driver {
  return new FakeDriver(context.options as FakeDriverOptions);
}
