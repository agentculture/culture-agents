import type {
  AcceptedResponse,
  Agent,
  AgentList,
  AnswerRequest,
  Capabilities,
  CancelRequest,
  ErrorBody,
  EventPage,
  PauseRequest,
  ResumeRequest,
  Run,
  RunEvent,
  RunResult,
  RunState,
  SteerRequest,
  SubmitRequest,
  SubmitResponse,
} from "../contract/index.js";

/** The control actions deferred beyond this API version: always refused with `unsupported` (step 4). */
export type DeferredKind = "pause" | "resume" | "answer";
export type DeferredRequest = PauseRequest | ResumeRequest | AnswerRequest;

/**
 * The port the HTTP server depends on. Run logic (store, worker, harness, sandbox) implements it
 * elsewhere; the server knows nothing else. Only contract types cross this boundary.
 *
 * Error convention: an implementation reports every contract refusal by throwing `ControlError`
 * (errors.ts), for example `not_found`, `busy`, `unsupported`, `conflict`, `unavailable`. Any other
 * exception becomes `internal`. A "missing" lookup returns `null` where the signature says so.
 *
 * Who checks what (contract/README.md, order of checks):
 * - The server checks, before calling the service: the version header, path-id formats, request
 *   bodies against their schemas, a submit's deadline and the allow-list, run existence for
 *   control routes, and the always-refused routes (pause, resume, answer). It decides that refusal
 *   itself (step 4) and hands it to `recordRefusal`, because only the run logic can write a run's log.
 * - `submit` receives a request that already passed the allow-list, with `repo` canonicalized
 *   (realpath). It performs steps 4 to 8 of the submit order (harness known and available,
 *   capabilities, idempotency key, busy, write the key, create session and run, start the worker).
 * - `steer` and `cancel` perform steps 5 to 9 of the control order (capability, state, live
 *   control, delivery) and return the accepted action record.
 */
export interface RunService {
  /**
   * Create a run and its worker; resolves once the run is durable, in state `queued`. A repeated
   * idempotency key resolves to the first run with `replayed: true` and creates nothing.
   */
  submit(request: SubmitRequest): Promise<SubmitResponse>;
  listRuns(query: RunListQuery): Promise<Run[]>;
  /** `null` when the id is well-formed but unknown. */
  getRun(runId: string): Promise<Run | null>;
  /** A page of stored events with cursor > `after`, oldest first; `null` when the run is unknown. */
  readEvents(runId: string, after: number, limit: number): Promise<EventPage | null>;
  /**
   * Replay every event with cursor > `after` in ascending order, then follow live events with no gap
   * and no duplicate. The iterable ends after the terminal `run.state` event, or immediately when the
   * run is already terminal and `after` equals its cursor. Must stop promptly when `signal` aborts.
   */
  streamEvents(runId: string, after: number, signal: AbortSignal): AsyncIterable<RunEvent>;
  /** Outcome of a terminal run; throws `conflict` (retryable) while the run is active. */
  getResult(runId: string): Promise<RunResult>;
  /** The accepted action; a repeated idempotency key resolves to the first action with `replayed: true`. */
  steer(runId: string, request: SteerRequest): Promise<AcceptedResponse>;
  cancel(runId: string, request: CancelRequest): Promise<AcceptedResponse>;
  /**
   * Record a refusal the server decided at step 4 (a deferred action) as `run.refused` in the run's
   * event log, when the run is not terminal and this core controls its worker; otherwise do
   * nothing. The caller gets the refusal whatever happens here, so a failure to record is not an error.
   */
  recordRefusal(runId: string, kind: DeferredKind, request: DeferredRequest, error: ErrorBody): Promise<void>;
  listAgents(): Promise<AgentList>;
  getAgent(agentId: string): Promise<Agent | null>;
  listHarnesses(): Promise<Capabilities[]>;
  getHarness(harness: string): Promise<Capabilities | null>;
}

export interface RunListQuery {
  state?: RunState;
  agent_id?: string;
  /** 1 to 500; the server always supplies it (default 50). */
  limit: number;
}
