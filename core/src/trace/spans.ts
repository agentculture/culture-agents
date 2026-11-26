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

export function buildSpans(run: Run, events: readonly RunEvent[], model: string, content: boolean): Span[] {
  if (events.length === 0) return [];
  const first = events[0] as RunEvent;
  const base: Record<string, Attr> = { "culture.run_id": run.id, "culture.harness": run.harness, "culture.model": model, "gen_ai.request.model": model };
  const make = (name: string, key: string, start: string, end: string, at: number, extra: Record<string, Attr> = {}): Span => ({
    name,
    key,
    parent: key === "root" ? null : "root",
    start,
    end,
    at,
    attrs: { ...base, "culture.duration_ms": Math.max(0, ms(end) - ms(start)), ...extra },
  });
  const spans: Span[] = [make("run.submit", "submit", first.time, first.time, first.cursor)];
  let running: RunEvent | null = null;
  let terminal: RunEvent | null = null;
  let lastWork: RunEvent | null = null;
  const openTools: { event: RunEvent; tool: string | null }[] = [];
  const openQuestions = new Map<string, RunEvent>();
  const closeTool = (open: { event: RunEvent; tool: string | null }, end: RunEvent): void => {
    const extra: Record<string, Attr> = {};
    if (open.tool !== null) extra["culture.tool"] = open.tool;
    if (content) {
      const input = (open.event.data as { text?: string }).text;
      if (input !== undefined) extra["culture.tool.input"] = input;
      if (end.kind === "run.output" && (end.data as { channel?: string }).channel === "tool_result") extra["culture.tool.output"] = (end.data as { text: string }).text;
    }
    spans.push(make("tool.call", `tool.${open.event.cursor}`, open.event.time, end.time, end.cursor, extra));
  };
  for (const event of events) {
    if (event.kind === "run.state") {
      const to = (event.data as { to: RunState }).to;
      if (to === "running" && running === null) {
        running = event;
        spans.push(make("sandbox.setup", "sandbox", first.time, event.time, event.cursor));
      }
      if (isTerminal(to)) terminal = event;
      continue;
    }
    if (terminal !== null) break;
    lastWork = event;
    for (const open of openTools.splice(0)) closeTool(open, event);
    if (event.kind === "run.output") {
      const data = event.data as { channel: string; tool?: string };
      if (data.channel === "tool_call") openTools.push({ event, tool: data.tool ?? null });
    } else if (event.kind === "run.question") {
      const q = (event.data as { question: { id: string; kind: string; text: string } }).question;
      openQuestions.set(q.id, event);
    } else if (event.kind === "run.answer") {
      const id = (event.data as { question_id: string }).question_id;
      const asked = openQuestions.get(id);
      if (asked) {
        openQuestions.delete(id);
        spans.push(questionSpan(asked, event));
      }
    }
  }
  function questionSpan(asked: RunEvent, end: RunEvent): Span {
    const q = (asked.data as { question: { kind: string; text: string } }).question;
    const extra: Record<string, Attr> = { "culture.question.kind": q.kind };
    if (content) extra["culture.question.text"] = q.text;
    return make("operator.question", `question.${asked.cursor}`, asked.time, end.time, end.cursor, extra);
  }
  if (terminal === null) return spans;
  const end = terminal;
  const state = (end.data as { to: RunState }).to;
  for (const open of openTools) closeTool(open, end);
  for (const asked of openQuestions.values()) spans.push(questionSpan(asked, end));
  if (running !== null) {
    const turnEnd = lastWork ?? running;
    spans.push(make("harness.turn", "turn", running.time, turnEnd.time, end.cursor));
    spans.push(make("result.collection", "collection", turnEnd.time, end.time, end.cursor));
  }
  spans.push(make("run.terminal", "terminal", end.time, end.time, end.cursor, { "culture.state": state }));
  const rootExtra: Record<string, Attr> = { "culture.state": state, "culture.agent_id": run.agent_id };
  if (content) rootExtra["culture.prompt"] = run.task;
  spans.push(make("agents.run", "root", first.time, end.time, end.cursor, rootExtra));
  return spans;
}
