/**
 * Bound a call to the gateway or into a sandbox. The caller is released after `ms` whether or not
 * the underlying call honours an abort signal, so a hung sandbox command cannot hold a run in
 * `running` or `cancelling` forever. The signal, when the call takes one, is aborted as well.
 *
 * With `outer`, the caller is released the same way when that signal aborts (a cancel, a closed
 * backend), with the signal's reason, and the call's signal is aborted with it.
 */
export class SandboxTimeoutError extends Error {
  override readonly name = "SandboxTimeoutError";
}

const reasonOf = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error("aborted"));

export async function withTimeout<T>(what: string, ms: number, call: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  if (outer?.aborted) throw reasonOf(outer);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const released = new Promise<never>((_, reject) => {
    const release = (error: Error): void => {
      controller.abort(error);
      reject(error);
    };
    timer = setTimeout(() => release(new SandboxTimeoutError(`${what} did not finish within ${Math.round(ms / 1000)} s`)), ms);
    if (outer) {
      onAbort = () => release(reasonOf(outer));
      outer.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([call(controller.signal), released]);
  } finally {
    clearTimeout(timer);
    if (onAbort) outer?.removeEventListener("abort", onAbort);
  }
}
