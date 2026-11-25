/** A single-consumer async queue that ends once; pushes after the end are dropped. */
export class EventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;
  private failure: unknown = undefined;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    if (this.items.length === 0) for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  get isEnded(): boolean {
    return this.ended;
  }

  private next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.ended) {
      if (this.failure !== undefined) {
        const failure = this.failure;
        this.failure = undefined;
        return Promise.reject(toError(failure));
      }
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

/** Resolve after `ms`, or at once when `signal` aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Wait for `work` with a time limit; resolves `undefined` on timeout, or as soon as `signal`
 * aborts (the work is left to finish).
 */
export async function within<T>(ms: number, work: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  const stop = new AbortController();
  const limit = sleep(ms, signal ? AbortSignal.any([signal, stop.signal]) : stop.signal).then(() => undefined);
  try {
    return await Promise.race([work, limit]);
  } finally {
    stop.abort(); // clears the timer
  }
}

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
