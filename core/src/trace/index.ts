/** Exporting run traces to a local Langfuse over OTLP. Off unless an endpoint is configured. See `follower.ts`. */
import { loadHarnessConfig } from "../harness/index.js";
import { TRACE_ENDPOINT_ENV, loadTraceConfig, type TraceConfig } from "./config.js";
import { createTraceFollower, type TraceFollower } from "./follower.js";

export { TRACE_CONTENT_ENV, TRACE_ENDPOINT_ENV, TRACE_ENV_PREFIX, TRACE_PUBLIC_KEY_ENV, TRACE_SECRET_KEY_ENV, TraceConfigError, loadTraceConfig, workerEnv } from "./config.js";
export type { TraceConfig } from "./config.js";
export { TRACED_FILE, createTraceFollower } from "./follower.js";
export type { TraceFollower, TraceFollowerOptions } from "./follower.js";
export { buildSpans } from "./spans.js";
export type { Span } from "./spans.js";

export interface StartTracingOptions {
  stateDir: string;
  node: string;
  /** Read once; every trace variable is removed from it. */
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** The configuration `prepareTrace` read at start; when given, `env` is not read again. */
  config?: TraceConfig | null;
}

/** Read the trace configuration and remove its variables from `env`; null when off or unusable (logged). Never throws. */
export function prepareTrace(env: Record<string, string | undefined>, log: (line: string) => void): TraceConfig | null {
  try {
    return loadTraceConfig(env);
  } catch (err) {
    log(`culture-agents core: run traces are not exported: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Start exporting when an endpoint is configured; null otherwise or when the configuration cannot be used. Never throws, never waits for the receiver. */
export function startTracing(options: StartTracingOptions): TraceFollower | null {
  try {
    const config = options.config !== undefined ? options.config : loadTraceConfig(options.env);
    if (config === null) return null;
    let models: Record<string, string> = {};
    try {
      const h = loadHarnessConfig(options.env);
      models = { "claude-code": h.claudeCode.model, opencode: h.opencode.model };
    } catch {
      // models stay unknown
    }
    const follower = createTraceFollower({ stateDir: options.stateDir, node: options.node, url: config.url, authorization: config.authorization, content: config.content, modelOf: (harness) => models[harness] ?? "unknown", warn: options.log });
    follower.start();
    options.log(`culture-agents core: exporting run traces to ${new URL(config.url).origin} (${TRACE_ENDPOINT_ENV}); content ${config.content ? "on" : "off"}.`);
    return follower;
  } catch (err) {
    options.log(`culture-agents core: run traces are not exported: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
