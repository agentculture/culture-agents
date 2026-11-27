/**
 * Reattaching to the workers that survived a core restart (contract/README.md, step 7 and
 * "after a core restart"). For each non-terminal run the core pings the worker's own control
 * socket through `reconnectWorker`; an answering worker's `WorkerControl` goes into the service's
 * map, so `live_control` is true again. A worker that is alive but does not answer is never
 * reattached by guess and never signalled: its run keeps its logged state with `live_control: false`
 * and the attempt is made again, on the next control request and on a bounded backoff, for as
 * long as the worker is alive. A slow worker is not a gone worker.
 *
 * A control request that arrives while an attempt is still running waits for it (`settle`).
 */
import type { RunId } from "../contract/index.js";
import type { Reconnect, WorkerControl } from "../worker/spawn.js";

export type ReconnectFn = (stateDir: string, runId: RunId) => Promise<Reconnect>;

/** The first background retry after a live worker did not answer, and the most the backoff grows to. */
export const RETRY_FIRST_MS = 500;
export const RETRY_MAX_MS = 30_000;

export interface ReattacherOptions {
  stateDir: string;
  controls: Map<RunId, WorkerControl>;
  reconnect: ReconnectFn;
  warn: (line: string) => void;
}

const ignore = (): void => undefined;

export class Reattacher {
  private readonly pending = new Map<RunId, Promise<void>>();
  /** The next background retry of a live, silent worker, and the delay it was scheduled with. */
  private readonly retries = new Map<RunId, { delay: number; timer: NodeJS.Timeout | null }>();

  constructor(private readonly options: ReattacherOptions) {}

  /** Start a reattach attempt for a run unless one is running or the run is controlled; resolves when it has finished. Never rejects. */
  begin(runId: RunId): Promise<void> {
    const existing = this.pending.get(runId);
    if (existing) return existing;
    if (this.options.controls.has(runId)) return Promise.resolve();
    const retry = this.retries.get(runId);
    if (retry?.timer) clearTimeout(retry.timer);
    if (retry) retry.timer = null;
    const attempt = this.attempt(runId).finally(() => this.pending.delete(runId));
    this.pending.set(runId, attempt);
    return attempt;
  }

  /** Whether the run's attempt (started if need be) finished within `ms`. */
  async settle(runId: RunId, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
    try {
      return await Promise.race([this.begin(runId).then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async attempt(runId: RunId): Promise<void> {
    try {
      const result = await this.options.reconnect(this.options.stateDir, runId);
      if (result.live) this.options.controls.set(runId, result.control);
      if (!result.live && result.liveness.alive) this.retryLater(runId);
      else this.retries.delete(runId);
      // A worker that is not alive is settled `unknown` by the store read, as before.
    } catch (err) {
      // Liveness could not be established: try again on the next control request.
      this.options.warn(`culture-agents core: could not reattach to run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Schedule the next attempt for a live worker that did not answer, doubling the delay up to `RETRY_MAX_MS`. */
  private retryLater(runId: RunId): void {
    const previous = this.retries.get(runId)?.delay;
    const delay = previous === undefined ? RETRY_FIRST_MS : Math.min(previous * 2, RETRY_MAX_MS);
    const timer = setTimeout(() => {
      const retry = this.retries.get(runId);
      if (retry) retry.timer = null;
      this.begin(runId).then(ignore, ignore);
    }, delay);
    timer.unref();
    this.retries.set(runId, { delay, timer });
  }
}
