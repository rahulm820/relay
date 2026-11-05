import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import {
  Orchestrator, OutboxDispatcher, QueueProducer, Redis, createDefaultOutboxRegistry, createDefaultStageRegistry, notifyStage, ticketStage, transitionTicket,
  type ClientSendPayload,
} from "@relay/core";
import { createTenant, createTestDb, flushQueueKeys, waitFor, TEST_REDIS_URL, type TestDb } from "@relay/core/testing";
import { withTenant } from "@relay/db";
import { EnvSecretProvider, parseEncryptionKey, type ExtractFn, type NormalizedMessage } from "@relay/shared";
import { createClientSendHandler, createPgClientSendStore, ingestMessage, baselineRedact } from "./index.js";
import { MockTelegram } from "./testing/mock-telegram.js";

// Needs Postgres, Redis and the local mock Telegram. The token is fake; api.telegram.org is never contacted.
const FAKE_TOKEN = "123456:FAKE-TOKEN-MARKER";
const MARKER = "PERSONAL-DATA-MARKER";
const KEY = parseEncryptionKey(Buffer.alloc(32, 7).toString("base64"));
let db: TestDb;
let redis: Redis;
let tg: MockTelegram;

before(async () => { db = await createTestDb(); redis = new Redis(TEST_REDIS_URL); tg = new MockTelegram(); await tg.start(); });
after(async () => { await redis.quit(); await tg.stop(); await db.dispose(); });
afterEach(async () => { tg.reset(); await flushQueueKeys(redis); });

async function botFor(): Promise<{ tenantId: string; botId: string }> {
  const t = await createTenant(db.owner);
  const botId = randomUUID();
  await db.owner.query("INSERT INTO bots (id, tenant_id, channel, display_name, status, credentials_ref) VALUES ($1,$2,'telegram','b','active','env:E2E_BOT_TOKEN')", [botId, t.tenantId]);
  return { tenantId: t.tenantId, botId };
}
const msg = (b: { tenantId: string; botId: string }, n: number, sender = "4242", text = `checkout is broken ${MARKER}`): NormalizedMessage => ({
  ...b, channel: "telegram", platformMessageId: `${sender}:${n}`, platformChatId: sender, senderRef: sender, text, attachments: [], receivedAt: new Date().toISOString(), replyTo: null,
});
const validExtract: ExtractFn = async () => ({
  kind: "extracted", language: "en", is_complaint: true, off_topic: false, issues: [{
    title: `Checkout fails ${MARKER}`, summary: "s", category: "bug", product_area: null, steps_to_reproduce: [], expected: null, actual: null, environment: {},
    severity_signals: [], missing_info: [], confidence: 0.9 }],
  contains_sensitive_data: false, sentiment: "neutral", confidence: 0.9, missing_info: [],
});
const outboxStatus = async (tenantId: string, kind = "client.send") =>
  (await db.owner.query("SELECT status, last_error, payload FROM outbox WHERE tenant_id = $1 AND kind = $2 ORDER BY created_at", [tenantId, kind])).rows;

describe("Postgres store", () => {
  it("records an outbound message once per key, and a different tenant cannot load the ticket", async () => {
    const a = await botFor();
    const b = await botFor();
    const store = createPgClientSendStore(db.worker);
    const ing = await ingestMessage({ pool: db.api, producer: new QueueProducer(redis), redact: baselineRedact, encryptionKey: KEY }, msg(a, 1), { idempotencyKey: `tg:${a.botId}:1`, traceId: "t" });
    const payload: ClientSendPayload = { kind: "refusal", messageId: ing.messageId };
    const ctx = (await store.load(a.tenantId, payload))!;
    assert.equal(ctx.chatId, "4242");
    assert.equal(ctx.botId, a.botId);
    assert.equal(await store.alreadySent(a.tenantId, ctx.botId, "k1"), false);
    await store.recordSent(a.tenantId, ctx, "k1", { platformMessageId: "4242:900" }, "hello", payload);
    await store.recordSent(a.tenantId, ctx, "k1", { platformMessageId: "4242:900" }, "hello", payload);
    assert.equal(await store.alreadySent(a.tenantId, ctx.botId, "k1"), true);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM messages WHERE direction = 'out' AND idempotency_key = 'k1'")).rows[0].n, 1);
    assert.equal(await store.load(b.tenantId, payload), null, "tenant B cannot reach tenant A's conversation or bot");
    await store.markBotError(a.tenantId, a.botId, "unauthorized");
    assert.deepEqual((await db.owner.query("SELECT status, last_error FROM bots WHERE id = $1", [a.botId])).rows[0], { status: "error", last_error: "unauthorized" });
  });
});

describe("the whole loop", () => {
  it("ingest -> pipeline -> ack at Telegram; a status change -> update at Telegram; no client text anywhere", async () => {
    const bot = await botFor();
    const logs: unknown[] = [];
    const stages = createDefaultStageRegistry({ extract: validExtract });
    stages.register("ticket", ticketStage());
    stages.register("notify", notifyStage());
    const orchestrator = new Orchestrator({
      pool: db.worker, redis, stages, log: (e) => logs.push(e),
      consumer: { blockMs: 30, maxAttempts: 3, backoffBaseMs: 5, backoffMaxMs: 20, minIdleMs: 500, reclaimIntervalMs: 50 },
    });
    const registry = createDefaultOutboxRegistry(() => undefined);
    registry.register("client.send", createClientSendHandler({
      store: createPgClientSendStore(db.worker), tokens: new EnvSecretProvider({ E2E_BOT_TOKEN: FAKE_TOKEN }), apiBaseUrl: tg.url, log: (e) => logs.push(e),
    }));
    const dispatcher = new OutboxDispatcher({ pool: db.worker, registry, pollIntervalMs: 15, backoffBaseMs: 20, log: (e) => logs.push(e) });
    await orchestrator.start();
    dispatcher.start();
    try {
      const producer = new QueueProducer(redis);
      const ing = await ingestMessage({ pool: db.api, producer, redact: baselineRedact, encryptionKey: KEY }, msg(bot, 1), { idempotencyKey: `tg:${bot.botId}:1`, traceId: "e2e" });

      await waitFor(() => tg.texts.length >= 1, 8000);
      assert.match(tg.texts[0]!, /^Thanks, we've received your report and logged it as REL-[0-9A-F]{8}\./);
      assert.equal(tg.requests[0]!.body.chat_id, "4242");

      const ticketId = (await db.owner.query("SELECT id FROM tickets WHERE source_message_id = $1", [ing.messageId])).rows[0].id as string;
      await withTenant(db.worker, bot.tenantId, (c) => transitionTicket(c, { ticketId, to: "triaged", actor: { type: "human", ref: "tester" } })); // silent
      await withTenant(db.worker, bot.tenantId, (c) => transitionTicket(c, { ticketId, to: "assigned", actor: { type: "human", ref: "tester" } })); // silent
      await withTenant(db.worker, bot.tenantId, (c) => transitionTicket(c, { ticketId, to: "in_progress", actor: { type: "human", ref: "tester" } }));
      await waitFor(() => tg.texts.length >= 2, 8000);
      assert.match(tg.texts[1]!, /now working on it/);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(tg.texts.length, 2, "silent transitions sent nothing");

      const out = (await db.owner.query("SELECT text_redacted, platform_message_id FROM messages WHERE tenant_id = $1 AND direction = 'out' ORDER BY created_at", [bot.tenantId])).rows;
      assert.equal(out.length, 2);
      assert.ok(out.every((m) => m.platform_message_id.startsWith("4242:")));
      assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id = $1 AND type = 'client_notified'", [ticketId])).rows[0].n, 2);

      const everything = JSON.stringify([tg.requests.map((r) => r.body), logs]);
      assert.ok(!everything.includes(MARKER), "client text must not reach Telegram or the logs");
      assert.ok(!JSON.stringify(logs).includes(FAKE_TOKEN));
      assert.equal(await redis.xlen("q.dlq"), 0);

      // The client blocks the bot: that send fails for good, the client is marked, later updates are skipped.
      tg.replies = [tg.fail(403, "Forbidden: bot was blocked by the user")];
      await withTenant(db.worker, bot.tenantId, (c) => transitionTicket(c, { ticketId, to: "resolved", actor: { type: "human", ref: "tester" } }));
      await waitFor(async () => (await outboxStatus(bot.tenantId)).some((o) => o.status === "failed"), 8000);
      assert.equal((await db.owner.query("SELECT contact_blocked_at FROM clients WHERE channel_user_ref = '4242' AND tenant_id = $1", [bot.tenantId])).rows[0].contact_blocked_at !== null, true);
      const before = tg.requests.length;
      await withTenant(db.worker, bot.tenantId, (c) => transitionTicket(c, { ticketId, to: "reopened", actor: { type: "human", ref: "tester" } }));
      await waitFor(async () => (await outboxStatus(bot.tenantId)).filter((o) => o.status === "done").length >= 3, 8000);
      assert.equal(tg.requests.length, before, "no further Telegram calls for a blocked client");

      // They write again: contact is possible once more.
      await ingestMessage({ pool: db.api, producer, redact: baselineRedact, encryptionKey: KEY }, msg(bot, 2, "4242", "hello again"), { idempotencyKey: `tg:${bot.botId}:2`, traceId: "e2e" });
      assert.equal((await db.owner.query("SELECT contact_blocked_at FROM clients WHERE channel_user_ref = '4242' AND tenant_id = $1", [bot.tenantId])).rows[0].contact_blocked_at, null);
    } finally {
      await dispatcher.close();
      await orchestrator.close();
    }
  });

  it("an off-topic message gets the polite refusal and no ticket", async () => {
    const bot = await botFor();
    const stages = createDefaultStageRegistry({ extract: async () => ({
      kind: "extracted", language: "en", is_complaint: true, off_topic: true, issues: [], contains_sensitive_data: false, sentiment: "neutral", confidence: 0.9, missing_info: [] }) });
    stages.register("ticket", ticketStage());
    stages.register("notify", notifyStage());
    const orchestrator = new Orchestrator({ pool: db.worker, redis, stages, log: () => undefined, consumer: { blockMs: 30, maxAttempts: 3, backoffBaseMs: 5, backoffMaxMs: 20, minIdleMs: 500, reclaimIntervalMs: 50 } });
    const registry = createDefaultOutboxRegistry(() => undefined);
    registry.register("client.send", createClientSendHandler({ store: createPgClientSendStore(db.worker), tokens: new EnvSecretProvider({ E2E_BOT_TOKEN: FAKE_TOKEN }), apiBaseUrl: tg.url, log: () => undefined }));
    const dispatcher = new OutboxDispatcher({ pool: db.worker, registry, pollIntervalMs: 15, log: () => undefined });
    await orchestrator.start();
    dispatcher.start();
    try {
      const ing = await ingestMessage({ pool: db.api, producer: new QueueProducer(redis), redact: baselineRedact, encryptionKey: KEY }, msg(bot, 1, "9001", "what is the weather"), { idempotencyKey: `tg:${bot.botId}:1`, traceId: "t" });
      await waitFor(() => tg.texts.length >= 1, 8000);
      assert.match(tg.texts[0]!, /only for reporting problems/);
      assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM tickets WHERE source_message_id = $1", [ing.messageId])).rows[0].n, 0);
    } finally {
      await dispatcher.close();
      await orchestrator.close();
    }
  });

  it("a missing bot token fails the row with a code and the worker keeps running", async () => {
    const bot = await botFor();
    const registry = createDefaultOutboxRegistry(() => undefined);
    registry.register("client.send", createClientSendHandler({ store: createPgClientSendStore(db.worker), tokens: new EnvSecretProvider({}), apiBaseUrl: tg.url, log: () => undefined }));
    const ing = await ingestMessage({ pool: db.api, producer: new QueueProducer(redis), redact: baselineRedact, encryptionKey: KEY }, msg(bot, 1, "9002"), { idempotencyKey: `tg:${bot.botId}:1`, traceId: "t" });
    await withTenant(db.worker, bot.tenantId, (c) => c.query(
      "INSERT INTO outbox (tenant_id, kind, payload, idempotency_key) VALUES ($1,'client.send',$2,$3)", [bot.tenantId, JSON.stringify({ kind: "refusal", messageId: ing.messageId }), `client:${bot.tenantId}:${ing.messageId}:refusal`]));
    await new OutboxDispatcher({ pool: db.worker, registry, log: () => undefined }).runOnce();
    const [row] = await outboxStatus(bot.tenantId);
    assert.deepEqual([row.status, row.last_error], ["failed", "bot token is not configured"]);
    assert.equal(tg.requests.length, 0);
  });
});
