/**
 * Sequential work made explicit: polls, retries and ordered writes that must run one step after
 * another, never side by side.
 *
 * Everything here is driven by `stepUntil`. It holds one promise for the whole sequence and starts
 * each step from a timer or from the settling of the step before, so a poll that runs for hours
 * keeps no chain of pending promises and no growing stack. It imports nothing, so any layer may
 * use it.
 */

/** What one step decided: the sequence is over with `value`, or it runs again after `waitMs`. */
export type Step<T> = { readonly done: true; readonly value: T } | { readonly done: false; readonly waitMs: number | undefined };

/** End the sequence with `value`. */
export const finish = <T>(value: T): Step<T> => ({ done: true, value });

/** Run the step again: after `waitMs`, or right away when no wait is given. */
export const again = (waitMs?: number): Step<never> => ({ done: false, waitMs });

export interface StepOptions<T> {
  /**
   * Checked before every step, and cuts a wait short. A step that is already running is left to
   * finish, and what it returns still counts.
   */
  signal?: AbortSignal;
  /** The sequence's value once `signal` has aborted. Without it the sequence rejects with the signal's reason. */
  onAbort?: () => T;
  /** Stands in for the timer between steps (tests that must not sleep). The signal does not cut it short. */
  wait?: (ms: number) => Promise<void>;
}

const abortReason = (signal: AbortSignal | undefined): unknown => signal?.reason ?? new Error("aborted");

/**
 * Call `step` until it returns `finish(value)`, waiting between calls as each `again(ms)` asks.
 * The first step runs before this returns. A step that throws or rejects ends the sequence with
 * that error. Two steps never overlap.
 */
export function stepUntil<T>(step: () => Step<T> | Promise<Step<T>>, options: StepOptions<T> = {}): Promise<T> {
  const { signal, onAbort, wait } = options;
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => {
      try {
        if (onAbort === undefined) reject(abortReason(signal));
        else resolve(onAbort());
      } catch (error) {
        reject(error);
      }
    };
    const pause = (ms: number): void => {
      if (wait !== undefined) {
        wait(ms).then(tick, reject);
        return;
      }
      const timer = setTimeout(wake, ms);
      function wake(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", wake);
        tick();
      }
      signal?.addEventListener("abort", wake, { once: true });
    };
    const settle = (verdict: Step<T>): void => {
      if (verdict.done) resolve(verdict.value);
      // An abort while the step ran fired no listener of ours, so look before starting a wait.
      else if (verdict.waitMs === undefined || signal?.aborted) tick();
      else pause(verdict.waitMs);
    };
    function tick(): void {
      if (signal?.aborted) {
        stop();
        return;
      }
      // The step runs now and a throw becomes a rejection; `settle` always runs from a fresh
      // microtask, so steps that ask for no wait do not nest on the stack.
      let ran: Promise<Step<T>>;
      try {
        ran = Promise.resolve(step());
      } catch (err) {
        reject(err as Error);
        return;
      }
      ran.then(settle).catch(reject);
    }
    tick();
  });
}

export interface PollOptions {
  /** Pause between checks. */
  everyMs: number;
  /** Give up once this much time has passed, counted from the call. Looked at after a failed check. */
  timeoutMs?: number;
  /** Rejects the poll with the signal's reason, also in the middle of a pause. */
  signal?: AbortSignal;
}

/**
 * Call `check` every `everyMs` until it returns something truthy, and resolve with that. Resolves
 * `undefined` when `timeoutMs` has passed after a failed check (there is always a first check). A
 * rejection from `check` rejects the poll.
 */
export function pollUntil<T>(check: () => T | Promise<T>, options: PollOptions): Promise<T | undefined> {
  const until = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  const verdict = (value: T): Step<T | undefined> => {
    if (value) return finish(value);
    if (until !== undefined && Date.now() > until) return finish(undefined);
    return again(options.everyMs);
  };
  const step = (): Step<T | undefined> | Promise<Step<T | undefined>> => {
    const value = check();
    return value instanceof Promise ? value.then(verdict) : verdict(value);
  };
  return stepUntil(step, options.signal ? { signal: options.signal } : {});
}

/**
 * Run `fn` on each item strictly one after another. The first call is made before this returns,
 * the items are read as they are reached, and the first throw or rejection ends it: later items
 * are not touched.
 */
export function inOrder<T>(items: Iterable<T>, fn: (item: T, index: number) => void | Promise<void>): Promise<void> {
  const iterator = items[Symbol.iterator]();
  let index = 0;
  const proceed = (): Step<void> => again();
  return stepUntil((): Step<void> | Promise<Step<void>> => {
    const next = iterator.next();
    if (next.done) return finish(undefined);
    const ran = fn(next.value, index);
    index += 1;
    return ran instanceof Promise ? ran.then(proceed) : proceed();
  });
}
