/**
 * The run service: the daemon's `RunService` over the run store, per-run worker processes and the
 * harness catalog port. It performs the service-side steps of contract/README.md's order of checks.
 *
 * Live control is held only for workers this process spawned. After a core restart the map is
 * empty, so a surviving worker's run reports `live_control: false` and its steer and cancel are
 * refused naming `reconnect`; the worker is never signalled. Every reported state is derived from
 * the store (scan.ts), and a run with neither a live worker nor a terminal event settles `unknown`.
 */
import {
  buildRunId,
  buildSessionId,
  newUlid,
  parseMeshId,
  type AcceptedResponse,
  type Agent,
  type AgentList,
  type CancelRequest,
  type Capabilities,
  type ErrorBody,
  type EventPage,
  type Run,
  type RunEvent,
  type RunId,
  type RunResult,
  type SteerRequest,
  type SubmitRequest,
} from "../contract/index.js";
import type { AllowlistState } from "../daemon/allowlist.js";
import { ControlError, notFound, unavailable, unsupported } from "../daemon/errors.js";
import type { DeferredKind, DeferredRequest, RunListQuery, RunService } from "../daemon/ports.js";
import { deriveRun } from "../store/derive.js";
import { readLog } from "../store/event-log.js";
import { runDir } from "../store/files.js";
import { followEvents, readEvents } from "../store/run-store.js";
import { readRetained } from "../worker/retained.js";
import { WorkerSpawnError, spawnWorker, type WorkerControl } from "../worker/spawn.js";
import { buildAgents, harnessDocuments } from "./agents.js";
import { control, recordDeferredRefusal, type ControlKind } from "./control.js";
import type { HarnessCatalog } from "./ports.js";
import { activeRunFor, readRun, resultOf, scanRuns, unreadableRunHolding, UnreadableRunError, type ScanOptions } from "./scan.js";

export interface RunServiceOptions {
  /** The run store's state directory. */
  stateDir: string;
  /** This core's node name (the `<node>` of local agents). */
  node: string;
  catalog: HarnessCatalog;
  /** The allow-list state as the daemon reads it (agents are the agents it names). */
  allowlist: () => AllowlistState;
  now?: () => Date;
  /** Passed to every worker. */
  worker?: { heartbeatMs?: number; cancelGraceMs?: number; readyTimeoutMs?: number; env?: NodeJS.ProcessEnv };
  /** Poll interval of a live event stream. Default 20 ms. */
  followPollMs?: number;
  warn?: (line: string) => void;
}

export class StoreRunService implements RunService {
  private readonly controls = new Map<RunId, WorkerControl>();
  private readonly scan: ScanOptions;
  private readonly now: () => Date;
  /** Serializes submits so the busy check and the spawn are one step per repository. */
  private submitChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RunServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.scan = {
      stateDir: options.stateDir,
      controllable: (id) => this.controls.has(id),
      warn:
        options.warn ??
        ((line) => {
          process.stderr.write(`${line}\n`);
        }),
    };
  }

  /**
   * Startup reconciliation: rebuild every run from disk. Orphaned runs (no live worker, no
   * terminal event) get `unknown` appended; surviving workers are only read, never signalled, and
   * report `live_control: false`. Existing events are never rewritten. Returns the runs.
   */
  reconcile(): Run[] {
    return scanRuns(this.scan);
  }

  /** Ask the harnesses to delete what finished runs of this store left behind (README: cancel, sandbox). */
  async reclaim(): Promise<string[]> {
    const reclaim = this.options.catalog.reclaim;
    if (!reclaim) return [];
    // A finished run that kept its sandbox (a completed turn whose work could not be brought to the
    // host) is left alone until its retention is over; after that it is reclaimed like any other.
    const now = this.now().getTime();
    const retained = (id: RunId): boolean => (readRetained(runDir(this.options.stateDir, id))?.until ?? 0) > now;
    const finished = scanRuns(this.scan).filter((run) => run.terminal && !retained(run.id)).map((run) => run.id);
    return finished.length === 0 ? [] : reclaim.call(this.options.catalog, finished);
  }

  submit(request: SubmitRequest): Promise<Run> {
    const next = this.submitChain.then(() => this.submitNow(request));
    this.submitChain = next.catch(() => undefined);
    return next;
  }

  private async submitNow(request: SubmitRequest): Promise<Run> {
    // Step 4: harness known, then available.
    const entry = this.options.catalog.get(request.harness);
    if (!entry) throw notFound(`No harness ${request.harness} is known to this core.`);
    const capabilities = await entry.capabilities();
    if (!capabilities.available) throw unavailable(`The ${request.harness} harness is not available on this core; check its binary, credentials and sandbox with agents doctor.`);
    // Step 5: capabilities, in contract order.
    if (parseMeshId(request.agent_id)?.node !== this.options.node) {
      throw unsupported("placement", `Agent ${request.agent_id} is not on this core's node ${this.options.node}; multi-host placement is not supported.`);
    }
    if (request.session_id !== undefined) throw unsupported("continue_session", "Continuing a session is not supported in this API version.");
    if (request.parent_run_id !== undefined) throw unsupported("delegate", "Delegating from a parent run is not supported in this API version.");
    // Step 6: one active run per canonical repository (the server passes `repo` canonicalized).
    const unreadable = unreadableRunHolding(this.scan, request.repo);
    if (unreadable !== null) {
      throw new ControlError("internal", `Run ${unreadable} has a live worker but its stored state cannot be read, so ${request.repo} may be in use; resolve that run before submitting here.`);
    }
    const active = activeRunFor(this.scan, request.repo);
    if (active !== null) {
      throw new ControlError("busy", `Repository ${request.repo} already has the active run ${active.id}; wait for it to end or cancel it.`, {
        active_run_id: active.id,
        repo: request.repo,
      });
    }
    // Step 7: create the session and run, start the worker, acknowledge once durable.
    const created = this.now();
    const run = buildRunId(request.agent_id, newUlid(created.getTime()));
    const record: Run = {
      id: run,
      agent_id: request.agent_id,
      session_id: buildSessionId(request.agent_id, newUlid(created.getTime())),
      harness: request.harness,
      repo: request.repo,
      task: request.task,
      owner: request.caller,
      idempotency_key: request.idempotency_key ?? null,
      deadline: request.deadline ?? null,
      state: "queued",
      state_reason: null,
      terminal: false,
      created_at: created.toISOString(),
      updated_at: created.toISOString(),
      started_at: null,
      ended_at: null,
      cursor: 1,
      live_control: true,
      worker_pid: null,
      branch: null,
    };
    const w = this.options.worker ?? {};
    let spawned;
    try {
      spawned = await spawnWorker({
        stateDir: this.options.stateDir,
        run: record,
        driver: { module: entry.driver.module, options: entry.driver.options },
        ...(w.heartbeatMs !== undefined && { heartbeatMs: w.heartbeatMs }),
        ...(w.cancelGraceMs !== undefined && { cancelGraceMs: w.cancelGraceMs }),
        ...(w.readyTimeoutMs !== undefined && { readyTimeoutMs: w.readyTimeoutMs }),
        ...(w.env !== undefined && { env: w.env }),
      });
    } catch (err) {
      if (err instanceof WorkerSpawnError) throw unavailable(`The run's worker could not be started: ${err.message}`);
      throw err;
    }
    this.controls.set(run, spawned.control);
    // The acknowledged run is the run as of event 1 (`null` -> `queued`): the durability point.
    const first = readLog(spawned.runDir, run).events.slice(0, 1);
    const acknowledged = deriveRun({ record: { ...record, worker_pid: spawned.pid }, events: first, alive: true, controllable: true, now: created.toISOString() });
    if (acknowledged === null) throw new ControlError("internal", "The run was durable but its first event could not be read back.");
    return acknowledged.run;
  }

  async listRuns(query: RunListQuery): Promise<Run[]> {
    const runs = scanRuns(this.scan);
    for (const run of runs) if (run.terminal) this.controls.delete(run.id); // a finished run's worker channel is not kept
    return runs
      .filter((run) => (query.state === undefined || run.state === query.state) && (query.agent_id === undefined || run.agent_id === query.agent_id))
      .slice(0, query.limit);
  }

  /** One run, or null when there is none. A run that exists but cannot be read is `internal` on every route, never "no such run". */
  private read(runId: string): Run | null {
    try {
      return readRun(this.scan, runId, true);
    } catch (err) {
      if (err instanceof UnreadableRunError) throw new ControlError("internal", `Run ${runId} exists but its stored state cannot be read (${err.detail.slice(0, 300)}).`);
      throw err;
    }
  }

  async getRun(runId: string): Promise<Run | null> {
    const run = this.read(runId);
    if (run?.terminal) this.controls.delete(run.id);
    return run;
  }

  async readEvents(runId: string, after: number, limit: number): Promise<EventPage | null> {
    const run = this.read(runId);
    if (run === null) return null;
    const page = readEvents(runDir(this.options.stateDir, run.id), run.id, after, limit);
    return { run_id: run.id, events: page.events, last_cursor: page.lastCursor, more: page.more };
  }

  async *streamEvents(runId: string, after: number, signal: AbortSignal): AsyncIterable<RunEvent> {
    const run = this.read(runId);
    if (run === null) throw notFound(`No run ${runId}.`, { run_id: runId });
    yield* followEvents(runDir(this.options.stateDir, run.id), run.id, after, { signal, pollMs: this.options.followPollMs ?? 20 });
  }

  async getResult(runId: string): Promise<RunResult> {
    const run = this.read(runId);
    if (run === null) throw notFound(`No run ${runId}.`, { run_id: runId });
    if (!run.terminal) throw new ControlError("conflict", `Run ${run.id} is ${run.state}; its result exists once it is terminal.`, { run_id: run.id, retryable: true });
    return resultOf(this.scan, run);
  }

  steer(runId: string, request: SteerRequest): Promise<AcceptedResponse["action"]> {
    return this.act("steer", runId, request);
  }

  cancel(runId: string, request: CancelRequest): Promise<AcceptedResponse["action"]> {
    return this.act("cancel", runId, request);
  }

  private async act(kind: ControlKind, runId: string, request: SteerRequest | CancelRequest): Promise<AcceptedResponse["action"]> {
    const run = this.read(runId);
    if (run === null) throw notFound(`No run ${runId}.`, { run_id: runId });
    const entry = this.options.catalog.get(run.harness);
    const capabilities = entry ? await entry.capabilities() : null;
    const worker = run.live_control ? (this.controls.get(run.id) ?? null) : null;
    return control(kind, { run, capabilities, worker, now: this.now }, request);
  }

  /** Step 4, decided by the server: write the refusal to the log of a live run this core controls. Never rejects. */
  async recordRefusal(runId: string, kind: DeferredKind, request: DeferredRequest, error: ErrorBody): Promise<void> {
    try {
      const run = this.read(runId);
      if (run === null) return;
      const worker = run.live_control ? (this.controls.get(run.id) ?? null) : null;
      await recordDeferredRefusal(kind, { run, worker, now: this.now }, request, error);
    } catch {
      // Nothing was recorded (the run cannot be read now); the caller still gets the refusal.
    }
  }

  async listAgents(): Promise<AgentList> {
    const harnesses = await harnessDocuments(this.options.catalog);
    const agents = buildAgents(this.options.allowlist().entries, scanRuns(this.scan), harnesses);
    return { node: this.options.node, agents, harnesses };
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    return (await this.listAgents()).agents.find((agent) => agent.id === agentId) ?? null;
  }

  listHarnesses(): Promise<Capabilities[]> {
    return harnessDocuments(this.options.catalog);
  }

  async getHarness(harness: string): Promise<Capabilities | null> {
    const entry = this.options.catalog.get(harness);
    return entry ? entry.capabilities() : null;
  }
}

/** A run service; no I/O until used. Call `reconcile()` once the daemon holds its lock. */
export function createRunService(options: RunServiceOptions): StoreRunService {
  return new StoreRunService(options);
}
