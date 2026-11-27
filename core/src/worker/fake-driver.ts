/**
 * A scripted driver for tests: it plays a list of steps with delays, and can fail, ignore
 * cancel, or hang. It runs inside a real worker process (the worker loads it by module path),
 * so tests exercise the real process, files and control socket.
 */
import { setTimeout as delay } from "node:timers/promises";

import type { ErrorBody, OutputData } from "../contract/index.js";
import type { AnswerReply, AskedQuestion, Driver, DriverContext, DriverEvent } from "./driver.js";

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
  | { op: "hang" }
  /** Ask the operator and wait for the answer (or a cancel); the answer is echoed as `run.output`. */
  | { op: "ask"; question: AskedQuestion; /** false: raise it and go on, without waiting. */ wait?: boolean }
  /** The harness drops the question with this ref without an answer (a `withdraw` event). */
  | { op: "withdraw"; ref: string };

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
  /** When true the driver has no ask path (no `answer` method), like a harness that cannot ask. */
  noAnswer?: boolean;
  /** The first this many answer deliveries never settle (a hung bridge). */
  answerHangs?: number;
  /** When set, delivering an answer fails with this message. */
  answerError?: string;
  /** A sandbox the driver keeps once it is cancelled, while its stop is still in progress (retention cleanup). */
  retainOnCancel?: { sandbox: string; until: string };
}

class Queue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((value: T) => void)[] = [];
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
  private hung = 0;
  private stopped = false;
  private cancelled = false;
  private waiting: { ref: string; resolve: () => void } | null = null;
  answer?: (ref: string, reply: AnswerReply) => Promise<void>;

  constructor(private readonly options: FakeDriverOptions) {
    if (!options.noAnswer) this.answer = (ref, reply) => this.takeAnswer(ref, reply);
  }

  /** Callers get a promise either way: a refused answer is a rejection, never a synchronous throw. */
  private takeAnswer(ref: string, reply: AnswerReply): Promise<void> {
    if (this.hung < (this.options.answerHangs ?? 0)) {
      this.hung += 1;
      return new Promise<void>(() => undefined);
    }
    if (this.options.answerError !== undefined) return Promise.reject(new Error(this.options.answerError));
    if (this.waiting?.ref !== ref) return Promise.reject(new Error(`no pending request ${ref}`));
    const { resolve } = this.waiting;
    this.waiting = null;
    this.emit({ type: "output", data: { channel: "diagnostic", text: `answer: ${JSON.stringify(reply)}` } });
    resolve();
    return Promise.resolve();
  }

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
          case "ask":
            if (step.wait === false) {
              this.emit({ type: "question", question: step.question });
              break;
            }
            await new Promise<void>((resolve, reject) => {
              this.waiting = { ref: step.question.ref, resolve };
              signal.addEventListener("abort", () => reject(new Error("aborted")));
              this.emit({ type: "question", question: step.question });
            });
            break;
          case "withdraw":
            this.waiting = null;
            this.emit({ type: "withdraw", ref: step.ref });
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

  retained(): { sandbox: string; until: string } | null {
    return this.cancelled ? (this.options.retainOnCancel ?? null) : null;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
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
