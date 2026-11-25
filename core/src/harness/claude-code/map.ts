/**
 * Map AI SDK stream parts (as the Claude Code adapter emits them through `HarnessAgent.stream`)
 * to normalized turn events, and decide the turn's outcome from the parts seen. Parts are read
 * structurally, so no AI SDK type crosses into the rest of core.
 */
import { stringify } from "../common/text.js";
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
        return [{ type: "output", data: { channel: "diagnostic", text: `steer delivered to the harness (step ${String(part.stepNumber ?? "?")})` } }];
      case "error": {
        const message = stringify(part.error, 1000);
        this.errors.push(message);
        return [error(`harness error: ${message}`)];
      }
      case "abort":
        this.aborted = true;
        return [];
      case "finish":
        this.finishReason = typeof part.finishReason === "string" ? part.finishReason : "unknown";
        return [];
      default:
        return [];
    }
  }

  outcome(): TurnOutcome {
    if (this.aborted) return { kind: "interrupted" };
    if (this.finishReason !== null && this.finishReason !== "error") {
      return this.lastText ? { kind: "completed", summary: this.lastText } : { kind: "completed" };
    }
    const why = this.errors.length > 0 ? this.errors.join("; ") : "the stream ended without a finish part";
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
