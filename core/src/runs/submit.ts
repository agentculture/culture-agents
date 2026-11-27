/**
 * Steps of a submit that the run service (service.ts) takes in order: the harness and capability
 * checks (contract/README.md, steps 4 and 5), the new run's record, and the worker start of step 8.
 * The order of the side effects stays in `StoreRunService.submitNow`: the key, then the run
 * directory, then the worker.
 */
import { buildSessionId, newUlid, parseMeshId, type Run, type RunId, type SubmitRequest, type Submitter } from "../contract/index.js";
import { notFound, unavailable, unsupported } from "../daemon/errors.js";
import { settleKey, type KeyEntry, type KeyIndex } from "../store/idempotency.js";
import { WorkerSpawnError, spawnWorker, type SpawnedWorker, type SpawnWorkerOptions } from "../worker/spawn.js";
import type { SubmitFault } from "./keys.js";
import type { HarnessCatalog, HarnessEntry } from "./ports.js";
import type { RunServiceOptions } from "./service.js";

/** Steps 4 and 5: the harness is known, then available, then the request asks only for what this core supports. */
export async function submittableHarness(catalog: HarnessCatalog, node: string, request: SubmitRequest): Promise<HarnessEntry> {
  // Step 4: harness known, then available.
  const entry = catalog.get(request.harness);
  if (!entry) throw notFound(`No harness ${request.harness} is known to this core.`);
  const capabilities = await entry.capabilities();
  if (!capabilities.available) throw unavailable(`The ${request.harness} harness is not available on this core; check its binary, credentials and sandbox with agents doctor.`);
  // Step 5: capabilities, in contract order.
  if (parseMeshId(request.agent_id)?.node !== node) {
    throw unsupported("placement", `Agent ${request.agent_id} is not on this core's node ${node}; multi-host placement is not supported.`);
  }
  if (request.session_id !== undefined) throw unsupported("continue_session", "Continuing a session is not supported in this API version.");
  if (request.parent_run_id !== undefined) throw unsupported("delegate", "Delegating from a parent run is not supported in this API version.");
  return entry;
}

/** The record of a new run `run`, queued at `created`, before anything of it is on disk. */
export function newRunRecord(run: RunId, request: SubmitRequest, submitter: Submitter | undefined, created: Date, baseCommit: NonNullable<Run["base_commit"]>): Run {
  return {
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
}

type WorkerSettings = NonNullable<RunServiceOptions["worker"]>;

/** The worker settings the service was given, as spawn options (unset ones left out). */
function workerSettings(w: WorkerSettings): Partial<SpawnWorkerOptions> {
  return {
    ...(w.heartbeatMs !== undefined && { heartbeatMs: w.heartbeatMs }),
    ...(w.cancelGraceMs !== undefined && { cancelGraceMs: w.cancelGraceMs }),
    ...(w.readyTimeoutMs !== undefined && { readyTimeoutMs: w.readyTimeoutMs }),
    ...(w.questionLimitMs !== undefined && { questionLimitMs: w.questionLimitMs }),
    ...(w.steerTimeoutMs !== undefined && { steerTimeoutMs: w.steerTimeoutMs }),
    ...(w.env !== undefined && { env: w.env }),
  };
}

export interface StartWorkerOptions {
  stateDir: string;
  record: Run;
  entry: HarnessEntry;
  worker: WorkerSettings;
  fault: SubmitFault;
  keys: KeyIndex;
  /** The submit's reserved key, or null without one. */
  reserved: KeyEntry | null;
}

/**
 * Step 8: create the run directory and start its worker. When that fails, the reserved key is
 * settled (a run that reached event 1 keeps it; otherwise it is released) and a worker that did
 * not start is `unavailable`.
 */
export async function startWorker(o: StartWorkerOptions): Promise<SpawnedWorker> {
  try {
    return await spawnWorker({
      stateDir: o.stateDir,
      run: o.record,
      driver: { module: o.entry.driver.module, options: o.entry.driver.options },
      ...workerSettings(o.worker),
      onCreated: () => o.fault("after-run-dir"),
    });
  } catch (err) {
    // A run that reached event 1 keeps its key; otherwise the key is released.
    if (o.reserved !== null) settleKey(o.keys, o.reserved);
    if (err instanceof WorkerSpawnError) throw unavailable(`The run's worker could not be started: ${err.message}`);
    throw err;
  }
}
