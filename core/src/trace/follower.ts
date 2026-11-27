/**
 * The follower that exports run traces. Like the broker publisher it belongs to the core, reads the
 * run logs after their append, keeps its own position per run on disk (`traced.json`: the highest
 * span cursor sent) and never makes a request or a worker wait: a receiver that is down costs
 * lateness only, and after a restart the follower goes on from the recorded cursor.
 *
 * It also sends, per harness and model, a `fleet.active_runs` span counting the runs the store
 * reports active (the same count the capability report states), whenever the split changes.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isTerminal } from "../contract/index.js";
import { readLog } from "../store/event-log.js";
import { activeRunList } from "../store/entries.js";
import { atomicWriteJson, nowIso, runDir, runFile } from "../store/files.js";
import { listRunIds, readRecord } from "../store/run-store.js";
import { payloadFor, postSpans, traceIdOf, type ExportSpan } from "./otlp.js";
import { buildSpans, type Span } from "./spans.js";

export const TRACED_FILE = "traced.json";

export interface TraceFollowerOptions {
  stateDir: string;
  node: string;
  url: string;
  authorization: string | null;
  content: boolean;
  /** The model a harness runs, for span attributes. */
  modelOf: (harness: string) => string;
  warn: (line: string) => void;
  pollMs?: number;
  retryMs?: number;
  send?: (body: string) => Promise<void>;
}

export interface TraceFollower {
  start(): void;
  pass(): Promise<number>;
  stop(): Promise<void>;
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";

function readTraced(dir: string): number {
  try {
    const v = (JSON.parse(readFileSync(join(dir, TRACED_FILE), "utf8")) as { cursor?: unknown }).cursor;
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
  } catch {
    return 0;
  }
}

export function createTraceFollower(o: TraceFollowerOptions): TraceFollower {
  const send = o.send ?? ((body: string) => postSpans(o.url, o.authorization, body));
  const cursors = new Map<string, number>();
  const finished = new Set<string>();
  const sizes = new Map<string, number>();
  const bad = new Set<string>();
  let lastFleet = "";
  let up: boolean | null = null;
  let stopped = false;
  let loop: Promise<void> | null = null;
  const abort = new AbortController();

  async function deliver(spans: ExportSpan[]): Promise<boolean> {
    try {
      await send(payloadFor(spans, o.node));
      if (up === false) o.warn("culture-agents core: the trace receiver takes spans again.");
      up = true;
      return true;
    } catch (err) {
      if (up !== false && !stopped) o.warn(`culture-agents core: the trace receiver is not taking spans (${reasonOf(err)}); runs are not affected and spans are sent when it is back.`);
      up = false;
      return false;
    }
  }

  async function traceRun(runId: string): Promise<{ count: number; refused: boolean }> {
    const dir = runDir(o.stateDir, runId);
    const done = cursors.get(runId) ?? readTraced(dir);
    let size = 0;
    try {
      size = statSync(runFile(dir, "events")).size;
    } catch {
      return { count: 0, refused: false };
    }
    if (sizes.get(runId) === size && cursors.has(runId)) return { count: 0, refused: false };
    const log = readLog(dir, runId);
    const run = readRecord(dir);
    const state = log.tail.state;
    const spans = buildSpans(run, log.events, o.modelOf(run.harness), o.content).filter((s: Span) => s.at > done);
    if (spans.length > 0) {
      const traceId = traceIdOf(runId);
      if (!(await deliver(spans.map((span) => ({ traceId, runId, span }))))) return { count: 0, refused: true };
      const cursor = Math.max(...spans.map((s) => s.at));
      cursors.set(runId, cursor);
      try {
        atomicWriteJson(join(dir, TRACED_FILE), { cursor });
      } catch (err) {
        o.warn(`culture-agents core: cannot record how far run ${runId} is traced (${reasonOf(err)}); after a restart its spans are sent again with the same ids.`);
      }
    } else cursors.set(runId, done);
    sizes.set(runId, size);
    if (state !== null && isTerminal(state)) finished.add(runId);
    return { count: spans.length, refused: false };
  }

  async function fleet(): Promise<void> {
    const counts = new Map<string, { harness: string; model: string; n: number }>();
    for (const run of activeRunList(o.stateDir)) {
      const model = o.modelOf(run.harness);
      const k = `${run.harness}\u0000${model}`;
      const c = counts.get(k) ?? { harness: run.harness, model, n: 0 };
      c.n += 1;
      counts.set(k, c);
    }
    const signature = JSON.stringify([...counts.keys()].sort((a, b) => a.localeCompare(b)).map((k) => [k, counts.get(k)?.n]));
    if (signature === lastFleet) return;
    const now = nowIso();
    const spans: ExportSpan[] = [...counts.values()].map((c) => ({
      traceId: traceIdOf(`fleet:${o.node}`),
      runId: `fleet:${o.node}:${now}:${c.harness}:${c.model}`,
      span: {
        name: "fleet.active_runs",
        key: "gauge",
        parent: null,
        start: now,
        end: now,
        at: 0,
        attrs: { "culture.harness": c.harness, "culture.model": c.model, "culture.active_runs": c.n },
      },
    }));
    if (spans.length === 0) {
      lastFleet = signature;
      return;
    }
    if (await deliver(spans)) lastFleet = signature;
  }

  async function pass(): Promise<number> {
    let total = 0;
    for (const runId of listRunIds(o.stateDir)) {
      if (stopped) break;
      if (finished.has(runId) || bad.has(runId)) continue;
      try {
        const r = await traceRun(runId);
        total += r.count;
        if (r.refused) return total;
      } catch (err) {
        bad.add(runId);
        o.warn(`culture-agents core: run ${runId} is not traced past this point: ${reasonOf(err)}. Its log is unchanged.`);
      }
    }
    if (!stopped) await fleet().catch(() => undefined);
    return total;
  }

  /** How long to sleep after a round that sent the spans of `count` events. */
  function waitAfter(count: number): number {
    if (up === false) return o.retryMs ?? 1000;
    return count > 0 ? 0 : (o.pollMs ?? 250);
  }

  /** One round of `follow`: a pass, then the sleep before the next one (none once stopped). */
  async function round(): Promise<void> {
    let count = 0;
    try {
      count = await pass();
    } catch (err) {
      o.warn(`culture-agents core: exporting traces failed for this round: ${reasonOf(err)}`);
    }
    if (stopped) return;
    await delay(waitAfter(count), undefined, { signal: abort.signal }).catch(() => undefined);
  }

  /** Rounds one after the other until `stop`; each round starts when the one before has finished. */
  function follow(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const next = (): void => {
        if (stopped) return resolve();
        round().then(next, reject);
      };
      next();
    });
  }

  return {
    start(): void {
      loop ??= follow();
    },
    pass,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      abort.abort();
      if (loop) {
        const limit = new AbortController();
        await Promise.race([loop, delay(1000, undefined, { signal: limit.signal }).catch(() => undefined)]);
        limit.abort();
      }
    },
  };
}
