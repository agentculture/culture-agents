/**
 * A fake OpenCode v2 server (the routes the driver uses), so the turn logic can be tested for
 * what matters: completion comes from the wait and session routes, not the volatile stream.
 */
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

  constructor(readonly password = "pw") {}

  async listen(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const s of this.streams) s.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Push an event to every connected stream. */
  emit(type: string, data: Record<string, unknown> = {}): void {
    const event: V2Event = { id: `evt_${Math.random()}`, type, data: { sessionID: this.sessionId, ...data } };
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const expected = `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
    if (req.headers.authorization !== expected) return this.json(res, 401, { _tag: "UnauthorizedError", message: "no" });
    const url = req.url ?? "";
    const id = this.sessionId;
    if (req.method === "GET" && url === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`);
      this.streams.add(res);
      req.on("close", () => this.streams.delete(res));
      return;
    }
    if (req.method === "POST" && url === "/api/session") {
      await this.body(req);
      return this.json(res, 200, { data: { id, time: { created: 1, updated: 1 } } });
    }
    if (req.method === "GET" && url === `/api/session/${id}`) {
      const time: Record<string, number> = { created: 1, updated: 2 };
      if (this.idle !== undefined) time["idle"] = this.idle;
      return this.json(res, 200, { data: { id, time, ...(this.outcome ? { outcome: this.outcome } : {}) } });
    }
    if (req.method === "GET" && url === "/api/session/active") return this.json(res, 200, { data: this.busy ? { [id]: {} } : {} });
    if (req.method === "POST" && url === `/api/session/${id}/prompt`) {
      const body = (await this.body(req)) as { text: string; delivery?: string };
      this.prompts.push(body);
      if (!body.delivery) {
        this.busy = true;
        this.outcome = undefined;
      }
      return this.json(res, 200, { data: { id: "inb_1" } });
    }
    if (req.method === "POST" && url === `/api/experimental/session/${id}/wait`) {
      if (!this.busy && this.prompts.length > 0) {
        res.writeHead(204);
        return void res.end();
      }
      this.waiters.push(() => {
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (req.method === "POST" && url === `/api/session/${id}/interrupt`) {
      this.interrupts += 1;
      const was = this.busy;
      if (was) this.finish("interrupted");
      return this.json(res, 200, { interrupted: was });
    }
    this.json(res, 404, { _tag: "NotFound", message: url });
  }
}
