/**
 * Bound a call to the gateway or into a sandbox. The caller is released after `ms` whether or not
 * the underlying call honours an abort signal, so a hung sandbox command cannot hold a run in
 * `running` or `cancelling` forever. The signal, when the call takes one, is aborted as well.
 */
export class SandboxTimeoutError extends Error {
  override readonly name = "SandboxTimeoutError";
}

export async function withTimeout<T>(what: string, ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new SandboxTimeoutError(`${what} did not finish within ${Math.round(ms / 1000)} s`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([call(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}
