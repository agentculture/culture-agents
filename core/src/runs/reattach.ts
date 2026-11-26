/**
 * Reattaching to the workers that survived a core restart (contract/README.md, step 7 and
 * "after a core restart"). For each non-terminal run the core pings the worker's own control
 * socket through `reconnectWorker`; an answering worker's `WorkerControl` goes into the service's
 * map, so `live_control` is true again. A worker that is alive but does not answer is never
 * reattached by guess and never signalled: its run is reported `unknown` (see `scan.ts`).
 *
 * A control request that arrives while the attempt is still running waits for it (`settle`).
 */
import type { RunId } from "../contract/index.js";
import type { Reconnect } from "../worker/spawn.js";
import type { WorkerControl } from "../worker/spawn.js";

export type ReconnectFn = (stateDir: string, runId: RunId) => Promise<Reconnect>;

export interface ReattacherOptions {
  stateDir: string;
  controls: Map<RunId, WorkerControl>;
  reconnect: ReconnectFn;
  warn: (line: string) => void;
}

export class Reattacher {
  private readonly pending = new Map<RunId, Promise<void>>();
  private readonly attempted = new Set<RunId>();
  private readonly silent = new Map<RunId, string>();

  constructor(private readonly options: ReattacherOptions) {}

  /** Why the run's worker is alive but unreachable, or null. */
  unresponsive(runId: RunId): string | null {
    return this.silent.get(runId) ?? null;
  }

  /** Start the one reattach attempt for a run (idempotent); resolves when it has finished. Never rejects. */
  begin(runId: RunId): Promise<void> {
    const existing = this.pending.get(runId);
    if (existing) return existing;
    if (this.attempted.has(runId) || this.options.controls.has(runId)) return Promise.resolve();
    this.attempted.add(runId);
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
      else if (result.liveness.alive) this.silent.set(runId, `its worker (pid ${String(result.liveness.pid)}) is alive but its control socket did not answer: ${result.reason}`);
      // A worker that is not alive is settled `unknown` by the store read, as before.
    } catch (err) {
      // Liveness could not be established: try again on the next control request.
      this.attempted.delete(runId);
      this.options.warn(`culture-agents core: could not reattach to run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
