import type {
  AcceptedResponse,
  Agent,
  AgentList,
  Capabilities,
  CancelRequest,
  EventPage,
  Run,
  RunEvent,
  RunResult,
  RunState,
  SteerRequest,
  SubmitRequest,
} from "../contract/index.js";

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
 *   control routes, and the always-refused routes (pause, resume, answer).
 * - `submit` receives a request that already passed the allow-list, with `repo` canonicalized
 *   (realpath). It performs steps 4 to 7 of the submit order (harness known and available,
 *   capabilities, busy, create session and run, start the worker).
 * - `steer` and `cancel` perform steps 5 to 9 of the control order (capability, state, live
 *   control, delivery) and return the accepted action record.
 */
export interface RunService {
  /** Create a run and its worker; resolves once the run is durable, in state `queued`. */
  submit(request: SubmitRequest): Promise<Run>;
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
  steer(runId: string, request: SteerRequest): Promise<AcceptedResponse["action"]>;
  cancel(runId: string, request: CancelRequest): Promise<AcceptedResponse["action"]>;
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
