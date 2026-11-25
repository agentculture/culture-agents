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
    this.auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
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
  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const body = {
      location: { directory: input.directory },
      model: { providerID: input.providerID, id: input.modelID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    };
    return (await this.json<{ data: SessionInfo }>("POST", "/api/session", body)).data;
  }

  /** `POST /api/session/{id}/prompt`; `steer` delivers into the running execution. */
  async prompt(sessionId: string, text: string, delivery?: "steer" | "queue"): Promise<void> {
    const body = delivery ? { text, delivery } : { text };
    await this.call("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, body);
  }

  /** `POST /api/session/{id}/interrupt`; true when an active execution was interrupted. */
  async interrupt(sessionId: string): Promise<boolean> {
    const res = await this.json<{ interrupted: boolean }>("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`);
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
  async *events(signal: AbortSignal): AsyncGenerator<V2Event> {
    const res = await this.call("GET", "/api/event", undefined, signal);
    if (!res.body) return;
    yield* parseSse(res.body, signal);
  }
}

/** Parse a `text/event-stream` body into JSON `data` payloads. */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<V2Event> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut).replace(/^\r?\n\r?\n/, "");
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        try {
          const event = JSON.parse(data) as V2Event;
          if (event && typeof event.type === "string") yield event;
        } catch {
          // A malformed payload is skipped; the stream is best-effort by design.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
