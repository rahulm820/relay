import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { after, afterEach, before, describe, it } from "node:test";
import { QueueProducer, Redis, createTicketsForMessage } from "@relay/core";
import { createMember, createMessage, createTenant, createTestDb, TEST_REDIS_URL, type TestDb, type TestTenant } from "@relay/core/testing";
import { withTenant } from "@relay/db";
import { hashPassword, parseEncryptionKey } from "@relay/shared";
import { buildServer } from "./server.js";

// Real Postgres: real sessions through the real routes and the SECURITY DEFINER functions of migration 0006.
const UI = "http://localhost:3000";
const PASSWORD = "Adm1n-Passw0rd-MARKER";
let db: TestDb;
let redis: Redis;
let apps: ReturnType<typeof buildServer>[] = [];
let lines: string[] = [];
const logStream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });

before(async () => { db = await createTestDb(); redis = new Redis(TEST_REDIS_URL); });
after(async () => { await redis.quit(); await db.dispose(); });
afterEach(async () => { await Promise.all(apps.map((a) => a.close())); apps = []; });

function server() {
  lines = [];
  const app = buildServer({
    pool: db.api, producer: new QueueProducer(redis), encryptionKey: parseEncryptionKey(Buffer.alloc(32, 1).toString("base64")),
    logStream, logLevel: "trace", admin: { allowedOrigins: [UI], sessionTtlHours: 12, sessionIdleMinutes: 60, cookieSecure: false },
  });
  apps.push(app);
  return app;
}
const H = { "content-type": "application/json", "x-requested-with": "relay-admin", origin: UI };

async function addUser(t: TestTenant, role = "pm", email = `${randomUUID()}@example.test`): Promise<{ email: string; id: string }> {
  const id = randomUUID();
  await db.owner.query("INSERT INTO admin_users (id, tenant_id, email, name, role, password_hash) VALUES ($1,$2,$3,'Tester',$4,$5)",
    [id, t.tenantId, email, role, await hashPassword(PASSWORD, { N: 1024, r: 8, p: 1 })]);
  return { email, id };
}
async function signIn(app: ReturnType<typeof buildServer>, email: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: JSON.stringify({ email, password }) });
  assert.equal(res.statusCode, 200, "login failed");
  return String(res.headers["set-cookie"]).split(";")[0]!;
}
const call = (app: ReturnType<typeof buildServer>, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string | null, body?: unknown) =>
  app.inject({ method, url, headers: { ...(method !== "GET" ? { "x-requested-with": "relay-admin", origin: UI } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
const audits = async (tenantId: string) => (await db.owner.query("SELECT actor, action, target, diff FROM audit_log WHERE tenant_id = $1 AND action NOT LIKE 'auth.%' ORDER BY created_at", [tenantId])).rows;

describe("real sessions in Postgres", () => {
  it("login, me, tickets behind the session, logout; 401s at every step they should", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const u = await addUser(t);
    const messageId = await createMessage(db.owner, t);
    const [created] = await withTenant(db.worker, t.tenantId, (c) => createTicketsForMessage(c, {
      tenantId: t.tenantId, messageId, traceId: "x", actor: { type: "system", ref: "test" },
      tickets: [{ issueIndex: 0, title: "t", summary: "", category: "bug", priority: "P3", priorityReason: "r", prioritySource: "rules", outbox: false }] }));
    assert.equal((await call(app, "GET", "/api/tickets", null)).statusCode, 401);
    const cookie = await signIn(app, u.email);
    assert.equal((await call(app, "GET", "/api/auth/me", cookie)).json().user.email, u.email);
    assert.equal((await call(app, "GET", "/api/tickets", cookie)).json().items.length >= 1, true);
    const patched = await call(app, "PATCH", `/api/tickets/${created!.ticketId}`, cookie, { priority: "P1" });
    assert.equal(patched.statusCode, 200);
    const ev = (await db.owner.query("SELECT actor_ref FROM ticket_events WHERE ticket_id = $1 AND type = 'priority_changed'", [created!.ticketId])).rows;
    assert.deepEqual(ev, [{ actor_ref: `user:${u.id}` }]);
    assert.equal((await call(app, "POST", "/api/auth/logout", cookie)).statusCode, 204);
    assert.equal((await call(app, "GET", "/api/tickets", cookie)).statusCode, 401);
  });

  it("stores only a hash of the token, and expired, idle, revoked and inactive sessions all fail", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const u = await addUser(t);
    const cookie = await signIn(app, u.email);
    const token = cookie.split("=")[1]!;
    const stored = (await db.owner.query("SELECT token_hash FROM admin_sessions WHERE user_id = $1", [u.id])).rows;
    assert.equal(stored.length, 1);
    assert.ok(stored[0].token_hash !== token && !JSON.stringify(stored).includes(token));
    assert.equal((await call(app, "GET", "/api/auth/me", cookie)).statusCode, 200);
    await db.owner.query("UPDATE admin_sessions SET last_seen_at = now() - interval '2 hours' WHERE user_id = $1", [u.id]);
    assert.equal((await call(app, "GET", "/api/auth/me", cookie)).statusCode, 401, "idle");
    const c2 = await signIn(app, u.email);
    await db.owner.query("UPDATE admin_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [c2.split("=")[1]]);
    assert.equal((await call(app, "GET", "/api/auth/me", c2)).statusCode, 401, "absolute expiry");
    const c3 = await signIn(app, u.email);
    await db.owner.query("UPDATE admin_users SET active = false WHERE id = $1", [u.id]);
    assert.equal((await call(app, "GET", "/api/auth/me", c3)).statusCode, 401, "inactive user");
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: JSON.stringify({ email: u.email, password: PASSWORD }) })).statusCode, 401);
  });

  it("the API login can read user columns but never the password hash, and cannot create users", async () => {
    const t = await createTenant(db.owner);
    await addUser(t);
    await assert.rejects(db.api.query("SELECT password_hash FROM admin_users"), /permission denied/);
    await assert.rejects(db.api.query("SELECT * FROM admin_users"), /permission denied/);
    await assert.rejects(withTenant(db.api, t.tenantId, (c) => c.query("INSERT INTO admin_users (tenant_id, email, name, role, password_hash) VALUES ($1,'x@y.z','x','pm','h')", [t.tenantId])), /permission denied/);
    const { rows } = await withTenant(db.api, t.tenantId, (c) => c.query("SELECT email, role FROM admin_users"));
    assert.equal(rows.length, 1);
    assert.equal((await db.api.query("SELECT count(*)::int AS n FROM admin_sessions")).rows[0].n, 0, "no tenant context, no rows");
  });

  it("logs never contain the password, the cookie or the token", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const u = await addUser(t);
    const cookie = await signIn(app, u.email);
    await app.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: JSON.stringify({ email: u.email, password: "WRONG-password-MARKER" }) });
    await call(app, "GET", "/api/members", cookie);
    const logged = lines.join("");
    for (const s of [PASSWORD, "WRONG-password-MARKER", cookie.split("=")[1]!]) assert.ok(!logged.includes(s));
  });
});

describe("configuration: members", () => {
  it("full round trip with audit rows that name fields, never values", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const cookie = await signIn(app, (await addUser(t)).email);
    const created = await call(app, "POST", "/api/members", cookie, { name: "Dana Designer", role: "designer", chatHandle: "dana" });
    assert.equal(created.statusCode, 201);
    const id = created.json().member.id;
    assert.deepEqual(created.json().member, { id, name: "Dana Designer", role: "designer", chatHandle: "dana", trackerHandle: null, timezone: "UTC", active: true });
    assert.equal((await call(app, "GET", `/api/members/${id}`, cookie)).json().member.name, "Dana Designer");
    const patched = await call(app, "PATCH", `/api/members/${id}`, cookie, { role: "developer", active: false });
    assert.deepEqual([patched.json().member.role, patched.json().member.active], ["developer", false]);
    assert.equal((await call(app, "DELETE", `/api/members/${id}`, cookie)).statusCode, 204);
    assert.equal((await call(app, "GET", `/api/members/${id}`, cookie)).statusCode, 404);
    const rows = await audits(t.tenantId);
    assert.deepEqual(rows.map((r) => r.action), ["members.create", "members.update", "members.delete"]);
    assert.ok(rows.every((r) => r.actor.startsWith("user:") && r.target === `members:${id}`));
    assert.deepEqual(rows[1].diff, { fields: ["role", "active"] });
    assert.ok(!JSON.stringify(rows).includes("Dana"), "audit rows carry no values");
  });

  it("validates strictly: unknown fields, bad enums, empty patches, bad ids", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const cookie = await signIn(app, (await addUser(t)).email);
    const id = randomUUID();
    for (const [method, url, body] of [
      ["POST", "/api/members", { name: "x", role: "boss" }], ["POST", "/api/members", { name: "x", role: "pm", tenantId: t.tenantId }],
      ["POST", "/api/members", { role: "pm" }], ["PATCH", `/api/members/${id}`, {}], ["PATCH", `/api/members/${id}`, { id: randomUUID() }],
      ["GET", "/api/members/not-a-uuid", undefined],
    ] as const) {
      const res = await call(app, method, url, cookie, body);
      assert.equal(res.statusCode, 400, `${method} ${url} ${JSON.stringify(body)}`);
      assert.ok(!/stack|at \S+ \(|SELECT|INSERT/.test(res.body));
    }
  });

  it("another tenant's members are invisible and unmodifiable through every route", async () => {
    const app = server();
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const memberOfA = await createMember(db.owner, a.tenantId);
    const cookieB = await signIn(app, (await addUser(b)).email);
    assert.equal((await call(app, "GET", "/api/members", cookieB)).json().items.some((m: { id: string }) => m.id === memberOfA), false);
    assert.equal((await call(app, "GET", `/api/members/${memberOfA}`, cookieB)).statusCode, 404);
    assert.equal((await call(app, "PATCH", `/api/members/${memberOfA}`, cookieB, { name: "pwned" })).statusCode, 404);
    assert.equal((await call(app, "DELETE", `/api/members/${memberOfA}`, cookieB)).statusCode, 404);
    assert.equal((await db.owner.query("SELECT name FROM members WHERE id = $1", [memberOfA])).rows[0].name, "m");
  });

  it("a non-pm user cannot write; nothing changes", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const cookie = await signIn(app, (await addUser(t, "developer")).email);
    assert.equal((await call(app, "GET", "/api/members", cookie)).statusCode, 200);
    assert.equal((await call(app, "POST", "/api/members", cookie, { name: "x", role: "pm" })).statusCode, 403);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM members WHERE tenant_id = $1", [t.tenantId])).rows[0].n, 0);
    assert.equal((await audits(t.tenantId)).length, 0);
  });

  it("writes without the CSRF header or from a foreign origin are refused", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const cookie = await signIn(app, (await addUser(t)).email);
    const body = JSON.stringify({ name: "x", role: "pm" });
    assert.equal((await app.inject({ method: "POST", url: "/api/members", headers: { cookie, "content-type": "application/json" }, payload: body })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/members", headers: { cookie, "content-type": "application/json", "x-requested-with": "relay-admin", origin: "https://evil.example" }, payload: body })).statusCode, 403);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM members WHERE tenant_id = $1", [t.tenantId])).rows[0].n, 0);
  });
});

describe("configuration: routing rules and SLA policies", () => {
  it("rules: create, list in order, patch, duplicate position is a 409, delete; isolation", async () => {
    const app = server();
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const cookie = await signIn(app, (await addUser(a)).email);
    const r1 = await call(app, "POST", "/api/routing-rules", cookie, { position: 2, condition: { category: "bug" }, action: { role: "developer" } });
    const r0 = await call(app, "POST", "/api/routing-rules", cookie, { position: 1, condition: {}, action: { role: "pm" }, enabled: false });
    assert.equal(r1.statusCode, 201);
    assert.deepEqual((await call(app, "GET", "/api/routing-rules", cookie)).json().items.map((r: { position: number }) => r.position), [1, 2]);
    assert.equal((await call(app, "POST", "/api/routing-rules", cookie, { position: 2, condition: {}, action: {} })).statusCode, 409);
    const id = r1.json().rule.id;
    assert.deepEqual((await call(app, "PATCH", `/api/routing-rules/${id}`, cookie, { enabled: false, action: { role: "tester" } })).json().rule, { id, position: 2, condition: { category: "bug" }, action: { role: "tester" }, enabled: false });
    assert.equal((await call(app, "POST", "/api/routing-rules", cookie, { position: 3, condition: { x: "y".repeat(5000) }, action: {} })).statusCode, 400);
    const cookieB = await signIn(app, (await addUser(b)).email);
    for (const [m, u, body] of [["GET", `/api/routing-rules/${id}`, undefined], ["PATCH", `/api/routing-rules/${id}`, { enabled: true }], ["DELETE", `/api/routing-rules/${id}`, undefined]] as const) {
      assert.equal((await call(app, m, u, cookieB, body)).statusCode, 404, `${m} other tenant`);
    }
    assert.equal((await call(app, "DELETE", `/api/routing-rules/${r0.json().rule.id}`, cookie)).statusCode, 204);
    assert.deepEqual((await audits(a.tenantId)).map((r) => r.action).slice(-1), ["routing_rules.delete"]);
  });

  it("SLA policies: list and edit the targets; other tenants cannot", async () => {
    const app = server();
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const cookie = await signIn(app, (await addUser(a)).email);
    const items = (await call(app, "GET", "/api/sla-policies", cookie)).json().items;
    assert.deepEqual(items.map((i: { priority: string }) => i.priority), ["P1", "P2", "P3", "P4"]);
    const p1 = items[0];
    const res = await call(app, "PATCH", `/api/sla-policies/${p1.id}`, cookie, { ackMinutes: 10 });
    assert.deepEqual([res.json().policy.ackMinutes, res.json().policy.resolveMinutes], [10, p1.resolveMinutes]);
    assert.equal((await call(app, "PATCH", `/api/sla-policies/${p1.id}`, cookie, { ackMinutes: 0 })).statusCode, 400);
    const cookieB = await signIn(app, (await addUser(b)).email);
    assert.equal((await call(app, "PATCH", `/api/sla-policies/${p1.id}`, cookieB, { ackMinutes: 1 })).statusCode, 404);
  });
});

describe("configuration: integrations, bots, chat connections", () => {
  it("integrations: create and toggle code-aware and approval policy; labels validated; isolation", async () => {
    const app = server();
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const cookie = await signIn(app, (await addUser(a)).email);
    const created = await call(app, "POST", "/api/integrations", cookie, { provider: "github", repoRef: "acme/shop", credentialsRef: "env:GITHUB_TOKEN", labelMap: { bug: ["type:bug"], P1: "urgent" } });
    assert.equal(created.statusCode, 201);
    const id = created.json().integration.id;
    assert.deepEqual([created.json().integration.approvalPolicy, created.json().integration.codeAwareEnabled, created.json().integration.credentialsRef], ["auto", false, "env:GITHUB_TOKEN"]);
    const patched = await call(app, "PATCH", `/api/integrations/${id}`, cookie, { codeAwareEnabled: true, approvalPolicy: "human", repoRef: "acme/shop2" });
    assert.deepEqual([patched.json().integration.codeAwareEnabled, patched.json().integration.approvalPolicy, patched.json().integration.repoRef], [true, "human", "acme/shop2"]);
    for (const bad of [{ repoRef: "not a repo" }, { approvalPolicy: "maybe" }, { labelMap: { a: 5 } }, { provider: "jira" }, { credentialsRef: "ghp_1234567890abcdefghijklmnopqrstuvwxyz" }]) {
      assert.equal((await call(app, "PATCH", `/api/integrations/${id}`, cookie, bad)).statusCode, 400, JSON.stringify(bad));
    }
    const cookieB = await signIn(app, (await addUser(b)).email);
    assert.equal((await call(app, "GET", `/api/integrations/${id}`, cookieB)).statusCode, 404);
    assert.equal((await call(app, "PATCH", `/api/integrations/${id}`, cookieB, { codeAwareEnabled: false })).statusCode, 404);
    assert.equal((await call(app, "GET", "/api/integrations", cookieB)).json().items.length, 0);
  });

  it("bots: register, rename, revoke; credentials are references only; the webhook secret hash is never returned", async () => {
    const app = server();
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const cookie = await signIn(app, (await addUser(a)).email);
    const seeded = randomUUID();
    await db.owner.query("INSERT INTO bots (id, tenant_id, channel, display_name, status, credentials_ref, webhook_secret_hash, webhook_url) VALUES ($1,$2,'telegram','Seeded','active','env:SEEDED_TOKEN','aaaa1111deadbeefHASHMARKER','https://x.example/webhooks/telegram/1')", [seeded, a.tenantId]);
    const created = await call(app, "POST", "/api/bots", cookie, { channel: "telegram", displayName: "Support", credentialsRef: "env:SUPPORT_BOT_TOKEN" });
    assert.equal(created.statusCode, 201);
    assert.deepEqual([created.json().bot.status, created.json().bot.credentialsRef], ["pending", "env:SUPPORT_BOT_TOKEN"]);
    for (const raw of ["123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11", "env:lowercase", "env:", "SUPPORT_BOT_TOKEN", "env:BOT TOKEN"]) {
      const res = await call(app, "POST", "/api/bots", cookie, { channel: "telegram", displayName: "x", credentialsRef: raw });
      assert.equal(res.statusCode, 400, raw);
      assert.ok(!res.body.includes("ABC-DEF"), "the rejected value must not be echoed back");
    }
    const id = created.json().bot.id;
    assert.equal((await call(app, "PATCH", `/api/bots/${id}`, cookie, { displayName: "Support v2" })).json().bot.displayName, "Support v2");
    const list = await call(app, "GET", "/api/bots", cookie);
    assert.ok(!list.body.includes("HASHMARKER") && !/webhook_secret|webhookSecret|secretHash|password|token\b/i.test(list.body.replace(/env:[A-Z_]+/g, "")), "no secret material in the response");
    assert.equal((await call(app, "DELETE", `/api/bots/${id}`, cookie)).json().bot.status, "revoked");
    const cookieB = await signIn(app, (await addUser(b)).email);
    for (const [m, body] of [["GET", undefined], ["PATCH", { displayName: "x" }], ["DELETE", undefined]] as const) assert.equal((await call(app, m, `/api/bots/${seeded}`, cookieB, body)).statusCode, 404);
    assert.equal((await db.owner.query("SELECT status FROM bots WHERE id = $1", [seeded])).rows[0].status, "active");
    const rows = await audits(a.tenantId);
    assert.ok(rows.some((r) => r.action === "bots.create") && rows.some((r) => r.action === "bots.revoke"));
    assert.ok(!JSON.stringify(rows).includes("SUPPORT_BOT_TOKEN"), "not even credential names go into audit values");
  });

  it("chat connections are readable and tenant-scoped", async () => {
    const app = server();
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const cid = randomUUID();
    await db.owner.query("INSERT INTO chat_connections (id, tenant_id, provider, workspace_ref, credentials_ref) VALUES ($1,$2,'mattermost','ws','env:MM_TOKEN')", [cid, a.tenantId]);
    const cookieA = await signIn(app, (await addUser(a)).email);
    const cookieB = await signIn(app, (await addUser(b)).email);
    assert.equal((await call(app, "GET", `/api/chat-connections/${cid}`, cookieA)).json().chatConnection.credentialsRef, "env:MM_TOKEN");
    assert.equal((await call(app, "GET", `/api/chat-connections/${cid}`, cookieB)).statusCode, 404);
    assert.equal((await call(app, "GET", "/api/chat-connections", cookieB)).json().items.length, 0);
  });

  it("no configuration response ever carries a key that looks like a secret", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    await db.owner.query("INSERT INTO bots (tenant_id, channel, display_name, credentials_ref, webhook_secret_hash) VALUES ($1,'telegram','b','env:T_TOKEN','hashvalue')", [t.tenantId]);
    await db.owner.query("INSERT INTO integrations (tenant_id, provider, credentials_ref) VALUES ($1,'github','env:GH_TOKEN')", [t.tenantId]);
    const cookie = await signIn(app, (await addUser(t)).email);
    const keys = new Set<string>();
    const walk = (v: unknown) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
    for (const url of ["/api/bots", "/api/integrations", "/api/chat-connections", "/api/members", "/api/routing-rules", "/api/sla-policies", "/api/auth/me"]) walk((await call(app, "GET", url, cookie)).json());
    for (const k of keys) assert.ok(!/secret|password|hash|apikey|api_key|^token$/i.test(k), `suspicious key ${k}`);
  });
});

describe("seed", () => {
  it("creates the admin only when the environment provides it, hashes the password, and is repeatable", async () => {
    const { seed, seedAdmin, DEMO_TENANT_ID } = await import("@relay/db");
    await seed(db.owner);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM admin_users WHERE tenant_id = $1", [DEMO_TENANT_ID])).rows[0].n, 0, "no default admin");
    await seedAdmin(db.owner, DEMO_TENANT_ID, "Boss@Example.com", PASSWORD);
    await seedAdmin(db.owner, DEMO_TENANT_ID, "boss@example.com", PASSWORD);
    const rows = (await db.owner.query("SELECT email, role, password_hash FROM admin_users WHERE tenant_id = $1", [DEMO_TENANT_ID])).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].email, rows[0].role], ["boss@example.com", "pm"]);
    assert.match(rows[0].password_hash, /^scrypt\$N=32768,r=8,p=1\$/);
    assert.ok(!rows[0].password_hash.includes(PASSWORD));
  });
});
