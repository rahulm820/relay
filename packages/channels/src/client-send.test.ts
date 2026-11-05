import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { PermanentFailureError, type ClientSendPayload, type OutboxHandlerInput } from "@relay/core";
import { EnvSecretProvider, Secret, type SendResult } from "@relay/shared";
import { createClientSendHandler, ticketRef, type ClientSendStore, type SendContext } from "./index.js";
import { TelegramAdapter } from "./telegram/index.js";
import { MockTelegram } from "./testing/mock-telegram.js";

// These tests need no database: the Telegram logic runs against an in-memory store and a local mock Telegram.
const FAKE_TOKEN = "123456:FAKE-TOKEN-MARKER";
const TICKET = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MSG = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
let tg: MockTelegram;
before(async () => { tg = new MockTelegram(); await tg.start(); });
after(async () => { await tg.stop(); });
afterEach(() => tg.reset());

class MemoryStore implements ClientSendStore {
  sent = new Map<string, string>();
  blockedClients = new Set<string>();
  botErrors: string[] = [];
  failRecordOnce = false;
  constructor(public ctx: SendContext | null) {}
  async load() { return this.ctx ? { ...this.ctx, blocked: this.ctx.blocked || this.blockedClients.has(this.ctx.clientId) } : null; }
  async alreadySent(_t: string, _b: string, key: string) { return this.sent.has(key); }
  async recordSent(_t: string, _c: SendContext, key: string, s: SendResult) {
    if (this.failRecordOnce) { this.failRecordOnce = false; throw Object.assign(new Error("db down"), { code: "ECONNRESET" }); }
    this.sent.set(key, s.platformMessageId);
  }
  async markClientBlocked(_t: string, clientId: string) { this.blockedClients.add(clientId); }
  async markBotError(_t: string, _b: string, code: string) { this.botErrors.push(code); }
}

const baseCtx = (over: Partial<SendContext> = {}): SendContext => ({
  botId: "bot-1", channel: "telegram", credentialsRef: "env:BOT_TOKEN", chatId: "777", clientId: "client-1", conversationId: "conv-1",
  blocked: false, ticketIds: [TICKET], clarificationItems: [], ...over,
});
const status = (s: "in_progress" | "resolved" | "reopened" | "needs_info" = "in_progress"): ClientSendPayload => ({ kind: "status", ticketId: TICKET, status: s, eventId: EVENT });
const input = (payload: ClientSendPayload, key = "client:t:key:1"): OutboxHandlerInput => ({
  outboxId: "ob-1", tenantId: "t", kind: "client.send", idempotencyKey: key, payload: payload as unknown as Record<string, unknown>, attempt: 1, traceId: "tr",
});
function make(store: MemoryStore, env: Record<string, string | undefined> = { BOT_TOKEN: FAKE_TOKEN }) {
  const sleeps: number[] = [];
  const logs: Record<string, unknown>[] = [];
  const handler = createClientSendHandler({
    store, tokens: new EnvSecretProvider(env), log: (e) => logs.push(e),
    senderFor: (b) => new TelegramAdapter({ tenantId: b.tenantId, botId: b.botId, token: b.token, apiBaseUrl: tg.url, minSendIntervalMs: 0, maxSendRetries: 2, sleep: async (ms) => { sleeps.push(ms); } }),
  });
  return { handler, sleeps, logs };
}
const noToken = (e: unknown) => assert.ok(!`${(e as Error).message} ${(e as Error).stack} ${JSON.stringify(e)}`.includes("FAKE-TOKEN"), "error leaked the token");

describe("what is sent, and where", () => {
  it("an ack goes to the client's chat id with the fixed template and the ticket reference", async () => {
    const store = new MemoryStore(baseCtx());
    const { handler, logs } = make(store);
    await handler(input({ kind: "ack", messageId: MSG, sensitive: false }));
    assert.equal(tg.requests.length, 1);
    assert.equal(tg.requests[0]!.path, `/bot${FAKE_TOKEN}/sendMessage`);
    assert.equal(tg.requests[0]!.body.chat_id, "777");
    assert.equal(tg.texts[0], `Thanks, we've received your report and logged it as ${ticketRef(TICKET)}. A team member will follow up here.`);
    assert.ok(!("parse_mode" in tg.requests[0]!.body));
    assert.equal(store.sent.size, 1);
    assert.ok(logs.some((l) => l["outcome"] === "sent"));
  });

  it("each notifying status has its own text; needs_info carries the cleaned items", async () => {
    for (const s of ["in_progress", "resolved", "reopened"] as const) {
      await make(new MemoryStore(baseCtx())).handler(input(status(s), `k-${s}`));
    }
    await make(new MemoryStore(baseCtx({ clarificationItems: ["app version"] }))).handler(input(status("needs_info"), "k-ni"));
    assert.match(tg.texts[0]!, /now working on it/);
    assert.match(tg.texts[1]!, /believe this is resolved/);
    assert.match(tg.texts[2]!, /reopened/);
    assert.match(tg.texts[3]!, /Could you tell us: app version\?/);
  });

  it("an off-topic refusal needs no ticket", async () => {
    await make(new MemoryStore(baseCtx({ ticketIds: [] }))).handler(input({ kind: "refusal", messageId: MSG }));
    assert.match(tg.texts[0]!, /only for reporting problems/);
  });

  it("an ack without any ticket is a permanent mistake, not a send", async () => {
    await assert.rejects(make(new MemoryStore(baseCtx({ ticketIds: [] }))).handler(input({ kind: "ack", messageId: MSG, sensitive: false })), (e) => e instanceof PermanentFailureError && e.code === "no_ticket");
    assert.equal(tg.requests.length, 0);
  });
});

describe("duplicate guard", () => {
  it("does not send again when the outbound record already exists", async () => {
    const store = new MemoryStore(baseCtx());
    store.sent.set("client:t:key:1", "777:1");
    const out = await make(store).handler(input(status()));
    assert.deepEqual(out, { note: "already sent" });
    assert.equal(tg.requests.length, 0);
  });

  it("crash after Telegram accepted but before the record: the retry sends again (documented at-least-once window), then records once", async () => {
    const store = new MemoryStore(baseCtx());
    store.failRecordOnce = true;
    const { handler } = make(store);
    await assert.rejects(handler(input(status())));
    assert.equal(tg.requests.length, 1);
    assert.equal(store.sent.size, 0);
    await handler({ ...input(status()), attempt: 2 });
    assert.equal(tg.requests.length, 2);
    assert.equal(store.sent.size, 1);
    await handler({ ...input(status()), attempt: 3 }); // now recorded: no third send
    assert.equal(tg.requests.length, 2);
  });
});

describe("Telegram outcomes", () => {
  it("429: honours retry_after and then succeeds", async () => {
    tg.replies = [tg.fail(429, "Too Many Requests", { retry_after: 3 }), tg.ok()];
    const store = new MemoryStore(baseCtx());
    const { handler, sleeps } = make(store);
    await handler(input(status()));
    assert.ok(sleeps.includes(3000), `slept ${sleeps}`);
    assert.equal(tg.requests.length, 2);
    assert.equal(store.sent.size, 1);
  });

  it("429 that keeps coming is transient (the outbox backoff takes over), not permanent", async () => {
    tg.replies = Array.from({ length: 5 }, () => tg.fail(429, "Too Many Requests", { retry_after: 1 }));
    await assert.rejects(make(new MemoryStore(baseCtx())).handler(input(status())), (e) => !(e instanceof PermanentFailureError) && (e as { code: string }).code === "telegram_rate_limited");
  });

  it("403 blocked: permanent, the client is marked, and later sends are skipped without calling Telegram", async () => {
    tg.replies = [tg.fail(403, "Forbidden: bot was blocked by the user")];
    const store = new MemoryStore(baseCtx());
    const { handler } = make(store);
    await assert.rejects(handler(input(status())), (e) => { noToken(e); return e instanceof PermanentFailureError && e.code === "client_blocked_bot"; });
    assert.deepEqual([...store.blockedClients], ["client-1"]);
    const before = tg.requests.length;
    const later = await handler(input(status("resolved"), "client:t:key:2"));
    assert.deepEqual(later, { note: "skipped: the client blocked the bot" });
    assert.equal(tg.requests.length, before);
  });

  it("401 bad token: permanent and the bot is marked in error", async () => {
    tg.replies = [tg.fail(401, "Unauthorized")];
    const store = new MemoryStore(baseCtx());
    await assert.rejects(make(store).handler(input(status())), (e) => { noToken(e); return e instanceof PermanentFailureError && e.code === "telegram_unauthorized"; });
    assert.deepEqual(store.botErrors, ["unauthorized"]);
  });

  it("5xx and network errors are transient; other 4xx are permanent", async () => {
    tg.replies = [tg.fail(502, "Bad Gateway")];
    await assert.rejects(make(new MemoryStore(baseCtx())).handler(input(status())), (e) => !(e instanceof PermanentFailureError) && (e as { code: string }).code === "telegram_api_502");
    tg.replies = [tg.fail(400, "Bad Request: chat not found")];
    await assert.rejects(make(new MemoryStore(baseCtx())).handler(input(status())), (e) => e instanceof PermanentFailureError && e.code === "telegram_api_400");
    const dead = new MockTelegram();
    await dead.start(); const url = dead.url; await dead.stop();
    const handler = createClientSendHandler({
      store: new MemoryStore(baseCtx()), tokens: new EnvSecretProvider({ BOT_TOKEN: FAKE_TOKEN }), log: () => undefined,
      senderFor: (b) => new TelegramAdapter({ tenantId: b.tenantId, botId: b.botId, token: b.token, apiBaseUrl: url, minSendIntervalMs: 0 }),
    });
    await assert.rejects(handler(input(status())), (e) => { noToken(e); return !(e instanceof PermanentFailureError) && /^network_/.test((e as { code: string }).code); });
  });
});

describe("configuration problems never crash the worker", () => {
  it("missing token, bad reference, no reference, unsupported channel, unknown target, bad payload", async () => {
    const cases: [MemoryStore, Record<string, string | undefined>, string][] = [
      [new MemoryStore(baseCtx()), {}, "bot_token_missing"],
      [new MemoryStore(baseCtx({ credentialsRef: "vault:x" })), {}, "bot_credentials_invalid"],
      [new MemoryStore(baseCtx({ credentialsRef: null })), {}, "bot_token_missing"],
      [new MemoryStore(baseCtx({ channel: "whatsapp" })), { BOT_TOKEN: FAKE_TOKEN }, "unsupported_channel"],
      [new MemoryStore(null), { BOT_TOKEN: FAKE_TOKEN }, "target_not_found"],
    ];
    for (const [store, env, code] of cases) {
      await assert.rejects(make(store, env).handler(input(status())), (e) => e instanceof PermanentFailureError && e.code === code, code);
    }
    await assert.rejects(make(new MemoryStore(baseCtx())).handler({ ...input(status()), payload: { kind: "status", text: "hi" } }), (e) => e instanceof PermanentFailureError && e.code === "invalid_payload");
    assert.equal(tg.requests.length, 0);
  });
});

describe("no text or secrets leak", () => {
  it("logs contain ids and outcomes only", async () => {
    const store = new MemoryStore(baseCtx());
    const { handler, logs } = make(store);
    await handler(input(status()));
    const text = JSON.stringify(logs);
    assert.ok(!text.includes(FAKE_TOKEN) && !text.includes("777") && !text.includes("working on it"));
  });
});
