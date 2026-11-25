/**
 * A fake OpenCode v2 server (the routes the driver uses), so the turn logic can be tested for
 * what matters: completion comes from the wait and session routes, not the volatile stream.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { V2Event } from "../../src/harness/opencode/client.js";

export class FakeOpenCode {
  readonly prompts: { text: string; delivery?: string }[] = [];
  interrupts = 0;
  busy = false;
  outcome: "succeeded" | "failed" | "interrupted" | undefined;
  idle: number | undefined = undefined;
  private readonly streams = new Set<ServerResponse>();
  private readonly waiters: (() => void)[] = [];
  private server: Server | null = null;
  readonly sessionId = "ses_fake1";
  /** Routes that accept the request and never answer (a stalled server). */
  readonly stalled = new Set<"create" | "session" | "prompt">();

  constructor(readonly password = "pw") {}

  async listen(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const s of this.streams) s.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Push an event to every connected stream. */
  emit(type: string, data: Record<string, unknown> = {}): void {
    const event: V2Event = { id: `evt_${randomUUID()}`, type, data: { sessionID: this.sessionId, ...data } };
    for (const s of this.streams) s.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  /** Drop every event stream connection (the client must reconnect). */
  dropStreams(): void {
    for (const s of this.streams) s.destroy();
    this.streams.clear();
  }

  get connections(): number {
    return this.streams.size;
  }

  /** End the execution: idle with an outcome; releases pending waits. */
  finish(outcome: "succeeded" | "failed" | "interrupted"): void {
    this.busy = false;
    this.outcome = outcome;
    this.idle = Date.now() + 1;
    for (const w of this.waiters.splice(0)) w();
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }

  private authorized(req: IncomingMessage): boolean {
    const credentials = Buffer.from(`opencode:${this.password}`).toString("base64");
    return req.headers.authorization === `Basic ${credentials}`;
  }

  private openStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`);
    this.streams.add(res);
    req.on("close", () => this.streams.delete(res));
  }

  private async createSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.body(req);
    if (this.stalled.has("create")) return;
    this.json(res, 200, { data: { id: this.sessionId, time: { created: 1, updated: 1 } } });
  }

  private readSession(res: ServerResponse): void {
    if (this.stalled.has("session")) return;
    const time: Record<string, number> = { created: 1, updated: 2 };
    if (this.idle !== undefined) time["idle"] = this.idle;
    this.json(res, 200, { data: { id: this.sessionId, time, ...(this.outcome ? { outcome: this.outcome } : {}) } });
  }

  private async prompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.body(req)) as { text: string; delivery?: string };
    if (this.stalled.has("prompt")) return;
    this.prompts.push(body);
    if (!body.delivery) {
      this.busy = true;
      this.outcome = undefined;
    }
    this.json(res, 200, { data: { id: "inb_1" } });
  }

  private wait(res: ServerResponse): void {
    const answer = (): void => {
      res.writeHead(204);
      res.end();
    };
    if (!this.busy && this.prompts.length > 0) answer();
    else this.waiters.push(answer);
  }

  private interrupt(res: ServerResponse): void {
    this.interrupts += 1;
    const was = this.busy;
    if (was) this.finish("interrupted");
    this.json(res, 200, { interrupted: was });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) return this.json(res, 401, { _tag: "UnauthorizedError", message: "no" });
    const url = req.url ?? "";
    const id = this.sessionId;
    switch (`${req.method ?? ""} ${url}`) {
      case "GET /api/event":
        return this.openStream(req, res);
      case "POST /api/session":
        return this.createSession(req, res);
      case `GET /api/session/${id}`:
        return this.readSession(res);
      case "GET /api/session/active":
        return this.json(res, 200, { data: this.busy ? { [id]: {} } : {} });
      case `POST /api/session/${id}/prompt`:
        return this.prompt(req, res);
      case `POST /api/experimental/session/${id}/wait`:
        return this.wait(res);
      case `POST /api/session/${id}/interrupt`:
        return this.interrupt(res);
      default:
        return this.json(res, 404, { _tag: "NotFound", message: url });
    }
  }
}
