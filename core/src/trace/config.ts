/**
 * Where run traces go. Tracing is off unless `CULTURE_AGENTS_TRACE_ENDPOINT` is set.
 *
 * The endpoint is Langfuse's OpenTelemetry base, for a local Langfuse
 * `http://localhost:3000/api/public/otel`; the core posts to `<endpoint>/v1/traces`. Basic auth is
 * the Langfuse project's public and secret key. The keys are read once, at start, by `loadTraceConfig`
 * and then removed from the core's own environment, so no worker it starts can inherit them
 * (`workerEnv` in the spawn path removes every `CULTURE_AGENTS_TRACE_` variable as well).
 * `CULTURE_AGENTS_TRACE_CONTENT=1` puts prompt text, harness output and tool input and output on spans; it is off by default.
 */
export const TRACE_ENV_PREFIX = "CULTURE_AGENTS_TRACE_";
export const TRACE_ENDPOINT_ENV = "CULTURE_AGENTS_TRACE_ENDPOINT";
export const TRACE_PUBLIC_KEY_ENV = "CULTURE_AGENTS_TRACE_PUBLIC_KEY";
export const TRACE_SECRET_KEY_ENV = "CULTURE_AGENTS_TRACE_SECRET_KEY";
export const TRACE_CONTENT_ENV = "CULTURE_AGENTS_TRACE_CONTENT";

export interface TraceConfig {
  /** Full URL spans are posted to. */
  url: string;
  /** Value of the Authorization header, or null when no keys are set. */
  authorization: string | null;
  content: boolean;
}

export class TraceConfigError extends Error {
  override readonly name = "TraceConfigError";
}

type Env = Record<string, string | undefined>;

/** Traces go to a Langfuse on this host only, the same rule as the events broker. */
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** The trace configuration, or null when tracing is off. Removes the trace variables from `env`. */
export function loadTraceConfig(env: Env = process.env): TraceConfig | null {
  const endpoint = env[TRACE_ENDPOINT_ENV]?.trim();
  const pub = env[TRACE_PUBLIC_KEY_ENV]?.trim();
  const second = env[TRACE_SECRET_KEY_ENV]?.trim();
  const content = ["1", "true", "yes", "on"].includes((env[TRACE_CONTENT_ENV] ?? "").trim().toLowerCase());
  for (const key of Object.keys(env).filter((k) => k.startsWith(TRACE_ENV_PREFIX))) Reflect.deleteProperty(env, key);
  if (endpoint === undefined || endpoint === "") return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TraceConfigError(`${TRACE_ENDPOINT_ENV} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TraceConfigError(`${TRACE_ENDPOINT_ENV} must be an http or https URL`);
  const host = url.hostname.toLowerCase();
  if (!(host === "localhost" || host === "[::1]" || LOOPBACK_V4.test(host))) {
    throw new TraceConfigError(`${TRACE_ENDPOINT_ENV} must name a loopback address: traces stay on this host`);
  }
  if (url.username !== "" || url.password !== "") throw new TraceConfigError(`${TRACE_ENDPOINT_ENV} must not hold a user name or password; use the key variables`);
  if ((pub === undefined) !== (second === undefined)) throw new TraceConfigError("set both the public and the secret trace key, or neither");
  url.pathname = `${withoutTrailingSlashes(url.pathname)}/v1/traces`;
  return { url: url.toString(), authorization: basicAuthorization(pub, second), content };
}

/** `path` without its trailing slashes; one pass from the end, no regular expression to backtrack. */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  return path.slice(0, end);
}

/** The Basic Authorization header value for the two trace keys, or null unless both are set. */
function basicAuthorization(pub: string | undefined, second: string | undefined): string | null {
  if (pub === undefined || second === undefined) return null;
  const credentials = Buffer.from(`${pub}:${second}`).toString("base64");
  return `Basic ${credentials}`;
}

/** A copy of `env` without any trace variable: what a worker is started with. */
export function workerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith(TRACE_ENV_PREFIX)));
}
