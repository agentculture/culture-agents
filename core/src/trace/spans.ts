/**
 * The spans of one run, derived from its event log and record. Pure: no clock, no I/O.
 *
 * - `agents.run` (root): first event to terminal state.
 * - `run.submit`: the accepted submit (the first event; zero length, the log has no earlier time).
 * - `sandbox.setup`: queued until the harness session starts (`running`).
 * - `harness.turn`: `running` until the last non-state event before the terminal state.
 * - `tool.call`: a `tool_call` output until the matching `tool_result` (or the next event).
 * - `operator.question`: a `run.question` until its `run.answer` (or the terminal state).
 * - `result.collection`: the end of the turn until the terminal state (collection writes no event of its own).
 * - `run.terminal`: the terminal state, zero length.
 *
 * `at` is the cursor of the event that completes a span; a span is exported once the log has reached it.
 * Content (prompt, tool input and output, question text) is read only when `content` is true.
 */
import { isTerminal, type Run, type RunEvent, type RunState } from "../contract/index.js";

export type Attr = string | number | boolean;
export interface Span {
  name: string;
  /** Stable key, unique within the run. */
  key: string;
  parent: string | null;
  start: string;
  end: string;
  at: number;
  attrs: Record<string, Attr>;
}

const ms = (iso: string): number => Date.parse(iso);

type Make = (name: string, key: string, start: string, end: string, at: number, extra?: Record<string, Attr>) => Span;
interface OpenTool {
  event: RunEvent;
  tool: string | null;
}

/** What the spans of one run are built with, and the spans built so far, in order. */
interface Builder {
  make: Make;
  content: boolean;
  spans: Span[];
}

/** Where the walk over the log stands. */
interface Walk {
  running: RunEvent | null;
  terminal: RunEvent | null;
  lastWork: RunEvent | null;
  openTools: OpenTool[];
  openQuestions: Map<string, RunEvent>;
}

function spanMaker(run: Run, model: string): Make {
  const base: Record<string, Attr> = { "culture.run_id": run.id, "culture.harness": run.harness, "culture.model": model, "gen_ai.request.model": model };
  return (name, key, start, end, at, extra = {}) => ({
    name,
    key,
    parent: key === "root" ? null : "root",
    start,
    end,
    at,
    attrs: { ...base, "culture.duration_ms": Math.max(0, ms(end) - ms(start)), ...extra },
  });
}

function closeTool(b: Builder, open: OpenTool, end: RunEvent): void {
  const extra: Record<string, Attr> = {};
  if (open.tool !== null) extra["culture.tool"] = open.tool;
  if (b.content) {
    const input = (open.event.data as { text?: string }).text;
    if (input !== undefined) extra["culture.tool.input"] = input;
    if (end.kind === "run.output" && (end.data as { channel?: string }).channel === "tool_result") extra["culture.tool.output"] = (end.data as { text: string }).text;
  }
  b.spans.push(b.make("tool.call", `tool.${open.event.cursor}`, open.event.time, end.time, end.cursor, extra));
}

function questionSpan(b: Builder, asked: RunEvent, end: RunEvent): Span {
  const q = (asked.data as { question: { kind: string; text: string } }).question;
  const extra: Record<string, Attr> = { "culture.question.kind": q.kind };
  if (b.content) extra["culture.question.text"] = q.text;
  return b.make("operator.question", `question.${asked.cursor}`, asked.time, end.time, end.cursor, extra);
}

/** A state event: the first `running` ends the sandbox setup; a terminal state ends the run. */
function onState(b: Builder, walk: Walk, first: RunEvent, event: RunEvent): void {
  const to = (event.data as { to: RunState }).to;
  if (to === "running" && walk.running === null) {
    walk.running = event;
    b.spans.push(b.make("sandbox.setup", "sandbox", first.time, event.time, event.cursor));
  }
  if (isTerminal(to)) walk.terminal = event;
}

/** Any other event before the terminal state: it ends the open tool calls, and may open a tool call or a question or answer one. */
function onWork(b: Builder, walk: Walk, event: RunEvent): void {
  walk.lastWork = event;
  for (const open of walk.openTools.splice(0)) closeTool(b, open, event);
  if (event.kind === "run.output") {
    const data = event.data as { channel: string; tool?: string };
    if (data.channel === "tool_call") walk.openTools.push({ event, tool: data.tool ?? null });
  } else if (event.kind === "run.question") {
    const q = (event.data as { question: { id: string; kind: string; text: string } }).question;
    walk.openQuestions.set(q.id, event);
  } else if (event.kind === "run.answer") {
    const id = (event.data as { question_id: string }).question_id;
    const asked = walk.openQuestions.get(id);
    if (asked) {
      walk.openQuestions.delete(id);
      b.spans.push(questionSpan(b, asked, event));
    }
  }
}

/** The spans the terminal state `end` completes. */
function onTerminal(b: Builder, walk: Walk, run: Run, first: RunEvent, end: RunEvent): void {
  const state = (end.data as { to: RunState }).to;
  for (const open of walk.openTools) closeTool(b, open, end);
  for (const asked of walk.openQuestions.values()) b.spans.push(questionSpan(b, asked, end));
  if (walk.running !== null) {
    const turnEnd = walk.lastWork ?? walk.running;
    b.spans.push(b.make("harness.turn", "turn", walk.running.time, turnEnd.time, end.cursor), b.make("result.collection", "collection", turnEnd.time, end.time, end.cursor));
  }
  b.spans.push(b.make("run.terminal", "terminal", end.time, end.time, end.cursor, { "culture.state": state }));
  const rootExtra: Record<string, Attr> = { "culture.state": state, "culture.agent_id": run.agent_id };
  if (b.content) rootExtra["culture.prompt"] = run.task;
  b.spans.push(b.make("agents.run", "root", first.time, end.time, end.cursor, rootExtra));
}

export function buildSpans(run: Run, events: readonly RunEvent[], model: string, content: boolean): Span[] {
  if (events.length === 0) return [];
  const first = events[0] as RunEvent;
  const make = spanMaker(run, model);
  const b: Builder = { make, content, spans: [make("run.submit", "submit", first.time, first.time, first.cursor)] };
  const walk: Walk = { running: null, terminal: null, lastWork: null, openTools: [], openQuestions: new Map() };
  for (const event of events) {
    if (event.kind === "run.state") {
      onState(b, walk, first, event);
      continue;
    }
    if (walk.terminal !== null) break;
    onWork(b, walk, event);
  }
  if (walk.terminal !== null) onTerminal(b, walk, run, first, walk.terminal);
  return b.spans;
}
