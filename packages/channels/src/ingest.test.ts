import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import { QueueProducer, Redis } from "@relay/core";
import { createMessage as _unused, createTenant, createTestDb, flushQueueKeys, TEST_REDIS_URL, type TestDb } from "@relay/core/testing";
import { decryptText, parseEncryptionKey, type NormalizedMessage } from "@relay/shared";
import { ingestMessage } from "./ingest.js";
import { baselineRedact } from "./redact.js";

void _unused;
let db: TestDb;
let redis: Redis;
const key = parseEncryptionKey(Buffer.alloc(32, 3).toString("base64"));

before(async () => { db = await createTestDb(); redis = new Redis(TEST_REDIS_URL); });
afterEach(async () => { await flushQueueKeys(redis); });
after(async () => { await redis.quit(); await db.dispose(); });

async function botFor(): Promise<{ tenantId: string; botId: string }> {
  const t = await createTenant(db.owner);
  const botId = randomUUID();
  await db.owner.query("INSERT INTO bots (id, tenant_id, channel, display_name, status) VALUES ($1,$2,'telegram','b','active')", [botId, t.tenantId]);
  return { tenantId: t.tenantId, botId };
}
const msg = (b: { tenantId: string; botId: string }, n: number, sender = "u1", text = "hello"): NormalizedMessage => ({
  ...b, channel: "telegram", platformMessageId: `${sender}:${n}`, platformChatId: sender, senderRef: sender, text, attachments: [],
  receivedAt: new Date().toISOString(), replyTo: null,
});
const deps = () => ({ pool: db.api, producer: new QueueProducer(redis), redact: baselineRedact, encryptionKey: key });

describe("ingestMessage", () => {
  it("stores redacted and encrypted text and enqueues only the message id", async () => {
    const b = await botFor();
    const r = await ingestMessage(deps(), msg(b, 1, "u1", "mail jane@example.com card 4111 1111 1111 1111"), { idempotencyKey: `tg:${b.botId}:1`, traceId: "tr" });
    assert.equal(r.duplicate, false);
    const row = (await db.owner.query("SELECT text_redacted, text_encrypted, direction FROM messages WHERE id = $1", [r.messageId])).rows[0];
    assert.equal(row.text_redacted, "mail [EMAIL] card [CARD]");
    assert.equal(decryptText(key, row.text_encrypted), "mail jane@example.com card 4111 1111 1111 1111");
    assert.equal(row.direction, "in");
    const [entry] = await redis.xrange("q:ingest", "-", "+");
    const env = JSON.parse(entry![1][1]!);
    assert.deepEqual(env.payload, { messageId: r.messageId });
    assert.equal(env.tenantId, b.tenantId);
  });

  it("concurrent first messages from one sender create one client and one conversation", async () => {
    const b = await botFor();
    await Promise.all([1, 2, 3, 4].map((n) => ingestMessage(deps(), msg(b, n), { idempotencyKey: `tg:${b.botId}:${n}`, traceId: "t" })));
    // createTenant() also makes one fixture client and conversation; count only this sender's.
    const n = async (sql: string) => (await db.owner.query(sql, [b.tenantId])).rows[0].n;
    assert.equal(await n("SELECT count(*)::int AS n FROM clients WHERE tenant_id = $1 AND channel_user_ref = 'u1'"), 1);
    assert.equal(await n("SELECT count(*)::int AS n FROM conversations v JOIN clients c ON c.id = v.client_id WHERE v.tenant_id = $1 AND c.channel_user_ref = 'u1'"), 1);
    const count = async (table: string) => n(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`);
    assert.equal(await count("messages"), 4);
  });

  it("the same message twice is one row and one queued job", async () => {
    const b = await botFor();
    const a = await ingestMessage(deps(), msg(b, 5), { idempotencyKey: `tg:${b.botId}:5`, traceId: "t" });
    const again = await ingestMessage(deps(), msg(b, 5), { idempotencyKey: `tg:${b.botId}:5`, traceId: "t" });
    assert.equal(again.messageId, a.messageId);
    assert.equal(again.duplicate, true);
    assert.equal(await redis.xlen("q:ingest"), 1);
  });

  it("an enqueue failure leaves the message stored, and a retry enqueues exactly once", async () => {
    const b = await botFor();
    const broken = { ...deps(), producer: { enqueue: async () => { throw new Error("redis down"); } } as unknown as QueueProducer };
    await assert.rejects(ingestMessage(broken, msg(b, 6), { idempotencyKey: `tg:${b.botId}:6`, traceId: "t" }), /redis down/);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1", [b.tenantId])).rows[0].n, 1);
    assert.equal(await redis.xlen("q:ingest"), 0);
    const retry = await ingestMessage(deps(), msg(b, 6), { idempotencyKey: `tg:${b.botId}:6`, traceId: "t" });
    assert.equal(retry.duplicate, true);
    assert.equal(await redis.xlen("q:ingest"), 1);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1", [b.tenantId])).rows[0].n, 1);
  });

  it("the same platform message id under two bots is two messages", async () => {
    const a = await botFor();
    const b = await botFor();
    const ra = await ingestMessage(deps(), msg(a, 1), { idempotencyKey: `tg:${a.botId}:1`, traceId: "t" });
    const rb = await ingestMessage(deps(), msg(b, 1), { idempotencyKey: `tg:${b.botId}:1`, traceId: "t" });
    assert.notEqual(ra.messageId, rb.messageId);
  });
});
