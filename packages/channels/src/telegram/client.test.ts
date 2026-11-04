import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import { Secret } from "@relay/shared";
import {
  TelegramAdapter, TelegramApiError, TelegramAuthError, TelegramBlockedError, TelegramNetworkError, TelegramRateLimitError,
} from "./index.js";

// A local stand-in for api.telegram.org. The token below is fake. No test touches the real service.
const FAKE_TOKEN = "123456:FAKE-TOKEN-MARKER";
interface Recorded { path: string; body: any }
type Reply = { status: number; json: unknown };

let server: Server;
let baseUrl: string;
let requests: Recorded[] = [];
let replies: Reply[] = [];
let binary: Buffer | null = null;

const ok = (result: unknown): Reply => ({ status: 200, json: { ok: true, result } });
const fail = (status: number, description: string, parameters?: unknown): Reply => ({ status, json: { ok: false, error_code: status, description, parameters } });

before(async () => {
  server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    requests.push({ path: req.url ?? "", body: text ? JSON.parse(text) : undefined });
    if (req.url?.startsWith("/file/") && binary) {
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(binary);
      return;
    }
    const reply = replies.shift() ?? ok({ message_id: 1 });
    res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.json));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => { requests = []; replies = []; binary = null; });

const make = (extra = {}) => {
  const sleeps: number[] = [];
  const a = new TelegramAdapter({
    tenantId: "t", botId: "b", token: new Secret(FAKE_TOKEN), apiBaseUrl: baseUrl, minSendIntervalMs: 0,
    sleep: async (ms) => { sleeps.push(ms); }, ...extra,
  });
  return { a, sleeps };
};
const noLeak = (err: unknown) => {
  const text = `${(err as Error).message} ${(err as Error).stack} ${JSON.stringify(err)}`;
  assert.ok(!text.includes(FAKE_TOKEN) && !text.includes("FAKE-TOKEN"), "error must not contain the token");
};

describe("send", () => {
  it("posts plain text to the right method with link previews off and returns chat-scoped ids", async () => {
    replies = [ok({ message_id: 42 })];
    const { a } = make();
    const r = await a.send("b", "555", "hello");
    assert.deepEqual(r, { platformMessageId: "555:42" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.path, `/bot${FAKE_TOKEN}/sendMessage`);
    assert.deepEqual(requests[0]!.body, { chat_id: "555", text: "hello", link_preview_options: { is_disabled: true } });
    assert.ok(!("parse_mode" in requests[0]!.body));
  });

  it("splits a message over 4096 characters into ordered requests", async () => {
    const text = Array.from({ length: 1500 }, (_, i) => `w${i}`).join(" ");
    replies = [ok({ message_id: 1 }), ok({ message_id: 2 }), ok({ message_id: 3 })];
    const { a } = make();
    const r = await a.send("b", "555", text);
    assert.ok(requests.length >= 2);
    for (const q of requests) assert.ok(Array.from(q.body.text as string).length <= 4096);
    assert.equal(requests.map((q) => q.body.text).join(" "), text);
    assert.equal(r.platformMessageId, "555:1");
  });

  it("on 429 waits retry_after seconds and retries until it succeeds", async () => {
    replies = [fail(429, "Too Many Requests: retry after 2", { retry_after: 2 }), ok({ message_id: 9 })];
    const { a, sleeps } = make();
    const r = await a.send("b", "555", "hi");
    assert.equal(r.platformMessageId, "555:9");
    assert.equal(requests.length, 2);
    assert.ok(sleeps.includes(2000), `slept ${sleeps}`);
  });

  it("gives up after maxSendRetries with a typed error carrying retry_after", async () => {
    replies = Array.from({ length: 5 }, () => fail(429, "Too Many Requests", { retry_after: 3 }));
    const { a } = make({ maxSendRetries: 2 });
    await assert.rejects(a.send("b", "555", "hi"), (e) => { noLeak(e); return e instanceof TelegramRateLimitError && e.retryAfter === 3; });
    assert.equal(requests.length, 3);
  });

  it("maps 403 to a blocked error, 401 to an auth error, other statuses to an API error, none retried", async () => {
    const { a } = make();
    replies = [fail(403, "Forbidden: bot was blocked by the user")];
    await assert.rejects(a.send("b", "1", "x"), (e) => { noLeak(e); return e instanceof TelegramBlockedError; });
    replies = [fail(401, "Unauthorized")];
    await assert.rejects(a.send("b", "1", "x"), (e) => e instanceof TelegramAuthError);
    replies = [fail(400, "Bad Request: chat not found")];
    await assert.rejects(a.send("b", "1", "x"), (e) => e instanceof TelegramApiError && e.status === 400);
    assert.equal(requests.length, 3);
  });

  it("maps an unreachable server to a network error that does not leak the token", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise<void>((r) => dead.close(() => r()));
    const { a } = make({ apiBaseUrl: url });
    await assert.rejects(a.send("b", "1", "x"), (e) => { noLeak(e); return e instanceof TelegramNetworkError; });
  });

  it("spaces sends to one chat but not to different chats", async () => {
    const { a } = make({ minSendIntervalMs: 60, sleep: undefined });
    const t0 = Date.now();
    await a.send("b", "1", "one");
    await a.send("b", "1", "two");
    assert.ok(Date.now() - t0 >= 55, "second send to the same chat waits");
    const t1 = Date.now();
    await Promise.all([a.send("b", "2", "x"), a.send("b", "3", "y")]);
    assert.ok(Date.now() - t1 < 55, "different chats do not wait for each other");
  });

  it("keeps concurrent sends to one chat in order", async () => {
    const { a } = make();
    await Promise.all([a.send("b", "1", "first"), a.send("b", "1", "second"), a.send("b", "1", "third")]);
    assert.deepEqual(requests.map((r) => r.body.text), ["first", "second", "third"]);
  });

  it("refuses to send without a token", async () => {
    const a = new TelegramAdapter({ tenantId: "t", botId: "b", apiBaseUrl: baseUrl });
    await assert.rejects(a.send("b", "1", "x"), /no bot token/);
  });
});

describe("healthCheck and fetchMedia", () => {
  it("reports ok for getMe, and the error code (not the token) when it fails", async () => {
    const { a } = make();
    replies = [ok({ id: 1, is_bot: true })];
    assert.deepEqual(await a.healthCheck("b"), { ok: true });
    assert.equal(requests[0]!.path, `/bot${FAKE_TOKEN}/getMe`);
    replies = [fail(401, "Unauthorized")];
    const h = await a.healthCheck("b");
    assert.deepEqual(h, { ok: false, detail: "unauthorized" });
  });

  it("downloads a file via getFile then the file endpoint", async () => {
    replies = [ok({ file_id: "f1", file_path: "photos/a.jpg" })];
    binary = Buffer.from([1, 2, 3, 4]);
    const { a } = make();
    const bytes = await a.fetchMedia("f1");
    assert.deepEqual([...bytes], [1, 2, 3, 4]);
    assert.deepEqual(requests.map((r) => r.path), [`/bot${FAKE_TOKEN}/getFile`, `/file/bot${FAKE_TOKEN}/photos/a.jpg`]);
    assert.deepEqual(requests[0]!.body, { file_id: "f1" });
  });
});
