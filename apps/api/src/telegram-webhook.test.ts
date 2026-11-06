import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { generateWebhookSecret, hashWebhookSecret } from "@relay/channels";
import { Orchestrator, QueueProducer, Redis, createDefaultStageRegistry } from "@relay/core";
import { createTenant, createTestDb, flushQueueKeys, waitFor, TEST_REDIS_URL, type TestDb } from "@relay/core/testing";
import { createPool } from "@relay/db";
import { decryptText, parseEncryptionKey, type ExtractFn } from "@relay/shared";
import { buildServer } from "./server.js";

const KEY = parseEncryptionKey(Buffer.alloc(32, 9).toString("base64"));
const HEADER = "x-telegram-bot-api-secret-token";
const MARKER = "PERSONAL-DATA-MARKER";

let db: TestDb;
let redis: Redis;
let lines: string[] = [];
let apps: ReturnType<typeof buildServer>[] = [];

const logStream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
const stubExtract: ExtractFn = async () => ({
  kind: "extracted", language: "en", is_complaint: true, off_topic: false, issues: [],
  contains_sensitive_data: false, sentiment: "neutral", confidence: 0.9, missing_info: [],
});

before(async () => { db = await createTestDb(); redis = new Redis(TEST_REDIS_URL); });
after(async () => { await redis.quit(); await db.dispose(); });
beforeEach(async () => { lines = []; await flushQueueKeys(redis); });
afterEach(async () => { await Promise.all(apps.map((a) => a.close())); apps = []; await flushQueueKeys(redis); });

function server(over: Partial<Parameters<typeof buildServer>[0]> = {}) {
  const app = buildServer({ pool: db.api, producer: new QueueProducer(redis), encryptionKey: KEY, logStream, ...over });
  apps.push(app);
  return app;
}

interface TestBot { botId: string; tenantId: string; secret: string }
async function bot(status = "active"): Promise<TestBot> {
  const t = await createTenant(db.owner);
  const botId = randomUUID();
  const secret = generateWebhookSecret();
  await db.owner.query(
    "INSERT INTO bots (id, tenant_id, channel, display_name, status, webhook_secret_hash) VALUES ($1,$2,'telegram','b',$3,$4)",
    [botId, t.tenantId, status, hashWebhookSecret(secret)],
  );
  return { botId, tenantId: t.tenantId, secret };
}

let nextUpdate = 1000;
const message = (over: Record<string, unknown> = {}) => ({
  message_id: 7, date: Math.floor(Date.now() / 1000), text: "checkout is broken", chat: { id: 555, type: "private" }, from: { id: 555, is_bot: false }, ...over,
});
const post = (app: ReturnType<typeof buildServer>, b: { botId: string }, secret: string | undefined, body: unknown, extra: Record<string, string> = {}) =>
  app.inject({
    method: "POST", url: `/webhooks/telegram/${b.botId}`,
    headers: { "content-type": "application/json", ...(secret ? { [HEADER]: secret } : {}), ...extra },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
const update = (msg: Record<string, unknown> = message(), id = nextUpdate++) => ({ update_id: id, message: msg });
const count = async (table: string, tenantId: string) =>
  (await db.owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId])).rows[0].n as number;
// createTenant() also makes one fixture client and conversation (random uuid refs); Telegram senders have numeric refs.
const telegramClients = async (tenantId: string) =>
  (await db.owner.query("SELECT count(*)::int AS n FROM clients WHERE tenant_id = $1 AND channel_user_ref ~ '^[0-9]+$'", [tenantId])).rows[0].n as number;
const telegramConversations = async (tenantId: string) =>
  (await db.owner.query("SELECT count(*)::int AS n FROM conversations v JOIN clients c ON c.id = v.client_id WHERE v.tenant_id = $1 AND c.channel_user_ref ~ '^[0-9]+$'", [tenantId])).rows[0].n as number;

describe("accepting messages", () => {
  it("stores a redacted projection and encrypted original, then queues only the message id", async () => {
    // Warm the path with a different bot (the first request on a fresh server pays one-off connection costs), then
    // clear the queue so the assertions below see only this request.
    const app = server();
    const warm = await bot();
    await post(app, warm, warm.secret, update(message({ text: "warm up" })));
    await flushQueueKeys(redis);

    const b = await bot();
    const raw = `mail jane@example.com or call +1 (415) 555-2671, token: abc123secret ${MARKER}`;
    const u = update(message({ text: raw }));
    const res = await post(app, b, b.secret, u);
    assert.equal(res.statusCode, 200);
    const row = (await db.owner.query("SELECT id, platform_message_id, text_redacted, text_encrypted, direction FROM messages WHERE tenant_id = $1", [b.tenantId])).rows[0];
    assert.equal(row.platform_message_id, "555:7");
    assert.ok(!/jane@example\.com|555-2671|abc123secret/.test(row.text_redacted), row.text_redacted);
    assert.ok(row.text_redacted.includes(MARKER));
    assert.equal(decryptText(KEY, row.text_encrypted), raw);
    const [entry] = await redis.xrange("q:ingest", "-", "+");
    const env = JSON.parse(entry![1][1]!);
    assert.deepEqual(env.payload, { messageId: row.id });
    assert.equal(env.tenantId, b.tenantId);
    assert.ok(await redis.exists(`idem:ingest:tg:${b.botId}:${u.update_id}`), "queue idempotency key is tg:{botId}:{update_id}");
    assert.equal(await telegramClients(b.tenantId), 1);
    assert.equal(await telegramConversations(b.tenantId), 1);
    // The acknowledgement is about storing and queueing only: no pipeline work has happened by the time it returns.
    // (State, not a stopwatch: a timing bound measures the machine, this measures the design.)
    assert.equal(await count("tickets", b.tenantId), 0, "no ticket yet");
    assert.equal(await count("outbox", b.tenantId), 0, "nothing queued for GitHub, Switch or the client");
    assert.equal(await redis.xlen("q:ingest"), 1, "exactly the one ingest job");
  });

  it("the same update delivered twice is one message and one job", async () => {
    const b = await bot();
    const app = server();
    const u = update();
    assert.equal((await post(app, b, b.secret, u)).statusCode, 200);
    assert.equal((await post(app, b, b.secret, u)).statusCode, 200);
    assert.equal(await count("messages", b.tenantId), 1);
    assert.equal(await redis.xlen("q:ingest"), 1);
  });

  it("the same message_id in two different chats makes two messages", async () => {
    const b = await bot();
    const app = server();
    await post(app, b, b.secret, update(message({ chat: { id: 1, type: "private" }, from: { id: 1 } })));
    await post(app, b, b.secret, update(message({ chat: { id: 2, type: "private" }, from: { id: 2 } })));
    assert.equal(await count("messages", b.tenantId), 2);
    assert.equal(await telegramConversations(b.tenantId), 2);
  });

  it("after an enqueue failure answers 5xx, then the redelivery succeeds with one message and one job", async () => {
    const b = await bot();
    const u = update();
    const broken = server({ producer: { enqueue: async () => { throw Object.assign(new Error("redis down"), { code: "ECONNREFUSED" }); } } });
    const first = await post(broken, b, b.secret, u);
    assert.equal(first.statusCode, 503);
    assert.equal(await count("messages", b.tenantId), 1);
    assert.equal(await redis.xlen("q:ingest"), 0);
    const second = await post(server(), b, b.secret, u);
    assert.equal(second.statusCode, 200);
    assert.equal(await count("messages", b.tenantId), 1);
    assert.equal(await redis.xlen("q:ingest"), 1);
  });

  it("answers 5xx and enqueues nothing when the database is down", async () => {
    const b = await bot();
    const dead = createPool(`postgres://relay_api:x@127.0.0.1:1/none`);
    const res = await post(server({ pool: dead }), b, b.secret, update());
    await dead.end();
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: "unavailable" });
    assert.equal(await redis.xlen("q:ingest"), 0);
  });

  it("answers 5xx and enqueues nothing when persisting fails", async () => {
    const b = await bot();
    const res = await post(server({ encryptionKey: Buffer.alloc(5) }), b, b.secret, update());
    assert.equal(res.statusCode, 503);
    assert.equal(await count("messages", b.tenantId), 0);
    assert.equal(await redis.xlen("q:ingest"), 0);
  });
});

describe("ignored updates are acknowledged and not processed", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["edited message", { update_id: 1, edited_message: message() }],
    ["channel post", { update_id: 1, channel_post: message({ chat: { id: -100, type: "channel" } }) }],
    ["photo without text", update(message({ text: undefined, photo: [{ file_id: "f" }] }))],
    ["bot-sent message", update(message({ from: { id: 9, is_bot: true } }))],
    ["group message", update(message({ chat: { id: -5, type: "supergroup" } }))],
    ["/start command", update(message({ text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] }))],
    ["stale message", update(message({ date: Math.floor(Date.now() / 1000) - 3 * 86400 }))],
    ["callback query", { update_id: 1, callback_query: { id: "x" } }],
  ];
  for (const [name, body] of cases) {
    it(`${name}: 200, nothing stored or queued`, async () => {
      const b = await bot();
      const res = await post(server(), b, b.secret, body);
      assert.equal(res.statusCode, 200, name);
      assert.equal(await count("messages", b.tenantId), 0);
      assert.equal(await redis.xlen("q:ingest"), 0);
    });
  }
});

describe("rejecting requests", () => {
  it("wrong secret, missing secret, unknown bot, bad id and inactive bot all answer the same 401 and write nothing", async () => {
    const b = await bot();
    const pending = await bot("pending");
    const app = server();
    const results = await Promise.all([
      post(app, b, "wrong-secret-value", update()),
      post(app, b, undefined, update()),
      post(app, { botId: randomUUID() }, b.secret, update()),
      post(app, { botId: "not-a-uuid" }, b.secret, update()),
      post(app, pending, pending.secret, update()),
    ]);
    for (const r of results) {
      assert.equal(r.statusCode, 401);
      assert.deepEqual(r.json(), { error: "unauthorized" });
    }
    assert.equal(new Set(results.map((r) => r.body)).size, 1, "identical bodies");
    for (const t of [b, pending]) assert.equal(await count("messages", t.tenantId), 0);
    assert.equal(await redis.xlen("q:ingest"), 0);
  });

  it("a secret from one tenant never works on another tenant's bot and writes nothing there", async () => {
    const a = await bot();
    const c = await bot();
    const app = server();
    assert.equal((await post(app, c, a.secret, update())).statusCode, 401);
    assert.equal((await post(app, a, c.secret, update())).statusCode, 401);
    assert.equal((await post(app, a, a.secret, update())).statusCode, 200);
    assert.equal(await count("messages", a.tenantId), 1);
    assert.equal(await count("messages", c.tenantId), 0);
  });

  it("checks the secret before reading the body", async () => {
    const b = await bot();
    const huge = JSON.stringify({ update_id: 1, junk: "x".repeat(300_000) });
    assert.equal((await post(server(), b, "wrong", huge)).statusCode, 401);
    assert.equal((await post(server(), b, undefined, "{not json")).statusCode, 401);
  });

  it("malformed JSON, oversized bodies, wrong content type and missing update_id are rejected without detail", async () => {
    const b = await bot();
    const app = server();
    const bad = await post(app, b, b.secret, "{not json");
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.json(), { error: "bad_request" });
    assert.ok(!/stack|at |Unexpected/.test(bad.body));
    const big = await post(app, b, b.secret, JSON.stringify({ update_id: 1, junk: "x".repeat(300_000) }));
    assert.equal(big.statusCode, 413);
    assert.deepEqual(big.json(), { error: "bad_request" });
    const xml = await app.inject({ method: "POST", url: `/webhooks/telegram/${b.botId}`, headers: { "content-type": "application/xml", [HEADER]: b.secret }, payload: "<a/>" });
    assert.equal(xml.statusCode, 415);
    // Fastify reads text/plain as a string; it is not an update object, so validation rejects it.
    const text = await app.inject({ method: "POST", url: `/webhooks/telegram/${b.botId}`, headers: { "content-type": "text/plain", [HEADER]: b.secret }, payload: "hi" });
    assert.equal(text.statusCode, 400);
    assert.equal((await post(app, b, b.secret, { message: message() })).statusCode, 400);
    assert.equal((await post(app, b, b.secret, [])).statusCode, 400);
    assert.equal(await count("messages", b.tenantId), 0);
  });

  it("only POST is served", async () => {
    const b = await bot();
    const res = await server().inject({ method: "GET", url: `/webhooks/telegram/${b.botId}` });
    assert.equal(res.statusCode, 404);
  });
});

describe("logging", () => {
  it("never records message text, the secret header, or request bodies", async () => {
    const b = await bot();
    const app = server({ logLevel: "trace" });
    await post(app, b, b.secret, update(message({ text: `${MARKER} jane@example.com` })));
    await post(app, b, "WRONG-SECRET-MARKER", update(message({ text: MARKER })));
    await post(app, b, b.secret, `{"broken": "${MARKER}`);
    await post(server({ encryptionKey: Buffer.alloc(5), logLevel: "trace" }), b, b.secret, update(message({ text: MARKER })));
    const logged = lines.join("");
    assert.ok(logged.length > 0);
    for (const secret of [MARKER, b.secret, "WRONG-SECRET-MARKER", "jane@example.com"]) assert.ok(!logged.includes(secret), `log leaked ${secret.slice(0, 6)}...`);
  });
});

describe("end to end", () => {
  it("a webhook post runs through the real orchestrator until the pipeline run completes", async () => {
    const b = await bot();
    const orchestrator = new Orchestrator({
      pool: db.worker, redis, stages: createDefaultStageRegistry({ extract: stubExtract }),
      consumer: { blockMs: 30, maxAttempts: 3, backoffBaseMs: 5, backoffMaxMs: 20, minIdleMs: 500, reclaimIntervalMs: 50 },
      log: () => undefined,
    });
    await orchestrator.start();
    try {
      const res = await post(server(), b, b.secret, update(message({ text: "my order is stuck" })));
      assert.equal(res.statusCode, 200);
      const msgId = (await db.owner.query("SELECT id FROM messages WHERE tenant_id = $1", [b.tenantId])).rows[0].id;
      await waitFor(async () => (await db.owner.query("SELECT status FROM pipeline_runs WHERE message_id = $1", [msgId])).rows[0]?.status === "completed");
      const run = (await db.owner.query("SELECT stage_results FROM pipeline_runs WHERE message_id = $1", [msgId])).rows[0];
      assert.equal(run.stage_results.extract.kind, "extracted");
      assert.equal(await redis.xlen("q.dlq"), 0);
    } finally {
      await orchestrator.close();
    }
  });
});
