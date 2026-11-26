import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isTerminal,
  type AcceptedResponse,
  type AnswerRequest,
  type Agent,
  type AgentList,
  type CancelRequest,
  type Capabilities,
  type ErrorBody,
  type EventPage,
  type Run,
  type RunEvent,
  type RunResult,
  type StateData,
  type SteerRequest,
  type SubmitRequest,
  type SubmitResponse,
} from "../../src/contract/index.js";
import { ControlError, notFound } from "../../src/daemon/errors.js";
import type { DeferredKind, DeferredRequest, RunListQuery, RunService } from "../../src/daemon/ports.js";

// dist/test/daemon -> repo root is four levels up.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contract", "fixtures");

export const fixture = <T>(path: string): T => JSON.parse(readFileSync(join(FIXTURES, path), "utf8")) as T;
export const stream = (name: string): RunEvent[] =>
  readFileSync(join(FIXTURES, "streams", "valid", name), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RunEvent);

/** In-memory `RunService` for daemon tests. It records every call so tests can prove what was (not) reached. */
export class FakeRunService implements RunService {
  readonly calls: string[] = [];
  readonly submitted: SubmitRequest[] = [];
  /** Every refusal the server asked this service to record. */
  readonly refusals: { runId: string; kind: DeferredKind; caller: DeferredRequest["caller"]; error: ErrorBody }[] = [];
  private readonly runs = new Map<string, Run>();
  private readonly logs = new Map<string, RunEvent[]>();
  private readonly wake = new Set<() => void>();

  /** Register a run with its full or partial event log (the run's state and cursor follow the log). */
  seed(run: Run, events: RunEvent[]): void {
    this.runs.set(run.id, { ...run });
    this.logs.set(run.id, []);
    for (const e of events) this.append(e);
  }

  /** Append the next event and wake live followers. */
  append(event: RunEvent): void {
    const log = this.logs.get(event.run_id);
    const run = this.runs.get(event.run_id);
    if (!log || !run) throw new Error("seed the run first");
    log.push(event);
    run.cursor = event.cursor;
    if (event.kind === "run.state") {
      const to = (event.data as StateData).to;
      run.state = to;
      run.terminal = isTerminal(to);
      run.updated_at = event.time;
      if (to !== "queued" && run.started_at === null) run.started_at = event.time;
      if (run.terminal) {
        run.live_control = false;
        run.ended_at = event.time;
      }
    }
    for (const w of this.wake) w();
  }

  submit(request: SubmitRequest): Promise<SubmitResponse> {
    this.calls.push("submit");
    this.submitted.push(request);
    const base = fixture<Run>("valid/run/root.queued.json");
    return Promise.resolve({ run: { ...base, agent_id: request.agent_id, harness: request.harness, repo: request.repo, task: request.task, owner: request.caller } });
  }

  listRuns(query: RunListQuery): Promise<Run[]> {
    this.calls.push("listRuns");
    const all = [...this.runs.values()].filter((r) => (!query.state || r.state === query.state) && (!query.agent_id || r.agent_id === query.agent_id));
    return Promise.resolve(all.slice(0, query.limit));
  }

  getRun(runId: string): Promise<Run | null> {
    this.calls.push("getRun");
    return Promise.resolve(this.runs.get(runId) ?? null);
  }

  readEvents(runId: string, after: number, limit: number): Promise<EventPage | null> {
    this.calls.push("readEvents");
    const log = this.logs.get(runId);
    const run = this.runs.get(runId);
    if (!log || !run) return Promise.resolve(null);
    const rest = log.filter((e) => e.cursor > after);
    return Promise.resolve({ run_id: runId, events: rest.slice(0, limit), last_cursor: run.cursor, more: rest.length > limit });
  }

  async *streamEvents(runId: string, after: number, signal: AbortSignal): AsyncIterable<RunEvent> {
    this.calls.push("streamEvents");
    const log = this.logs.get(runId);
    if (!log) return;
    let sent = after;
    for (;;) {
      for (const e of log.filter((x) => x.cursor > sent)) {
        sent = e.cursor;
        yield e;
        if (e.kind === "run.state" && isTerminal((e.data as StateData).to)) return;
      }
      if (this.runs.get(runId)?.terminal) return;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.wake.delete(done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        this.wake.add(done);
        signal.addEventListener("abort", done, { once: true });
      });
      if (signal.aborted) return;
    }
  }

  getResult(runId: string): Promise<RunResult> {
    this.calls.push("getResult");
    const run = this.runs.get(runId);
    if (!run) return Promise.reject(notFound("no run", { run_id: runId }));
    if (!run.terminal) return Promise.reject(new ControlError("conflict", "The run is still active.", { run_id: runId, retryable: true }));
    return Promise.resolve({ ...fixture<RunResult>("valid/run/run_result.succeeded.json"), run_id: runId });
  }

  steer(runId: string, request: SteerRequest): Promise<AcceptedResponse> {
    this.calls.push("steer");
    return Promise.resolve({ action: { ...fixture<AcceptedResponse>("valid/control-action/accepted_response.steer.json").action, run_id: runId, caller: request.caller } });
  }

  cancel(runId: string, request: CancelRequest): Promise<AcceptedResponse> {
    this.calls.push("cancel");
    return Promise.resolve({ action: { ...fixture<AcceptedResponse>("valid/control-action/accepted_response.cancel.json").action, run_id: runId, caller: request.caller } });
  }

  answer(runId: string, request: AnswerRequest): Promise<AcceptedResponse> {
    this.calls.push("answer");
    return Promise.resolve({ action: { ...fixture<AcceptedResponse>("valid/control-action/accepted_response.answer.json").action, run_id: runId, caller: request.caller } });
  }

  recordRefusal(runId: string, kind: DeferredKind, request: DeferredRequest, error: ErrorBody): Promise<void> {
    this.calls.push("recordRefusal");
    this.refusals.push({ runId, kind, caller: request.caller, error });
    return Promise.resolve();
  }

  listAgents(): Promise<AgentList> {
    this.calls.push("listAgents");
    return Promise.resolve(fixture<AgentList>("valid/agent/agent_list.two-agents.json"));
  }

  getAgent(agentId: string): Promise<Agent | null> {
    this.calls.push("getAgent");
    const agent = fixture<Agent>("valid/agent/root.idle.json");
    return Promise.resolve(agent.id === agentId ? agent : null);
  }

  listHarnesses(): Promise<Capabilities[]> {
    this.calls.push("listHarnesses");
    return Promise.resolve(fixture<{ harnesses: Capabilities[] }>("valid/capabilities/capabilities_list.two.json").harnesses);
  }

  getHarness(harness: string): Promise<Capabilities | null> {
    this.calls.push("getHarness");
    const doc = fixture<Capabilities>("valid/capabilities/root.claude-code.json");
    return Promise.resolve(doc.harness === harness ? doc : null);
  }
}
