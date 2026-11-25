/**
 * A deterministic in-process stand-in for a harness. It reads a tiny task language, so the same
 * contract-level tests can drive it as a real harness:
 *
 *   files: a.txt, b.txt   write these files one at a time (content: the name), then finish
 *   fail: <message>       end the turn as failed
 *   hang                  run until interrupted
 *
 * A steer whose text contains `files: ...` replaces the files not yet written; any other steer
 * is acknowledged as a diagnostic. Interrupt stops before the next step.
 */
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { again, finish, stepUntil } from "../../util/sequence.js";
import { EventQueue } from "../common/queue.js";
import type { HarnessBackend, HarnessSession, TurnEvent, TurnHandle, TurnOutcome, Workspace } from "../common/types.js";

export interface StubBehaviour {
  /** Delay before each step. Default 150 ms. */
  stepMs?: number;
}

export function parseFiles(text: string): string[] | null {
  const m = /files:\s*([^\n]+)/i.exec(text);
  if (!m) return null;
  return (m[1] as string)
    .split(",")
    .map((f) => basename(f.trim()))
    .filter((f) => f !== "" && f !== "." && f !== "..");
}

/** True when one line of the task holds only `hang`, in any letter case, with any space around it. */
const hasHangLine = (task: string): boolean => task.split(/[\n\r\u2028\u2029]/).some((line) => /^hang$/i.test(line.trim()));

class StubTurn {
  readonly queue = new EventQueue<TurnEvent>();
  private readonly abort = new AbortController();
  private pending: string[] = [];
  private readonly written: string[] = [];

  constructor(
    private readonly workdir: string,
    private readonly stepMs: number,
  ) {}

  private out(channel: "text" | "tool_call" | "tool_result" | "diagnostic", text: string, tool?: string): void {
    this.queue.push({ type: "output", data: tool ? { channel, text, tool } : { channel, text } });
  }

  /** Play `task` to its outcome. Called once, right after construction. */
  async play(task: string): Promise<TurnOutcome> {
    const outcome = await this.steps(task);
    this.queue.end();
    return outcome;
  }

  private async steps(task: string): Promise<TurnOutcome> {
    const signal = this.abort.signal;
    this.out("text", `stub: ${task.split("\n")[0]?.slice(0, 200) ?? ""}`);
    const fail = /fail:\s*([^\n]+)/i.exec(task);
    if (fail) return { kind: "failed", error: { code: "internal", message: `stub failure: ${fail[1] as string}`, retryable: false } };
    if (hasHangLine(task)) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { kind: "interrupted" };
    }
    this.pending = parseFiles(task) ?? [];
    const interrupted = (): TurnOutcome => ({ kind: "interrupted" });
    let waited = false;
    // Each write follows its own pause, and the pending list is read afresh every time: a steer
    // may have replaced it during the pause. An interrupt ends the pause and the turn.
    return stepUntil<TurnOutcome>(
      async () => {
        if (waited) await this.writeNext();
        if (this.pending.length > 0) {
          waited = true;
          return again(this.stepMs);
        }
        return finish(signal.aborted ? interrupted() : this.completed());
      },
      { signal, onAbort: interrupted },
    );
  }

  private async writeNext(): Promise<void> {
    const name = this.pending.shift() as string;
    this.out("tool_call", JSON.stringify({ file_path: name }), "write");
    await writeFile(join(this.workdir, name), `${name}\n`);
    this.written.push(name);
    this.out("tool_result", `wrote ${name}`, "write");
  }

  private completed(): TurnOutcome {
    const summary = `stub wrote ${this.written.length} file(s): ${this.written.join(", ") || "none"}`;
    this.out("text", summary);
    return { kind: "completed", summary };
  }

  steer(text: string): void {
    const files = parseFiles(text);
    if (files) this.pending = files;
    this.out("diagnostic", files ? `steer: now writing ${files.join(", ")}` : `steer acknowledged: ${text.slice(0, 200)}`);
  }

  interrupt(): void {
    this.abort.abort();
  }

  get ended(): boolean {
    return this.queue.isEnded;
  }
}

export class StubBackend implements HarnessBackend<Workspace> {
  constructor(private readonly behaviour: StubBehaviour = {}) {}

  async open(workspace: Workspace, signal: AbortSignal): Promise<HarnessSession> {
    signal.throwIfAborted();
    let turn: StubTurn | null = null;
    return {
      startTurn: async (task): Promise<TurnHandle> => {
        const t = new StubTurn(workspace.workdir, this.behaviour.stepMs ?? 150);
        const outcome = t.play(task);
        turn = t;
        return {
          events: t.queue,
          outcome,
          steer: async (text) => {
            if (t.ended) throw new Error("The stub turn has ended.");
            t.steer(text);
          },
          interrupt: async () => t.interrupt(),
        };
      },
      close: async () => turn?.interrupt(),
    };
  }
}
