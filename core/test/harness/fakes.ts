/** Scripted workspace and harness backend for the run-driver sequencing tests. */
import { EventQueue } from "../../src/harness/common/queue.js";
import type {
  Collected,
  HarnessBackend,
  HarnessSession,
  Proc,
  TurnEvent,
  TurnHandle,
  TurnOutcome,
  Workspace,
  WorkspaceFactory,
} from "../../src/harness/common/types.js";

export type FailAt = "open" | "processes" | "backend" | "turn" | "commit" | "collect" | "destroy" | null;

export class FakeWorkspace implements Workspace {
  readonly workdir = "/sandbox/work";
  readonly calls: string[] = [];
  destroyed = 0;
  /** Process lists returned in order by `processes()` (the last repeats). */
  procLists: Proc[][] = [[{ pid: 1, ppid: 0, args: "init" }]];
  killed: number[] = [];
  /** When set, every listing after the baseline fails with this message. */
  procFailure: string | null = null;
  /** When true, the workspace can be kept after a failed commit or collect (a sandbox); false models the stub. */
  retainable = false;
  /** Overridable texts, for the tests of long messages. */
  failureText: string | null = null;
  recoverText = "openshell sandbox ssh-config t-abc123, then git fetch runs/x";
  kept = 0;

  constructor(private readonly failAt: FailAt) {}

  async processes(): Promise<Proc[]> {
    this.calls.push("processes");
    if (this.failAt === "processes") throw new Error("ps failed");
    if (this.procFailure !== null && this.calls.filter((c) => c === "processes").length > 1) throw new Error(this.procFailure);
    const list = this.procLists.length > 1 ? this.procLists.shift() : this.procLists[0];
    return (list ?? []).filter((p) => !this.killed.includes(p.pid));
  }

  async kill(pids: readonly number[]): Promise<void> {
    this.calls.push(`kill ${pids.join(",")}`);
    this.killed.push(...pids);
  }

  async commitAll(): Promise<number> {
    this.calls.push("commit");
    if (this.failAt === "commit") throw new Error(this.failureText ?? "commit failed");
    return 1;
  }

  async collect(): Promise<Collected | null> {
    this.calls.push("collect");
    if (this.failAt === "collect") throw new Error("fetch failed");
    return { branch: "runs/x", commit: "abc", commits: 1, shas: ["abc"] };
  }

  retention(): { sandbox: string; recover: string } | null {
    return this.retainable ? { sandbox: "t-abc123", recover: this.recoverText } : null;
  }

  async keep(): Promise<void> {
    this.calls.push("keep");
    this.kept += 1;
  }

  async destroy(): Promise<void> {
    this.calls.push("destroy");
    this.destroyed += 1;
    if (this.failAt === "destroy") throw new Error("delete failed");
  }
}

export class FakeFactory implements WorkspaceFactory<FakeWorkspace> {
  workspace: FakeWorkspace | null = null;
  constructor(
    private readonly failAt: FailAt,
    private readonly retainable = false,
  ) {}
  async open(signal: AbortSignal): Promise<FakeWorkspace> {
    if (this.failAt === "open") throw new Error("gateway unreachable");
    signal.throwIfAborted();
    this.workspace = new FakeWorkspace(this.failAt);
    this.workspace.retainable = this.retainable;
    return this.workspace;
  }
}

/** A turn the test drives by hand. */
export class ManualTurn implements TurnHandle {
  readonly queue = new EventQueue<TurnEvent>();
  readonly steers: string[] = [];
  interrupts = 0;
  private resolveOutcome!: (o: TurnOutcome) => void;
  readonly outcome = new Promise<TurnOutcome>((resolve) => (this.resolveOutcome = resolve));
  /** When true, interrupt ends the turn as interrupted at once. */
  interruptEnds = true;

  get events(): AsyncIterable<TurnEvent> {
    return this.queue;
  }

  emit(text: string, channel: "text" | "tool_call" | "tool_result" = "text"): void {
    this.queue.push({ type: "output", data: { channel, text } });
  }

  end(outcome: TurnOutcome): void {
    this.queue.end();
    this.resolveOutcome(outcome);
  }

  async steer(text: string): Promise<void> {
    this.steers.push(text);
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    if (this.interruptEnds) this.end({ kind: "interrupted" });
  }
}

export class FakeBackend implements HarnessBackend<FakeWorkspace> {
  readonly turn = new ManualTurn();
  closed = 0;
  opened = false;
  private onTurn!: () => void;
  /** Resolves once the turn has started. */
  readonly turnStarted = new Promise<void>((resolve) => (this.onTurn = resolve));

  constructor(private readonly failAt: FailAt) {}

  async open(_w: FakeWorkspace, signal: AbortSignal): Promise<HarnessSession> {
    if (this.failAt === "backend") throw new Error("bridge did not start");
    signal.throwIfAborted();
    this.opened = true;
    return {
      startTurn: async () => {
        if (this.failAt === "turn") throw new Error("prompt refused");
        this.onTurn();
        return this.turn;
      },
      close: async () => {
        this.closed += 1;
      },
    };
  }
}
