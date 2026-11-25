/**
 * Map AI SDK stream parts (as the Claude Code adapter emits them through `HarnessAgent.stream`)
 * to normalized turn events, and decide the turn's outcome from the parts seen. Parts are read
 * structurally, so no AI SDK type crosses into the rest of core.
 */
import { label, stringify } from "../common/text.js";
import type { TurnEvent, TurnOutcome } from "../common/types.js";

/** The fields of a stream part this mapper reads. */
export interface StreamPart {
  type: string;
  text?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  finishReason?: unknown;
  stepNumber?: unknown;
}

/**
 * Finish reasons that mean the turn ended normally. The harness layer's unified set is `stop`,
 * `length`, `content-filter`, `tool-calls`, `error`, `interrupted`, `other`
 * (`harnessV1FinishReasonSchema` in @ai-sdk/harness 1.0.192). The Claude Code adapter (1.0.196)
 * ends every turn that did not raise a terminal error with `stop`, including a turn whose last
 * steps ran tools; it uses `tool-calls` only on a `finish-step` that waits for host input, never
 * on the turn's `finish`. So `stop` is the whole set, and every other reason is an unfinished turn.
 */
export const COMPLETED_FINISH_REASONS: ReadonlySet<string> = new Set(["stop"]);

const UNFINISHED: Readonly<Record<string, string>> = {
  length: "the model's output limit cut the turn off",
  "content-filter": "a content filter stopped the turn",
  "tool-calls": "the turn ended waiting on tool calls that did not run",
  interrupted: "the model stream ended without a completion signal",
};

/** The finish reason as a string, from the flattened form or the harness layer's `{ unified }`. */
function finishReasonOf(value: unknown): string {
  if (typeof value === "string" && value !== "") return value.slice(0, 100);
  const unified = value !== null && typeof value === "object" ? (value as { unified?: unknown }).unified : undefined;
  return typeof unified === "string" && unified !== "" ? unified.slice(0, 100) : "unknown";
}

/** The step number as text; `?` when the part carries none. */
const stepLabel = (step: unknown): string => (step === undefined || step === null ? "?" : label(step));

/** Why a turn that did not complete ended, from its finish reason. */
function unfinishedReason(finishReason: string | null): string {
  if (finishReason === null) return "the stream ended without a finish part";
  const meaning = UNFINISHED[finishReason];
  return meaning ? `finish reason ${finishReason} (${meaning})` : `finish reason ${finishReason}`;
}

const toolName = (part: StreamPart) => (typeof part.toolName === "string" && part.toolName !== "" ? part.toolName.slice(0, 200) : undefined);

export class ClaudePartMapper {
  private currentText = "";
  private lastText = "";
  private finishReason: string | null = null;
  private aborted = false;
  private readonly errors: string[] = [];

  map(part: StreamPart): TurnEvent[] {
    switch (part.type) {
      case "text-start":
        this.currentText = "";
        return [];
      case "text-delta": {
        const text = typeof part.text === "string" ? part.text : "";
        this.currentText += text;
        this.lastText = this.currentText;
        return text ? [{ type: "output", data: { channel: "text", text } }] : [];
      }
      case "reasoning-delta": {
        const text = typeof part.text === "string" ? part.text : "";
        return text ? [{ type: "output", data: { channel: "reasoning", text } }] : [];
      }
      case "tool-call":
        return [{ type: "output", data: withTool({ channel: "tool_call", text: stringify(part.input ?? {}) }, toolName(part)) }];
      case "tool-result":
        return [{ type: "output", data: withTool({ channel: "tool_result", text: stringify(part.output ?? "") }, toolName(part)) }];
      case "tool-error":
        return [
          {
            type: "output",
            data: withTool({ channel: "tool_result", text: `error: ${stringify(part.error)}`, extension: { error: true } }, toolName(part)),
          },
        ];
      case "tool-approval-request":
        return [error("The harness asked for a tool approval; operator questions are not supported in D1.")];
      case "steering-message":
        return [{ type: "output", data: { channel: "diagnostic", text: `steer delivered to the harness (step ${stepLabel(part.stepNumber)})` } }];
      case "error": {
        const message = stringify(part.error, 1000);
        this.errors.push(message);
        return [error(`harness error: ${message}`)];
      }
      case "abort":
        this.aborted = true;
        return [];
      case "finish":
        this.finishReason = finishReasonOf(part.finishReason);
        return [];
      default:
        return [];
    }
  }

  outcome(): TurnOutcome {
    if (this.aborted) return { kind: "interrupted" };
    if (this.finishReason !== null && COMPLETED_FINISH_REASONS.has(this.finishReason)) {
      return this.lastText ? { kind: "completed", summary: this.lastText } : { kind: "completed" };
    }
    // A turn that did not finish normally is not committed or collected as a success.
    const reason = unfinishedReason(this.finishReason);
    const why = this.errors.length > 0 ? `${reason}; ${this.errors.join("; ")}` : reason;
    return { kind: "failed", error: { code: "internal", message: `The Claude Code turn failed: ${why}`.slice(0, 2000), retryable: false } };
  }
}

type OutputData = Extract<TurnEvent, { type: "output" }>["data"];

function withTool(data: OutputData, tool: string | undefined): OutputData {
  return tool === undefined ? data : { ...data, tool };
}

function error(message: string): TurnEvent {
  return { type: "error", error: { code: "internal", message, retryable: false } };
}
