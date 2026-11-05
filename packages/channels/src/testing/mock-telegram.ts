// A local stand-in for api.telegram.org. Test-only. Tokens used with it are fake.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface TelegramRequest { path: string; body: any }
type Reply = { status: number; json: unknown };

export class MockTelegram {
  readonly requests: TelegramRequest[] = [];
  /** Queued answers, used first-in first-out; when empty every request succeeds. */
  replies: Reply[] = [];
  private nextId = 1000;
  private server!: Server;
  url = "";

  ok(result: unknown = { message_id: this.nextId++ }): Reply { return { status: 200, json: { ok: true, result } }; }
  fail(status: number, description: string, parameters?: unknown): Reply { return { status, json: { ok: false, error_code: status, description, parameters } }; }
  /** Texts sent through sendMessage, in order. */
  get texts(): string[] { return this.requests.filter((r) => r.path.endsWith("/sendMessage")).map((r) => r.body.text); }
  reset(): void { this.requests.length = 0; this.replies = []; }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      this.requests.push({ path: req.url ?? "", body: text ? JSON.parse(text) : undefined });
      const reply = this.replies.shift() ?? this.ok();
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.json));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop(): Promise<void> { return new Promise((r) => { this.server.closeAllConnections(); this.server.close(() => r()); }); }
}
