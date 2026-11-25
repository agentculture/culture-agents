/**
 * Map OpenCode v2 server events (`GET /api/event`) for one session to normalized turn events.
 * The mapper also keeps the final assistant text (for the run summary) and the last execution
 * error, but it never decides whether the turn ended: the wait and session routes do.
 */
import { stringify } from "../common/text.js";
import type { V2Event } from "./client.js";
import type { TurnEvent } from "../common/types.js";

type OutputData = Extract<TurnEvent, { type: "output" }>["data"];

const str = (v: unknown) => (typeof v === "string" ? v : "");

function toolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return stringify(
    content
      .map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? str((c as { text?: unknown }).text) : "[file]"))
      .join("\n"),
  );
}

function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { type?: unknown; message?: unknown };
    return `${str(e.type) || "error"}: ${str(e.message)}`.slice(0, 1000);
  }
  return stringify(error, 1000);
}

export class OpenCodeEventMapper {
  private readonly toolNames = new Map<string, string>();
  private lastText = "";
  private lastError: string | null = null;

  constructor(private readonly sessionId: string) {}

  /** The last completed assistant text block, or undefined. */
  get summary(): string | undefined {
    return this.lastText || undefined;
  }

  get executionError(): string | null {
    return this.lastError;
  }

  map(event: V2Event): TurnEvent[] {
    const data = event.data ?? {};
    if (data["sessionID"] !== this.sessionId) return [];
    const tool = (id: unknown) => this.toolNames.get(str(id));
    switch (event.type) {
      case "session.text.delta": {
        const text = str(data["delta"]);
        return text ? [out({ channel: "text", text })] : [];
      }
      case "session.text.ended":
        this.lastText = str(data["text"]) || this.lastText;
        return [];
      case "session.reasoning.delta": {
        const text = str(data["delta"]);
        return text ? [out({ channel: "reasoning", text })] : [];
      }
      case "session.tool.input.started":
        this.toolNames.set(str(data["id"]), str(data["name"]).slice(0, 200));
        return [];
      case "session.tool.called":
        return [out(withTool({ channel: "tool_call", text: stringify(data["input"] ?? {}) }, tool(data["id"])))];
      case "session.tool.success":
        return [out(withTool({ channel: "tool_result", text: toolContent(data["content"]) }, tool(data["id"])))];
      case "session.tool.failed":
        return [
          out(withTool({ channel: "tool_result", text: `error: ${errorText(data["error"])}`, extension: { error: true } }, tool(data["id"]))),
        ];
      case "session.step.failed":
        return [err(`step failed: ${errorText(data["error"])}`)];
      case "session.execution.failed":
        this.lastError = errorText(data["error"]);
        return [err(`execution failed: ${this.lastError}`)];
      case "session.inbox.delivered":
        return [out({ channel: "diagnostic", text: "input delivered to the harness" })];
      case "session.retry.scheduled":
        return [out({ channel: "diagnostic", text: "the harness scheduled a model retry" })];
      default:
        return [];
    }
  }
}

function withTool(data: OutputData, tool: string | undefined): OutputData {
  return tool ? { ...data, tool } : data;
}

const out = (data: OutputData): TurnEvent => ({ type: "output", data });
const err = (message: string): TurnEvent => ({ type: "error", error: { code: "internal", message, retryable: false } });
