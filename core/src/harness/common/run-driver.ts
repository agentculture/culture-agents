/**
 * The driver every harness shares: open the workspace, start the harness, run one turn, then
 * either collect the run's commits (completed) or stop everything (cancel), and release the
 * workspace on every exit path. Harness specifics live behind `HarnessBackend`; where the
 * harness runs lives behind `Workspace`. The worker owns the event log, deadline and state
 * machine; this class only reports `DriverEvent`s, ending with exactly one outcome.
 */
import type { ErrorBody } from "../../contract/index.js";
import { RETAIN_FAILED_SANDBOX_DAYS, type Driver, type DriverEvent } from "../../worker/driver.js";
import { describeProcs, newProcesses } from "./processes.js";
import { EventQueue, errorMessage, sleep } from "./queue.js";
import type {
  Collected,
  HarnessBackend,
  HarnessSession,
  Proc,
  StopReport,
  TurnEvent,
  TurnHandle,
  TurnOutcome,
  Workspace,
  WorkspaceFactory,
} from "./types.js";

export interface RunDriverOptions {
  task: string;
  /** Commit message for changes the harness left uncommitted. */
  commitMessage: string;
  /** How long a stopped turn may take to wind down before the driver stops waiting. Default 15 s. */
  stopSettleMs?: number;
  /** Pause before each process listing after a stop (lets exiting processes go). Default 1.5 s. */
  processSettleMs?: number;
  /**
   * Days the workspace is kept when the turn completed but its work could not be committed or
   * brought to the host. Default RETAIN_FAILED_SANDBOX_DAYS (7); 0 keeps nothing.
   */
  retainFailedDays?: number;
  /** The clock for the retention's end (tests). */
  now?: () => number;
}

export { RETAIN_FAILED_SANDBOX_DAYS };
const DAY_MS = 86_400_000;

/** One process check: what was found, or why the check could not look. */
interface Listing {
  procs: Proc[];
  failed: string | null;
}

const ERROR_MESSAGE_LIMIT = 2000;
const clip = (text: string) => (text.length > ERROR_MESSAGE_LIMIT ? `${text.slice(0, ERROR_MESSAGE_LIMIT - 3)}...` : text);
const diagnostic = (text: string): DriverEvent => ({ type: "output", data: { channel: "diagnostic", text } });

/** Iterate `source` until it ends or `stop` resolves (then the source is abandoned). */
async function* until<T>(source: AsyncIterable<T>, stop: Promise<void>): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  const stopped = stop.then(() => ({ done: true, value: undefined }) as IteratorResult<T>);
  for (;;) {
    const next = await Promise.race([it.next(), stopped]);
    if (next.done) {
      void Promise.resolve(it.return?.()).catch(() => undefined);
      return;
    }
    yield next.value;
  }
}

export class RunDriver<W extends Workspace> implements Driver {
  private readonly queue = new EventQueue<DriverEvent>();
  private readonly abort = new AbortController();
  private workspace: W | null = null;
  private session: HarnessSession | null = null;
  private turn: TurnHandle | null = null;
  private baseline: Proc[] = [];
  private begun = false;
  private turnOver = false;
  private cancelRequested = false;
  private disposed = false;
  private forceStop!: () => void;
  private readonly forced = new Promise<void>((resolve) => (this.forceStop = resolve));
  private destroying: Promise<boolean> | null = null;
  /** The workspace is kept for recovery (a retention): nothing in this driver deletes it any more. */
  private kept = false;
  private stopTimer: NodeJS.Timeout | undefined;
  /** What `run` is doing, for the message of a failure there. */
  private stage = "open the workspace";
  /** Set after a cancel: what the process checks saw. */
  stopReport: StopReport | null = null;
  /** Set after a completed turn: the commits brought to the host, if any. */
  collected: Collected | null = null;

  constructor(
    private readonly factory: WorkspaceFactory<W>,
    private readonly backend: HarnessBackend<W>,
    private readonly options: RunDriverOptions,
  ) {}

  start(): AsyncIterable<DriverEvent> {
    if (this.begun) throw new Error("start() is called once per driver");
    this.begun = true;
    void this.run();
    return this.queue;
  }

  async steer(message: string): Promise<void> {
    if (!this.turn || this.turnOver || this.cancelRequested || this.disposed) throw new Error("The run has no running turn to steer.");
    await this.turn.steer(message);
  }

  async cancel(): Promise<void> {
    if (this.cancelRequested || this.disposed) return;
    this.cancelRequested = true;
    // Before the turn exists, abort the opening stages; afterwards the harness is interrupted
    // through its own control, so the measurements after the stop see what it left behind.
    if (!this.turn) this.abort.abort(new Error("cancelled"));
    this.stopTimer = setTimeout(() => this.forceStop(), this.options.stopSettleMs ?? 15_000);
    if (this.turn && !this.turnOver) {
      try {
        await this.turn.interrupt();
      } catch (err) {
        this.queue.push({ type: "error", error: this.error("internal", `interrupt failed: ${errorMessage(err)}`, false) });
        this.forceStop();
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.stopTimer);
    this.abort.abort(new Error("disposed"));
    this.forceStop();
    await this.session?.close().catch(() => undefined);
    await this.destroyWorkspace();
    this.queue.end();
  }

  private get stopping(): boolean {
    return this.cancelRequested || this.disposed;
  }

  private error(code: ErrorBody["code"], message: string, retryable: boolean): ErrorBody {
    return { code, message: clip(message), retryable };
  }

  private onTurnEvent(event: TurnEvent): void {
    this.queue.push(event.type === "output" ? { type: "output", data: event.data } : { type: "error", error: event.error });
  }

  private finish(outcome: DriverEvent): void {
    clearTimeout(this.stopTimer);
    this.queue.push(outcome);
    this.queue.end();
  }

  private async run(): Promise<void> {
    this.stage = "open the workspace";
    try {
      this.workspace = await this.factory.open(this.abort.signal);
      if (this.stopping) return await this.stopAll();
      this.stage = "list the workspace processes";
      this.baseline = await this.workspace.processes();
      this.stage = "start the harness";
      this.session = await this.backend.open(this.workspace, this.abort.signal, (e) => this.onTurnEvent(e));
      if (this.stopping) return await this.stopAll();
      this.stage = "start the turn";
      this.turn = await this.session.startTurn(this.options.task);
      this.queue.push({ type: "started" });
      if (this.stopping) void this.turn.interrupt().catch(() => this.forceStop());
      this.stage = "stream the turn";
      for await (const event of until(this.turn.events, this.forced)) this.onTurnEvent(event);
      if (this.stopping) return await this.stopAll();
      const outcome = await this.turn.outcome;
      this.turnOver = true; // from here a steer is refused and a cancel has no turn to interrupt
      if (this.stopping) return await this.stopAll();
      if (outcome.kind !== "completed") {
        await this.release();
        return this.finish({ type: "failed", error: this.turnFailure(outcome) });
      }
      this.stage = "close the harness";
      await this.session.close();
      if (this.stopping) return await this.stopAll();
      if (!(await this.commitAndCollect(this.workspace))) return;
      await this.complete(outcome.summary);
    } catch (err) {
      await this.failRun(err);
    }
  }

  /** The error of a turn that ended without completing. */
  private turnFailure(outcome: Exclude<TurnOutcome, { kind: "completed" }>): ErrorBody {
    return outcome.kind === "failed"
      ? outcome.error
      : this.error("internal", "The harness ended the turn as interrupted without a cancel request.", false);
  }

  /**
   * Commit what the harness left and bring the run's commits to the host. False when the run has
   * ended here instead: stopped, or failed with its work kept in the workspace.
   */
  private async commitAndCollect(workspace: W): Promise<boolean> {
    try {
      this.stage = "commit the run's changes";
      const commits = await workspace.commitAll(this.options.commitMessage);
      if (this.stopping) {
        await this.stopAll();
        return false;
      }
      this.stage = "collect the run's commits";
      this.collected = commits > 0 ? await workspace.collect() : null;
      return true;
    } catch (err) {
      if (this.stopping) await this.stopAll();
      else await this.failAfterTurn(this.stage, err);
      return false;
    }
  }

  /** The turn completed and its commits are on the host: report them, delete the workspace, finish. */
  private async complete(summary: string | undefined): Promise<void> {
    this.queue.push(
      diagnostic(this.collected ? `collected ${this.collected.commits} commit(s) on ${this.collected.branch}` : "the run made no commits"),
    );
    // A stop that arrives once the commits are on the host no longer changes the outcome: the
    // work is done and collected, so the run completes and reports its branch.
    if (!(await this.destroyWorkspace())) {
      this.queue.push({ type: "error", error: this.error("unavailable", "The run's sandbox could not be deleted.", true) });
    }
    this.finish({
      type: "completed",
      ...(summary === undefined ? {} : { summary }),
      ...(this.collected ? { collected: { branch: this.collected.branch, commits: this.collected.shas } } : {}),
    });
  }

  /** `run` threw: stop when a stop was asked for, otherwise release everything and fail naming the stage. */
  private async failRun(err: unknown): Promise<void> {
    if (this.stopping) return await this.stopAll();
    await this.release();
    const environment = this.stage === "open the workspace";
    this.finish({ type: "failed", error: this.error(environment ? "unavailable" : "internal", `Could not ${this.stage}: ${errorMessage(err)}`, environment) });
  }

  /**
   * The turn completed but its work could not be committed or brought to the host. The workspace
   * then holds the only copy of that work, so where it can be kept it is: the harness is closed
   * and what it left running is killed as usual, the workspace is not destroyed, and the run
   * fails saying where the work is, until when, and how to get it out. A cancelled run and a run
   * whose turn failed never come here.
   */
  private async failAfterTurn(stage: string, err: unknown): Promise<void> {
    const why = `Could not ${stage}: ${errorMessage(err)}`;
    const days = this.options.retainFailedDays ?? RETAIN_FAILED_SANDBOX_DAYS;
    const retention = days > 0 ? (this.workspace?.retention?.() ?? null) : null;
    if (!this.workspace || retention === null) {
      await this.release();
      return this.finish({ type: "failed", error: this.error("internal", why, false) });
    }
    this.kept = true; // from here no path of this driver deletes the workspace, a late dispose included
    // The harness was closed before the commit; what it left running is killed, since this sandbox is not deleted.
    const left = await this.settled(this.options.processSettleMs ?? 1500);
    if (left.failed === null && left.procs.length > 0) await this.workspace.kill(left.procs.map((p) => p.pid)).catch(() => undefined);
    await this.workspace.keep?.().catch(() => undefined);
    const until = new Date((this.options.now ?? Date.now)() + days * DAY_MS).toISOString();
    // The recovery instructions are the point of the message, so the cause gives way to them.
    const tail =
      `. The turn had completed, so sandbox ${retention.sandbox} is kept until ${until} ` +
      `with the run's work in it. To get the work out: ${retention.recover}`;
    const room = Math.max(200, Math.min(900, ERROR_MESSAGE_LIMIT - tail.length));
    const message = (why.length > room ? `${why.slice(0, room - 3)}...` : why) + tail;
    this.finish({ type: "failed", error: this.error("internal", message, false), retained: { sandbox: retention.sandbox, until } });
  }

  /** Close the harness and destroy the workspace, swallowing errors (failure paths). */
  private async release(): Promise<void> {
    await this.session?.close().catch(() => undefined);
    await this.destroyWorkspace();
  }

  private destroyWorkspace(): Promise<boolean> {
    if (!this.workspace || this.kept) return Promise.resolve(true);
    this.destroying ??= this.workspace.destroy().then(
      () => true,
      () => false,
    );
    return this.destroying;
  }

  /** The new processes, or why they could not be listed (never an empty list standing in for a failure). */
  private async listNew(): Promise<Listing> {
    if (!this.workspace) return { procs: [], failed: null };
    try {
      return { procs: newProcesses(this.baseline, await this.workspace.processes()), failed: null };
    } catch (err) {
      return { procs: [], failed: errorMessage(err) };
    }
  }

  /**
   * The new processes once none is left, or what is still there (or the listing failure) after
   * `maxMs`. Polled, so a harness that stops promptly does not hold the run in `cancelling` for
   * the whole wait.
   */
  private async settled(maxMs: number): Promise<Listing> {
    const deadline = Date.now() + maxMs;
    for (;;) {
      const listing = await this.listNew();
      const left = deadline - Date.now();
      if ((listing.failed === null && listing.procs.length === 0) || left <= 0) return listing;
      await sleep(Math.min(250, left));
    }
  }

  /** After a cancel: check processes, close the harness, kill leftovers, destroy, report `stopped`. */
  private async stopAll(): Promise<void> {
    if (this.queue.isEnded) return;
    const settle = this.options.processSettleMs ?? 1500;
    const report: StopReport = { afterInterrupt: [], afterClose: [], killed: [], remaining: [], listingFailed: {}, destroyed: false };
    const record = (field: "afterInterrupt" | "afterClose" | "remaining", listing: Listing): void => {
      report[field] = listing.procs;
      if (listing.failed !== null) report.listingFailed[field] = listing.failed;
    };
    const began = Date.now();
    if (this.workspace && !this.disposed) {
      // What the interrupt alone left running is only reported; the harness itself is still up here.
      await sleep(Math.min(settle, 500));
      record("afterInterrupt", await this.listNew());
      await this.session?.close().catch(() => undefined);
      const afterClose = await this.settled(settle);
      record("afterClose", afterClose);
      if (afterClose.failed !== null) {
        // Nothing to aim a kill at; deleting the workspace below is what ends its processes.
        record("remaining", afterClose);
      } else if (afterClose.procs.length > 0) {
        report.killed = afterClose.procs.map((p) => p.pid);
        await this.workspace.kill(report.killed).catch(() => undefined);
        record("remaining", await this.settled(settle));
      }
    } else {
      await this.session?.close().catch(() => undefined);
    }
    const processesMs = Date.now() - began;
    report.destroyed = await this.destroyWorkspace();
    this.stopReport = report;
    const seen = (field: "afterInterrupt" | "afterClose" | "remaining"): string => {
      const failed = report.listingFailed[field];
      return failed === undefined ? describeProcs(report[field]) : `could not be listed (${failed.slice(0, 200)})`;
    };
    if (this.workspace) {
      this.queue.push(
        diagnostic(
          `stop: after interrupt ${seen("afterInterrupt")}; after harness close ${seen("afterClose")}; ` +
            `killed ${report.killed.length}; remaining ${seen("remaining")}; workspace destroyed ${report.destroyed}; ` +
            `took ${Date.now() - began} ms (${processesMs} ms closing the harness and its processes)`,
        ),
      );
    }
    this.finish({ type: "stopped" });
  }
}
