/**
 * Support for publish tests: run logs written through the real `EventLogWriter` (so every line is
 * a contract event), a transport that records what it was asked to publish, and the markers a
 * lifecycle-only message must never carry.
 */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import type { Run } from "../../src/contract/index.js";
import type { BrokerTransport } from "../../src/publish/index.js";
import { EventLogWriter, type EventInput } from "../../src/store/event-log.js";
import { createRun } from "../../src/store/run-store.js";
import { AGENT, action, newRun, stateDir } from "../worker/helpers.js";

export const SOURCE = "app://culture-agents/thor";

/** Text that stands for run content. None of it may appear in any published message. */
export const MARKERS = {
  prompt: "MARKER-PROMPT-7f3a refactor the billing module",
  output: "MARKER-OUTPUT-55d1 here is the plan",
  reasoning: "MARKER-REASONING-90aa thinking about it",
  toolCall: "MARKER-TOOLCALL-c4e2 cat /etc/hostname",
  toolResult: "MARKER-TOOLRESULT-1d77 token=hunter2",
  question: "MARKER-QUESTION-8e10 which database?",
  choice: "MARKER-CHOICE-3c3c postgres",
  answer: "MARKER-ANSWER-a1b2 use the staging one",
  error: "MARKER-ERROR-6f6f connection refused by the gateway",
  reason: "MARKER-REASON-4d4d operator asked",
} as const;

export interface Seeded {
  stateDir: string;
  run: Run;
  dir: string;
  writer: EventLogWriter;
}

/** A run directory with event 1 (`null` -> `queued`) in its log. The writer stays open for more appends. */
export function seedRun(t: TestContext, into?: string, overrides: Partial<Run> = {}): Seeded {
  const state = into ?? stateDir(t);
  const run = newRun(overrides);
  const dir = createRun(state, run);
  const writer = EventLogWriter.open(dir, run.id);
  writer.transition("queued", null, true);
  return { stateDir: state, run, dir, writer };
}

/**
 * A whole run whose record and events carry every marker: the prompt, text, reasoning, a tool call and its result, a question with a choice, its answer, an error and a
 * state reason. Every event kind of the contract appears. Ends `failed`.
 */
export function contentRun(t: TestContext, into?: string): Seeded {
  const seeded = seedRun(t, into, { task: MARKERS.prompt });
  const { run, writer } = seeded;
  const loose = (input: unknown): void => {
    writer.append(input as EventInput);
  };
  const questionId = `${AGENT}.qst.01JDQ5X0000000000000000001`;
  writer.transition("running", null);
  loose({ kind: "run.output", data: { channel: "text", text: MARKERS.output } });
  loose({ kind: "run.output", data: { channel: "reasoning", text: MARKERS.reasoning } });
  loose({ kind: "run.output", data: { channel: "tool_call", text: MARKERS.toolCall } });
  loose({ kind: "run.output", data: { channel: "tool_result", text: MARKERS.toolResult } });
  loose({ kind: "run.control", data: { action: action(run, "steer") } });
  loose({
    kind: "run.refused",
    data: { action: { ...action(run, "pause", "refused"), error: { code: "unsupported", message: MARKERS.error, retryable: false, capability: "pause" } } },
  });
  loose({
    kind: "run.question",
    data: {
      question: {
        id: questionId,
        kind: "question",
        text: MARKERS.question,
        choices: [{ id: "a", label: MARKERS.choice }],
        free_text: true,
        multiple: false,
        answer_by: "2099-01-01T00:00:00Z",
      },
    },
  });
  loose({ kind: "run.answer", data: { question_id: questionId, action: action(run, "answer"), choice_ids: ["a"], answer: MARKERS.answer } });
  loose({ kind: "run.error", data: { error: { code: "unavailable", message: MARKERS.error, retryable: true }, fatal: true } });
  writer.transition("failed", MARKERS.reason);
  writer.close();
  return seeded;
}

export interface Sent {
  topic: string;
  payload: string;
}

/** Records every publish. While `down`, a publish rejects at once, as the real transport does without a connection. */
export class FakeTransport implements BrokerTransport {
  readonly sent: Sent[] = [];
  down = false;
  /** Called before each publish is acknowledged (a test can stop a publisher mid-way here). */
  onPublish: ((sent: Sent) => void | Promise<void>) | null = null;
  closed = false;

  async publish(topic: string, payload: string): Promise<void> {
    if (this.down) throw new Error("the broker is not connected");
    const sent = { topic, payload };
    await this.onPublish?.(sent);
    this.sent.push(sent);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  envelopes(): Envelope[] {
    return this.sent.map((s) => JSON.parse(s.payload) as Envelope);
  }
}

export interface Envelope {
  id: string;
  type: string;
  source: string;
  time: string;
  schemaVersion: string;
  runId: string;
  data: { run_id: string; kind: string; state: string; cursor: number };
}

/** No marker text, and no fragment of one, is in `text`. */
export function assertNoContent(text: string): void {
  for (const [name, marker] of Object.entries(MARKERS)) {
    assert.ok(!text.includes(marker), `the ${name} text was published`);
    assert.ok(!text.includes(marker.split(" ")[0] as string), `the ${name} marker was published`);
  }
}
