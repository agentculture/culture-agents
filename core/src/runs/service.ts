/**
 * The run service: the daemon's `RunService` over the run store, per-run worker processes and the
 * harness catalog port. It performs the service-side steps of contract/README.md's order of checks.
 *
 * Live control is held only for workers this process spawned. After a core restart the map is
 * empty, so a surviving worker's run reports `live_control: false` and its steer and cancel are
 * refused naming `reconnect`; the worker is never signalled. Every reported state is derived from
 * the store (scan.ts), and a run with neither a live worker nor a terminal event settles `unknown`.
 *
 * Idempotency keys (keys.ts, store/idempotency.ts): a submit writes its key, then the run
 * directory, then spawns the worker, so a core killed at any step leaves evidence that the next
 * core settles at startup (`reconcile`). Steer and cancel write their key before delivery.
 */
import {
  buildRunId,
  buildSessionId,
  newUlid,
  parseMeshId,
  type AcceptedResponse,
  type ActionRecord,
  type Agent,
  type AgentList,
  type CancelRequest,
  type Capabilities,
  type ErrorBody,
  type EventPage,
  type Limits,
  type Run,
  type RunEvent,
  type RunId,
  type RunResult,
  type SteerRequest,
  type SubmitRequest,
  type Submitter,
  type SubmitResponse,
} from "../contract/index.js";
import type { AllowlistState } from "../daemon/allowlist.js";
import { resolveBaseCommit, startRef } from "./base-commit.js";
import { ControlError, notFound, unavailable, unsupported } from "../daemon/errors.js";
import type { DeferredKind, DeferredRequest, RunListQuery, RunService } from "../daemon/ports.js";
import { deriveRun } from "../store/derive.js";
import { readLog } from "../store/event-log.js";
import { runDir } from "../store/files.js";
import { actionRecorded, KeyIndex, pruneKeys, recoverKeys, requestDigest, settleKey, type KeyEntry } from "../store/idempotency.js";
import { followEvents, readEvents } from "../store/run-store.js";
import { readRetained } from "../worker/retained.js";
import { WorkerSpawnError, reconnectWorker, spawnWorker, type WorkerControl } from "../worker/spawn.js";
import { withHostReport, readAdmission, submitWarnings, type HostReport } from "./admission.js";
import { buildAgents, harnessDocuments } from "./agents.js";
import { control, recordDeferredRefusal, type ControlKind } from "./control.js";
import { replayAction, replaySubmit, type SubmitFault } from "./keys.js";
import type { HarnessCatalog } from "./ports.js";
import { Reattacher, type ReconnectFn } from "./reattach.js";
import { readRun, resultOf, scanRuns, UnreadableRunError, type ScanOptions } from "./scan.js";
import { checkLimits, NO_LIMITS } from "./limits.js";

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
  /** How long a control request waits for its run's reattach attempt before `unavailable` with `retry_after_ms`. Default 5000. */
  reattachWaitMs?: number;
  /** Reaches a surviving worker. Default `reconnectWorker`; tests hold it open. */
  reconnect?: ReconnectFn;
  /** How store files are read (event logs, summaries). Default `fs.readFileSync`; tests inject a counting reader. */
  readFile?: (path: string) => Buffer;
  /** How long an established key of a terminal run is remembered after the run ended. Default 7 days. */
  keyRetentionMs?: number;
  /** Fault injection at each step of a submit (tests only). */
  submitFault?: SubmitFault;
  /** The operator's limits from the core's config file (daemon/limits.ts). Default: none. */
  limits?: Limits;
  /** The environment the heat signal's path is read from. Default: the process environment. */
  env?: Readonly<Record<string, string | undefined>>;
  /** How the heat state file is read (tests inject the payload). Default: `fs.readFileSync`. */
  readHeatFile?: (path: string) => string;
}

/** Default `keyRetentionMs`: 7 days. */
export const KEY_RETENTION_MS = 7 * 24 * 3600 * 1000;

export class StoreRunService implements RunService {
  private readonly controls = new Map<RunId, WorkerControl>();
  private readonly scan: ScanOptions;
  private readonly reattacher: Reattacher;
  private readonly now: () => Date;
  private readonly keys: KeyIndex;
  /** Serializes submits so the limit check and the spawn are one step. */
  private submitChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RunServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.keys = new KeyIndex(options.stateDir);
    const warn =
      options.warn ??
      ((line) => {
        process.stderr.write(`${line}\n`);
      });
    this.reattacher = new Reattacher({ stateDir: options.stateDir, controls: this.controls, reconnect: options.reconnect ?? ((dir, id) => reconnectWorker(dir, id)), warn });
    this.scan = { stateDir: options.stateDir, controllable: (id) => this.controls.has(id), unresponsive: (id) => this.reattacher.unresponsive(id), warn, ...(options.readFile && { readFile: options.readFile }) };
  }

  /**
   * Startup reconciliation: rebuild every run from disk. Orphaned runs (no live worker, no
   * terminal event) get `unknown` appended; surviving workers are never signalled: the core
   * reattaches to each over its control socket (started here, finished in the background; a control
   * request waits for its run's attempt). Existing events are never rewritten. Returns the runs.
   */
  reconcile(): Run[] {
    // Keys first: a reserved key is settled from the store (run established, or released).
    recoverKeys(this.keys);
    const runs = scanRuns(this.scan);
    for (const run of runs) if (!run.terminal) void this.reattacher.begin(run.id);
    this.pruneKeys(runs);
    return runs;
  }

  /** Forget established keys whose run left the store, or ended longer ago than the retention. */
  private pruneKeys(runs: Run[]): void {
    const byId = new Map(runs.map((run) => [run.id as string, run]));
    const cutoff = this.now().getTime() - (this.options.keyRetentionMs ?? KEY_RETENTION_MS);
    pruneKeys(this.keys, (entry) => {
      const run = byId.get(entry.run_id);
      return run === undefined || (run.terminal && Date.parse(run.ended_at ?? run.updated_at) < cutoff);
    });
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

  submit(request: SubmitRequest, submitter?: Submitter): Promise<SubmitResponse> {
    const next = this.submitChain.then(() => this.submitNow(request, submitter));
    this.submitChain = next.catch(() => undefined);
    return next;
  }

  private async submitNow(request: SubmitRequest, submitter?: Submitter): Promise<SubmitResponse> {
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
    // Step 6: a known idempotency key: the first run (replayed) or `conflict`, before the limit check.
    const key = request.idempotency_key;
    const digest = key === undefined ? null : requestDigest("submit", request);
    if (key !== undefined && digest !== null) {
      const replay = replaySubmit(this.keys, key, digest, (id) => this.read(id));
      if (replay !== null) return replay;
    }
    // Step 7: a limit the operator configured has room (none applies by default). The chain makes check and spawn one step.
    checkLimits(this.options.limits ?? NO_LIMITS, this.scan, request.repo);
    const warnings = submitWarnings(readAdmission(this.hostEnv(), this.now(), this.options.readHeatFile)); // a local submit under an unknown signal is admitted with a warning
    // Step 8: create the session and run, start the worker, acknowledge once durable.
    const baseCommit = await resolveBaseCommit(request.repo, startRef(entry.driver.options));
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
      ...(submitter !== undefined && { submitter }),
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
      base_commit: baseCommit,
    };
    // On disk: the key, then the run directory, then the worker.
    const fault = this.options.submitFault ?? (() => undefined);
    let reserved: KeyEntry | null = null;
    if (key !== undefined && digest !== null) {
      reserved = { scope: "submit", key, digest, run_id: run, state: "reserved", action: null, recorded_at: created.toISOString() };
      this.keys.put(reserved);
    }
    fault("after-key");
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
        onCreated: () => fault("after-run-dir"),
      });
    } catch (err) {
      // A run that reached event 1 keeps its key; otherwise the key is released.
      if (reserved !== null) settleKey(this.keys, reserved);
      if (err instanceof WorkerSpawnError) throw unavailable(`The run's worker could not be started: ${err.message}`);
      throw err;
    }
    this.controls.set(run, spawned.control);
    fault("after-spawn");
    if (reserved !== null) this.keys.establish(reserved);
    // The acknowledged run is the run as of event 1 (`null` -> `queued`): the durability point.
    const first = readLog(spawned.runDir, run).events.slice(0, 1);
    const acknowledged = deriveRun({ record: { ...record, worker_pid: spawned.pid }, events: first, alive: true, controllable: true, now: created.toISOString() });
    if (acknowledged === null) throw new ControlError("internal", "The run was durable but its first event could not be read back.");
    return { run: acknowledged.run, ...(warnings.length > 0 && { warnings }) };
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

  steer(runId: string, request: SteerRequest): Promise<AcceptedResponse> {
    return this.keyed("steer", runId, request);
  }

  cancel(runId: string, request: CancelRequest): Promise<AcceptedResponse> {
    return this.keyed("cancel", runId, request);
  }

  /**
   * A steer or cancel under its idempotency key: a repeat returns the first action and delivers
   * nothing; a new key is written (reserved, with the action id) just before delivery, established
   * once the worker accepted, and released when the action was refused or never recorded.
   */
  private async keyed(kind: ControlKind, runId: string, request: SteerRequest | CancelRequest): Promise<AcceptedResponse> {
    const key = request.idempotency_key;
    if (key === undefined) return { action: await this.act(kind, runId, request) };
    return this.keys.exclusive(kind, key, async () => {
      const digest = requestDigest(kind, request, runId);
      const replay = replayAction(this.keys, kind, key, digest);
      if (replay !== null) return replay;
      let reserved: KeyEntry | null = null;
      try {
        const action = await this.act(kind, runId, request, (pending) => {
          reserved = { scope: kind, key, digest, run_id: pending.run_id, state: "reserved", action: pending, recorded_at: pending.requested_at };
          this.keys.put(reserved);
        });
        if (reserved !== null) this.keys.establish(reserved, action);
        return { action };
      } catch (err) {
        const held = reserved as KeyEntry | null;
        if (held?.action) {
          const recorded = actionRecorded(this.options.stateDir, held.run_id, held.action.id);
          if (recorded === null) this.keys.release(kind, key);
          else this.keys.establish(held, { ...held.action, outcome: "accepted" });
        }
        throw err;
      }
    });
  }

  private async act(kind: ControlKind, runId: string, request: SteerRequest | CancelRequest, beforeDeliver?: (action: ActionRecord) => void): Promise<AcceptedResponse["action"]> {
    let run = this.read(runId);
    if (run === null) throw notFound(`No run ${runId}.`, { run_id: runId });
    if (!run.terminal && !run.live_control) {
      // The run's worker may have survived a restart: its reattach attempt comes before the answer.
      const wait = this.options.reattachWaitMs ?? 5000;
      if (!(await this.reattacher.settle(run.id, wait))) {
        throw new ControlError("unavailable", `The core is still reattaching to the worker of run ${run.id}; retry shortly.`, { run_id: run.id, retry_after_ms: 500 });
      }
      run = this.read(runId) ?? run;
    }
    const entry = this.options.catalog.get(run.harness);
    const capabilities = entry ? await entry.capabilities() : null;
    const worker = run.live_control ? (this.controls.get(run.id) ?? null) : null;
    return control(kind, { run, capabilities, worker, now: this.now }, request, beforeDeliver);
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
    const harnesses = await this.documents();
    const agents = buildAgents(this.options.allowlist().entries, scanRuns(this.scan), harnesses);
    return { node: this.options.node, agents, harnesses };
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    return (await this.listAgents()).agents.find((agent) => agent.id === agentId) ?? null;
  }

  listHarnesses(): Promise<Capabilities[]> {
    return this.documents();
  }

  private hostEnv(): NonNullable<RunServiceOptions["env"]> {
    return this.options.env ?? process.env;
  }

  /** Every capability document with this host's limits, active runs and admission. */
  private async documents(): Promise<Capabilities[]> {
    const host: HostReport = { limits: this.options.limits ?? NO_LIMITS, stateDir: this.options.stateDir, env: this.hostEnv(), now: this.now(), ...(this.options.readHeatFile && { readHeatFile: this.options.readHeatFile }) };
    return (await harnessDocuments(this.options.catalog)).map((doc) => withHostReport(doc, host));
  }

  async getHarness(harness: string): Promise<Capabilities | null> {
    const entry = this.options.catalog.get(harness);
    if (!entry) return null;
    return (await this.documents()).find((doc) => doc.harness === harness) ?? entry.capabilities();
  }
}

/** A run service; no I/O until used. Call `reconcile()` once the daemon holds its lock. */
export function createRunService(options: RunServiceOptions): StoreRunService {
  return new StoreRunService(options);
}
