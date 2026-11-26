/**
 * The worker's run loop: one process per run. It records its identity, writes event 1
 * (`null` -> `queued`) durably, opens its control socket, then drives the harness through a
 * `Driver`, appending every event to the run's log, enforcing the deadline and writing the
 * terminal event. It is the log's only writer while it lives, and it does not depend on the
 * daemon: the daemon disappearing changes nothing here.
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:net";
import { pathToFileURL } from "node:url";

import {
  ContractValidationError,
  isTerminal,
  type ActionRecord,
  type ErrorBody,
  type Run,
  type RunEvent,
  type RunId,
  type RunState,
} from "../contract/index.js";
import { EventLogWriter, type EventInput } from "../store/event-log.js";
import { atomicWriteJson, runDir, runFile } from "../store/files.js";
import { identityOf, writeHeartbeat, writeWorkerIdentity } from "../store/liveness.js";
import { readRecord, writeRecord } from "../store/run-store.js";
import { closeControl, listenControl, type ControlReply, type ControlRequest } from "./control.js";
import type { Driver, DriverEvent, DriverFactory, DriverSelection } from "./driver.js";
import { writeRetained } from "./retained.js";

export interface WorkerOptions {
  stateDir: string;
  runId: RunId;
  /** Heartbeat interval. Default 1000 ms. */
  heartbeatMs?: number;
  /** How long a stop may take before the worker forces the harness down. Default 30 000 ms. */
  cancelGraceMs?: number;
  clock?: () => number;
}

const MAX_TIMER = 2 ** 31 - 1;
const clip = (text: string) => (text.length > 2000 ? `${text.slice(0, 1997)}...` : text);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const internal = (message: string): ErrorBody => ({ code: "internal", message, retryable: false });
const conflict = (runId: RunId, message: string, retryable: boolean): ControlReply => ({
  ok: false,
  error: { code: "conflict", message, retryable, run_id: runId },
});
const invalid = (message: string): ControlReply => ({ ok: false, error: { code: "invalid", message, retryable: false } });

export class RunWorker {
  private readonly dir: string;
  private readonly clock: () => number;
  private record!: Run;
  private writer!: EventLogWriter;
  private driver: Driver | null = null;
  private server: Server | null = null;
  private stopOrigin: "cancel" | "deadline" | null = null;
  private forcing: Promise<void> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private resolveDone!: (state: RunState) => void;
  readonly done = new Promise<RunState>((resolve) => (this.resolveDone = resolve));

  constructor(private readonly options: WorkerOptions) {
    this.dir = runDir(options.stateDir, options.runId);
    this.clock = options.clock ?? Date.now;
  }

  get state(): RunState | null {
    return this.writer.state;
  }

  /**
   * Make the run durable and controllable: identity, event 1, cursor and control socket, in
   * that order. When this resolves, the daemon may acknowledge the submit.
   */
  async open(): Promise<void> {
    this.record = readRecord(this.dir);
    if (this.record.id !== this.options.runId) throw new Error("run record id does not match the run directory");
    this.writer = EventLogWriter.open(this.dir, this.options.runId, this.clock);
    if (this.writer.cursor !== 0) {
      this.writer.close();
      throw new Error("the run already has events: a run's worker starts once and is never restarted");
    }
    writeWorkerIdentity(this.dir, identityOf(process.pid, this.clock));
    writeHeartbeat(this.dir, this.clock);
    this.record = { ...this.record, worker_pid: process.pid };
    this.apply(this.writer.transition("queued", null, true), true);
    this.server = await listenControl(this.dir, (req) => this.control(req));
    const beat = setInterval(() => writeHeartbeat(this.dir, this.clock), this.options.heartbeatMs ?? 1000);
    this.timers.push(beat);
  }

  /** Drive the run to a terminal state; resolves with it. */
  async run(): Promise<RunState> {
    this.armDeadline();
    try {
      this.driver = await this.loadDriver();
      // A stop that arrived before the harness started: it never ran, so it has stopped.
      if (this.writer.state === "cancelling") this.finishStop(null);
      if (!this.terminal()) {
        for await (const event of this.driver.start()) {
          this.onDriverEvent(event);
          if (this.terminal()) break;
        }
      }
      if (this.forcing) await this.forcing;
      if (!this.terminal()) this.fail(internal("The harness driver ended without reporting an outcome."));
    } catch (err) {
      if (this.forcing) await this.forcing;
      if (!this.terminal()) this.fail(internal(`The harness driver failed: ${messageOf(err)}`));
    }
    return this.done;
  }

  /** Create the run's driver from the module its `driver` file names. */
  private async loadDriver(): Promise<Driver> {
    const selection = JSON.parse(readFileSync(runFile(this.dir, "driver"), "utf8")) as DriverSelection;
    const url = selection.module.startsWith("file:") ? selection.module : pathToFileURL(selection.module).href;
    const mod = (await import(url)) as { createDriver?: DriverFactory };
    if (typeof mod.createDriver !== "function") throw new Error("the driver module does not export createDriver");
    return await mod.createDriver({ run: this.record, runDir: this.dir, options: selection.options });
  }

  /** Release the driver, timers and socket. The log and record stay. */
  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    await this.driver?.dispose().catch(() => undefined);
    if (this.server) await closeControl(this.dir, this.server);
    this.server = null;
    this.writer.close();
  }

  private terminal(): boolean {
    return this.writer.state !== null && isTerminal(this.writer.state);
  }

  private append(input: EventInput): RunEvent | null {
    return this.terminal() ? null : this.writer.append(input);
  }

  private transition(to: RunState, reason: string | null): void {
    if (this.terminal()) return;
    const event = this.writer.transition(to, reason === null ? null : clip(reason));
    this.apply(event, isTerminal(to));
    if (isTerminal(to)) {
      for (const t of this.timers) clearTimeout(t);
      this.timers = [];
      this.resolveDone(to);
    }
  }

  /** Keep the record's cached state fields in step with the log (the log stays authoritative). */
  private apply(event: RunEvent, durable: boolean): void {
    const data = event.data as { to: RunState; reason: string | null };
    const terminal = isTerminal(data.to);
    this.record = {
      ...this.record,
      state: data.to,
      state_reason: data.reason,
      terminal,
      updated_at: event.time,
      started_at: this.record.started_at ?? (data.to === "running" ? event.time : null),
      ended_at: terminal ? event.time : null,
      cursor: event.cursor,
      live_control: false,
    };
    writeRecord(this.dir, this.record, durable);
  }

  private fail(error: ErrorBody): void {
    // A driver's message can be any length (a stack, captured stderr); the contract caps it, and an
    // unclipped one would fail validation here and leave the run without its terminal event.
    error = { ...error, message: clip(error.message) };
    this.append({ kind: "run.error", data: { error, fatal: true } });
    this.transition("failed", error.message);
  }

  private onDriverEvent(event: DriverEvent): void {
    const state = this.writer.state;
    switch (event.type) {
      case "started":
        if (state === "queued") this.transition("running", null);
        return;
      case "output":
        this.append({ kind: "run.output", data: event.data });
        return;
      case "error":
        this.append({ kind: "run.error", data: { error: { ...event.error, message: clip(event.error.message) }, fatal: false } });
        return;
      case "completed":
        if (state === "queued") this.transition("running", "the harness completed before reporting a start");
        if (event.collected) this.recordCollected(event.collected);
        this.transition("succeeded", null);
        return;
      case "failed":
        // Before the terminal event: once the run reads `failed`, the reclaim already finds the retention.
        if (event.retained) writeRetained(this.dir, event.retained);
        this.fail(event.error);
        return;
      case "stopped":
        if (state === "cancelling") this.finishStop(null);
        else this.fail(internal("The harness stopped without a stop request."));
        return;
    }
  }

  /** Where the run's commits landed: the branch on the record, the SHAs beside it, both before the terminal event. */
  private recordCollected(collected: { branch: string; commits: string[] }): void {
    atomicWriteJson(runFile(this.dir, "collected"), { branch: collected.branch, commits: collected.commits }, true);
    this.record = { ...this.record, branch: collected.branch };
    writeRecord(this.dir, this.record, true); // before the terminal event: a reader that sees `succeeded` sees the branch
  }

  private finishStop(note: string | null): void {
    if (this.stopOrigin === "deadline") this.transition("timed_out", note ?? "deadline reached");
    else this.transition("cancelled", note);
  }

  /** queued/running -> cancelling, ask the driver to stop, and force it down after the grace period. */
  private requestStop(origin: "cancel" | "deadline", reason: string): void {
    const state = this.writer.state;
    if (state !== "queued" && state !== "running") return;
    this.stopOrigin = origin;
    this.transition("cancelling", reason);
    const grace = this.options.cancelGraceMs ?? 30_000;
    this.timers.push(
      setTimeout(() => {
        if (this.writer.state !== "cancelling") return;
        const note = `the harness did not confirm the stop within ${grace} ms; the worker forced it down`;
        this.forcing = (this.driver?.dispose() ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => {
            // A driver still in its retention cleanup has kept the sandbox but not yet said so; the record goes before the terminal event.
            const kept = this.driver?.retained?.() ?? null;
            if (kept) writeRetained(this.dir, kept);
            this.finishStop(note);
          });
      }, grace),
    );
    void this.driver?.cancel(origin === "deadline" ? "deadline" : reason).catch((err: unknown) => {
      this.append({ kind: "run.error", data: { error: internal(clip(`cancel failed: ${String(err)}`)), fatal: false } });
    });
  }

  private armDeadline(): void {
    if (this.record.deadline === null) return;
    const at = Date.parse(this.record.deadline);
    const arm = () => {
      const left = at - this.clock();
      if (left <= 0) {
        this.requestStop("deadline", "deadline");
        return;
      }
      this.timers.push(setTimeout(arm, Math.min(left, MAX_TIMER)));
    };
    arm();
  }

  private checkAction(action: ActionRecord, kind: ActionRecord["kind"]): string | null {
    if (action.run_id !== this.record.id) return "The action is for a different run.";
    if (action.kind !== kind) return `The action kind must be ${kind}.`;
    if (action.outcome !== "accepted" || action.error !== null) return "The action must be an accepted record.";
    return null;
  }

  /** Record a refusal the core decided. A run that ended meanwhile takes no record, and the reply says so. */
  private refuse(action: ActionRecord, ok: () => ControlReply): ControlReply {
    const id = this.record.id;
    if (action.run_id !== id || action.outcome !== "refused") return invalid("The refusal record does not match this run.");
    try {
      if (this.append({ kind: "run.refused", data: { action } }) === null) return conflict(id, "The run ended before the refusal was recorded.", false);
    } catch (err) {
      if (err instanceof ContractValidationError) return invalid(err.message);
      throw err;
    }
    return ok();
  }

  private async control(req: ControlRequest): Promise<ControlReply> {
    const ok = (): ControlReply => ({ ok: true, pid: process.pid, state: this.writer.state, cursor: this.writer.cursor });
    if (req.op === "ping") return ok();
    const id = this.record.id;
    const state = this.writer.state;
    if (state === null || isTerminal(state)) return conflict(id, `The run is already ${String(state)}.`, false);
    if (req.op === "refuse") return this.refuse(req.action, ok);
    const bad = this.checkAction(req.action, req.op);
    if (bad !== null) return invalid(bad);
    if (req.op === "steer") {
      if (state !== "running") return conflict(id, `A steer needs a running run; this run is ${state}.`, state === "queued");
      return this.steer(req.action, req.message, ok);
    }
    // A cancel is accepted when the worker takes the stop decision, which it enforces itself
    // (cancelling now, the driver asked to stop, forced down after the grace period), so it is
    // recorded before the stop starts and holds even when the driver's cancel call fails.
    this.append({ kind: "run.control", data: { action: req.action } });
    const by = `cancel requested by ${req.action.caller.id}`;
    this.requestStop("cancel", req.reason ? `${by}: ${req.reason}` : by);
    return ok();
  }

  /**
   * Deliver a steer, then record it. `run.control` means accepted, so it is written only after the
   * driver took the steer. A delivery failure is answered `unavailable` and logged as a non-fatal
   * `run.error` (the contract's `run.refused` carries only `unsupported` or `conflict`). A run that
   * ended during delivery gets no record (nothing follows a terminal event) and a `conflict`.
   */
  private async steer(action: ActionRecord, message: string, ok: () => ControlReply): Promise<ControlReply> {
    const id = this.record.id;
    try {
      if (this.driver === null) throw new Error("the harness driver is not loaded");
      await this.driver.steer(message);
    } catch (err) {
      const why = `The steer ${action.id} could not be delivered to the harness: ${messageOf(err)}`;
      const error: ErrorBody = { code: "unavailable", message: clip(why), retryable: true };
      this.append({ kind: "run.error", data: { error, fatal: false } });
      return { ok: false, error };
    }
    if (this.append({ kind: "run.control", data: { action } }) === null) {
      return conflict(id, `The run ended (${String(this.writer.state)}) while the steer was being delivered; it was not recorded as accepted.`, false);
    }
    return ok();
  }
}

/** Open, run and close one worker; resolves with the terminal state. */
export async function runWorker(options: WorkerOptions): Promise<RunState> {
  const worker = new RunWorker(options);
  await worker.open();
  try {
    return await worker.run();
  } finally {
    await worker.close();
  }
}
