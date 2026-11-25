/**
 * A minimal client for the OpenCode v2 server API (`opencode serve`, OpenCode 2.3.2), over
 * `fetch`. Routes and shapes are from the server's own `/openapi.json`. Requests use HTTP basic
 * auth with user `opencode` and the per-process password.
 */

/** The parts of `Session.Info` the driver reads. */
export interface SessionInfo {
  id: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: { created: number; updated: number; busy?: number; idle?: number };
}

/** One event from `GET /api/event` (the server's `V2Event`). */
export interface V2Event {
  id?: string;
  type: string;
  data?: Record<string, unknown>;
}

export class OpenCodeApiError extends Error {
  override readonly name = "OpenCodeApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Largest single unit read from the sandbox's OpenCode server before it is dropped: one event
 * block of the stream here, one line of the server's output in `lines.ts`. About 1 MiB.
 */
export const MAX_STREAM_UNIT = 1 << 20;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CreateSessionInput {
  directory: string;
  providerID: string;
  modelID: string;
}

export class OpenCodeClient {
  private readonly auth: string;

  constructor(
    private readonly baseUrl: string,
    password: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {
    const credentials = Buffer.from(`opencode:${password}`).toString("base64");
    this.auth = `Basic ${credentials}`;
  }

  private async call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const init: RequestInit = { method, headers: { authorization: this.auth, accept: "application/json" } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    if (signal) init.signal = signal;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 500);
      throw new OpenCodeApiError(res.status, `${method} ${path} returned ${res.status}: ${text}`);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.call(method, path, body, signal);
    return (await res.json()) as T;
  }

  /** `POST /api/session` at `directory` with the model, and allow-all permissions (as Claude Code runs). */
  async createSession(input: CreateSessionInput, signal?: AbortSignal): Promise<SessionInfo> {
    const body = {
      location: { directory: input.directory },
      model: { providerID: input.providerID, id: input.modelID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    };
    return (await this.json<{ data: SessionInfo }>("POST", "/api/session", body, signal)).data;
  }

  /** `POST /api/session/{id}/prompt`; `steer` delivers into the running execution. */
  async prompt(sessionId: string, text: string, delivery?: "steer" | "queue", signal?: AbortSignal): Promise<void> {
    const body = delivery ? { text, delivery } : { text };
    await this.call("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, body, signal);
  }

  /** `POST /api/session/{id}/interrupt`; true when an active execution was interrupted. */
  async interrupt(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await this.json<{ interrupted: boolean }>("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`, undefined, signal);
    return res.interrupted;
  }

  /** `POST /api/experimental/session/{id}/wait`: resolves when the session's loop is idle. */
  async wait(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.call("POST", `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, undefined, signal);
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<SessionInfo> {
    return (await this.json<{ data: SessionInfo }>("GET", `/api/session/${encodeURIComponent(sessionId)}`, undefined, signal)).data;
  }

  /** `GET /api/session/active`: ids of sessions with a running loop in this server. */
  async activeSessions(signal?: AbortSignal): Promise<Set<string>> {
    const res = await this.json<{ data: Record<string, unknown> }>("GET", "/api/session/active", undefined, signal);
    return new Set(Object.keys(res.data));
  }

  /**
   * `GET /api/event` as parsed events, for as long as the connection lasts. The stream is
   * volatile (events during a disconnect are lost), so callers never take it as the authority
   * on whether a turn ended.
   */
  async *events(signal: AbortSignal, onDropped?: () => void): AsyncGenerator<V2Event> {
    const res = await this.call("GET", "/api/event", undefined, signal);
    if (!res.body) return;
    yield* parseSse(res.body, signal, onDropped);
  }
}

const BLOCK_SEPARATOR = /\r?\n\r?\n/;
const LEADING_SEPARATOR = /^\r?\n\r?\n/;

/** The text of an event stream, cut into blocks at blank lines, with the cap on a block's size. */
class SseBlocks {
  private buf = "";
  /** Inside a block that went over the cap: discard up to its blank line. */
  private skipping = false;

  constructor(private readonly maxBlock: number) {}

  /** Add decoded text. False while the text is still inside a block that is being discarded. */
  add(text: string): boolean {
    this.buf += text;
    if (!this.skipping) return true;
    const end = this.buf.search(BLOCK_SEPARATOR);
    if (end < 0) {
      this.buf = this.buf.slice(-3); // a separator may be split across reads
      return false;
    }
    this.buf = this.buf.slice(end).replace(LEADING_SEPARATOR, "");
    this.skipping = false;
    return true;
  }

  /** The next complete block, or null when none is buffered. */
  take(): string | null {
    const cut = this.buf.search(BLOCK_SEPARATOR);
    if (cut < 0) return null;
    const block = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut).replace(LEADING_SEPARATOR, "");
    return block;
  }

  /** Whether the unfinished block is over the cap; if so, it is discarded from here on. */
  overflowed(): boolean {
    if (this.buf.length <= this.maxBlock) return false;
    this.buf = this.buf.slice(-3);
    this.skipping = true;
    return true;
  }
}

/** The event in one block, or null. A block over the cap or whose payload is not JSON is reported through `onDropped`. */
function parseBlock(block: string, maxBlock: number, onDropped?: () => void): V2Event | null {
  if (block.length > maxBlock) {
    onDropped?.();
    return null;
  }
  const data = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return null;
  try {
    const event = JSON.parse(data) as V2Event;
    return event && typeof event.type === "string" ? event : null;
  } catch {
    // A payload that is not JSON is skipped (the stream is best-effort), but not silently.
    onDropped?.();
    return null;
  }
}

/**
 * Parse a `text/event-stream` body into JSON `data` payloads. The server is inside the sandbox,
 * so the buffer is capped: an event block over `maxBlock` characters is dropped whole, reported
 * through `onDropped` (once per block, like a payload that is not JSON), and parsing goes on with
 * the next block.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal, onDropped?: () => void, maxBlock: number = MAX_STREAM_UNIT): AsyncGenerator<V2Event> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const blocks = new SseBlocks(maxBlock);
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) return;
      if (!blocks.add(decoder.decode(value, { stream: true }))) continue;
      for (let block = blocks.take(); block !== null; block = blocks.take()) {
        const event = parseBlock(block, maxBlock, onDropped);
        if (event) yield event;
      }
      if (blocks.overflowed()) onDropped?.();
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
