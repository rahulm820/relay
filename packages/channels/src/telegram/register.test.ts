import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import { createTestDb, createTenant, type TestDb } from "@relay/core/testing";
import { hashWebhookSecret, registerTelegramWebhook } from "./index.js";

// Fake token and a local mock instead of api.telegram.org.
const FAKE_TOKEN = "123456:FAKE-TOKEN-MARKER";
let db: TestDb;
let server: Server;
let baseUrl: string;
let requests: { path: string; body: any }[] = [];
let setWebhookFails = false;

before(async () => {
  db = await createTestDb();
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    requests.push({ path: req.url ?? "", body: text ? JSON.parse(text) : undefined });
    const failing = setWebhookFails && req.url?.endsWith("/setWebhook");
    res.writeHead(failing ? 400 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(failing ? { ok: false, error_code: 400, description: "Bad Request: bad webhook" } : { ok: true, result: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.dispose();
});
afterEach(() => { requests = []; setWebhookFails = false; });

async function newBot(credentialsRef: string | null = "env:TEST_BOT_TOKEN"): Promise<{ botId: string; tenantId: string }> {
  const t = await createTenant(db.owner);
  const botId = randomUUID();
  await db.owner.query("INSERT INTO bots (id, tenant_id, channel, display_name, credentials_ref) VALUES ($1,$2,'telegram','b',$3)", [botId, t.tenantId, credentialsRef]);
  return { botId, tenantId: t.tenantId };
}
const row = async (botId: string) => (await db.owner.query("SELECT status, webhook_secret_hash, webhook_url, last_error FROM bots WHERE id = $1", [botId])).rows[0];
const run = (botId: string, extra: object = {}) => {
  const out: string[] = [];
  const done = registerTelegramWebhook({
    pool: db.api, botId, env: { TEST_BOT_TOKEN: FAKE_TOKEN }, publicUrl: "https://example.trycloudflare.com/", apiBaseUrl: baseUrl, dryRun: false, out: (l) => out.push(l), ...extra,
  });
  return { out, done };
};

describe("registerTelegramWebhook", () => {
  it("dry run changes nothing, makes no network call and prints no secret", async () => {
    const { botId } = await newBot();
    const { out, done } = run(botId, { dryRun: true });
    await done;
    assert.equal(requests.length, 0);
    const r = await row(botId);
    assert.equal(r.status, "pending");
    assert.equal(r.webhook_secret_hash, null);
    const text = out.join("\n");
    assert.ok(!text.includes(FAKE_TOKEN) && !text.includes("FAKE-TOKEN"));
    assert.match(text, /dry run/);
  });

  it("calls getMe then setWebhook, stores only the hash and activates the bot", async () => {
    const { botId } = await newBot();
    const { out, done } = run(botId);
    await done;
    assert.deepEqual(requests.map((r) => r.path), [`/bot${FAKE_TOKEN}/getMe`, `/bot${FAKE_TOKEN}/setWebhook`]);
    const hook = requests[1]!.body;
    assert.equal(hook.url, `https://example.trycloudflare.com/webhooks/telegram/${botId}`);
    assert.deepEqual(hook.allowed_updates, ["message"]);
    assert.match(hook.secret_token, /^[A-Za-z0-9_-]{43}$/);
    const r = await row(botId);
    assert.equal(r.status, "active");
    assert.equal(r.webhook_secret_hash, hashWebhookSecret(hook.secret_token));
    assert.ok(r.webhook_url.endsWith(`/webhooks/telegram/${botId}`));
    const text = out.join("\n");
    assert.ok(!text.includes(hook.secret_token), "output must not contain the secret");
    assert.ok(!text.includes(FAKE_TOKEN));
  });

  it("re-running rotates the secret", async () => {
    const { botId } = await newBot();
    await run(botId).done;
    const first = (await row(botId)).webhook_secret_hash;
    await run(botId).done;
    assert.notEqual((await row(botId)).webhook_secret_hash, first);
  });

  it("marks the bot as errored when setWebhook fails", async () => {
    const { botId } = await newBot();
    setWebhookFails = true;
    await assert.rejects(run(botId).done);
    const r = await row(botId);
    assert.equal(r.status, "error");
    assert.equal(r.last_error, "api_400");
  });

  it("rejects an unknown bot, a missing token variable and a non-https URL, naming only variable names", async () => {
    await assert.rejects(run(randomUUID()).done, /bot not found/);
    const { botId } = await newBot();
    await assert.rejects(run(botId, { env: {} }).done, /TEST_BOT_TOKEN/);
    await assert.rejects(run(botId, { publicUrl: "http://insecure.example" }).done, /https/);
    const noRef = await newBot(null);
    await assert.rejects(run(noRef.botId).done, /credentials_ref/);
    assert.equal(requests.length, 0);
  });
});
