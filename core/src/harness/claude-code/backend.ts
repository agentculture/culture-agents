/**
 * Claude Code through the AI SDK `HarnessAgent`: one session per run, one turn per run. Steer is
 * the adapter's `submitUserMessage` (via `experimental_steerTurn`); interrupt aborts the turn's
 * signal. The agent is created by an injectable factory so the sequencing can be tested without
 * the AI SDK; the real factory is in `agent.ts`.
 */
import { withTimeout } from "../../sandbox/timeout.js";
import { EventQueue, errorMessage } from "../common/queue.js";
import { tapWriter } from "../common/text.js";
import type { HarnessBackend, HarnessSession, Sink, TurnEvent, TurnHandle, TurnOutcome, Workspace } from "../common/types.js";
import { ClaudePartMapper, type StreamPart } from "./map.js";

/** The slice of a `HarnessAgentSession` the backend uses. */
export interface AgentSessionLike {
  experimental_steerTurn(text: string): Promise<void>;
  destroy(): Promise<void>;
}

/** The slice of a `HarnessAgent` the backend uses. */
export interface AgentLike {
  createSession(options: { sessionId: string; abortSignal?: AbortSignal }): Promise<AgentSessionLike>;
  stream(options: { session: AgentSessionLike; prompt: string; abortSignal: AbortSignal }): Promise<{ fullStream: AsyncIterable<StreamPart> }>;
}

export interface AgentFactoryInput<W> {
  workspace: W;
  model: string;
  /** Diagnostics from the bridge (warnings and errors only reach the run log). */
  onLog(level: string, message: string): void;
}

export type AgentFactory<W> = (input: AgentFactoryInput<W>) => AgentLike;

/**
 * Longest closing the adapter's session (its bridge in the sandbox) may take, on the stop path
 * and after a completed turn alike. Past it the run moves on: the bridge is a process in the
 * sandbox, and the process check and the sandbox's deletion deal with what is left.
 */
export const SESSION_CLOSE_TIMEOUT_MS = 15_000;

/** A session id the adapter accepts, derived from the run id. */
export const sessionIdFor = (runId: string) => runId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64);

export class ClaudeCodeBackend<W extends Workspace> implements HarnessBackend<W> {
  constructor(
    private readonly runId: string,
    private readonly model: string,
    private readonly agentFactory: AgentFactory<W>,
    /** Optional file that receives every raw stream part (live-test recording). */
    private readonly tap?: string,
    private readonly closeTimeoutMs: number = SESSION_CLOSE_TIMEOUT_MS,
  ) {}

  async open(workspace: W, signal: AbortSignal, sink: Sink): Promise<HarnessSession> {
    const onLog = (level: string, message: string) => {
      if (level === "warn" || level === "error") {
        sink({ type: "output", data: { channel: "diagnostic", text: `claude-code ${level}: ${message.slice(0, 1000)}` } });
      }
    };
    const agent = this.agentFactory({ workspace, model: this.model, onLog });
    const session = await agent.createSession({ sessionId: sessionIdFor(this.runId), abortSignal: signal });
    let closed: Promise<void> | null = null;
    return {
      startTurn: (task) => startTurn(agent, session, task, tapWriter(this.tap)),
      close: () =>
        (closed ??= withTimeout("closing the Claude Code session", this.closeTimeoutMs, () => session.destroy()).catch((err: unknown) => {
          sink({ type: "output", data: { channel: "diagnostic", text: `claude-code: ${errorMessage(err).slice(0, 500)}` } });
        })),
    };
  }
}

async function startTurn(agent: AgentLike, session: AgentSessionLike, task: string, tap?: (raw: unknown) => void): Promise<TurnHandle> {
  const abort = new AbortController();
  const result = await agent.stream({ session, prompt: task, abortSignal: abort.signal });
  const queue = new EventQueue<TurnEvent>();
  const mapper = new ClaudePartMapper();
  const outcome = (async (): Promise<TurnOutcome> => {
    let out: TurnOutcome;
    try {
      for await (const part of result.fullStream) {
        tap?.(part);
        for (const event of mapper.map(part)) queue.push(event);
      }
      out = mapper.outcome();
    } catch (err) {
      out = abort.signal.aborted
        ? { kind: "interrupted" }
        : { kind: "failed", error: { code: "internal", message: `The Claude Code stream failed: ${errorMessage(err)}`.slice(0, 2000), retryable: false } };
    }
    if (abort.signal.aborted && out.kind !== "interrupted") out = { kind: "interrupted" };
    queue.end();
    return out;
  })();
  return {
    events: queue,
    outcome,
    steer: (text) => session.experimental_steerTurn(text),
    interrupt: async () => abort.abort(new Error("cancelled by the operator")),
  };
}
