import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Pool } from "@relay/db";
import { parseEncryptionKey } from "@relay/shared";
import { buildServer } from "./server.js";
import { COOKIE_NAME, LoginThrottle, hashToken } from "./session.js";
import { MemoryAuthStore } from "./testing/memory-auth-store.js";

// The auth routes run here against an in-memory store (no database). Role, tenant and configuration routes that
// need Postgres are in admin.test.ts.
const UI = "http://localhost:3000";
const PASSWORD = "S3cret-Passw0rd-MARKER";
let store: MemoryAuthStore;
let lines: string[] = [];
let app: ReturnType<typeof buildServer>;
let throttle: LoginThrottle;
const logStream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });

beforeEach(async () => {
  lines = [];
  store = new MemoryAuthStore();
  await store.addUser("Admin@Example.com", PASSWORD);
  throttle = new LoginThrottle({ maxPerAccount: 3, maxPerIp: 50, windowMs: 60_000, now: () => store.time });
  app = buildServer({
    pool: {} as Pool, producer: { enqueue: async () => ({ entryId: "x", duplicate: false }) }, encryptionKey: parseEncryptionKey(Buffer.alloc(32, 1).toString("base64")),
    authStore: store, throttle, logStream, logLevel: "trace",
    admin: { allowedOrigins: [UI], sessionTtlHours: 2, sessionIdleMinutes: 30, cookieSecure: false },
  });
});
afterEach(async () => { await app.close(); });

const H = { "content-type": "application/json", "x-requested-with": "relay-admin", origin: UI };
const login = (email: string, password: string, extra: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/auth/login", headers: { ...H, ...extra }, payload: JSON.stringify({ email, password }) });
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;
const me = (cookie?: string) => app.inject({ method: "GET", url: "/api/auth/me", headers: cookie ? { cookie } : {} });

describe("login", () => {
  it("sets a hardened session cookie and puts no token in the body", async () => {
    const res = await login("admin@example.com", PASSWORD);
    assert.equal(res.statusCode, 200);
    const setCookie = String(res.headers["set-cookie"]);
    for (const attr of [`${COOKIE_NAME}=`, "Max-Age=7200", "Path=/api", "HttpOnly", "SameSite=Lax"]) assert.ok(setCookie.includes(attr), attr);
    const token = setCookie.split(";")[0]!.split("=")[1]!;
    assert.ok(!res.body.includes(token), "the token must not be in the body");
    assert.deepEqual(Object.keys(res.json()).sort(), ["tenant", "user"]);
    assert.deepEqual(res.json().user, { id: res.json().user.id, email: "admin@example.com", name: "Admin", role: "pm" });
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(store.sessions.length, 1);
    assert.equal(store.sessions[0]!.hash, hashToken(token), "only the hash is stored");
    assert.ok(!JSON.stringify(store.sessions).includes(token));
    assert.ok(store.audits.some((a) => a.action === "auth.login"));
  });

  it("accepts the email in any case", async () => {
    assert.equal((await login("ADMIN@EXAMPLE.COM", PASSWORD)).statusCode, 200);
  });

  it("answers wrong password, unknown email and a disabled account with the identical 401", async () => {
    await store.addUser("off@example.com", PASSWORD, { active: false });
    const results = await Promise.all([login("admin@example.com", "wrong"), login("nobody@example.com", "wrong"), login("off@example.com", PASSWORD)]);
    for (const r of results) {
      assert.equal(r.statusCode, 401);
      assert.equal(r.headers["set-cookie"], undefined);
    }
    assert.equal(new Set(results.map((r) => r.body)).size, 1, "identical bodies");
    assert.deepEqual(results[0]!.json(), { error: "invalid_credentials", message: "invalid email or password" });
  });

  it("throttles repeated failures per account, then recovers", async () => {
    for (let i = 0; i < 3; i++) assert.equal((await login("admin@example.com", "wrong")).statusCode, 401);
    const blocked = await login("admin@example.com", PASSWORD); // even the right password is refused while blocked
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error, "too_many_attempts");
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    const unknown = [1, 2, 3].map(() => login("ghost@example.com", "x"));
    await Promise.all(unknown);
    assert.equal((await login("ghost@example.com", "x")).statusCode, 429, "unknown accounts are throttled the same way");
    store.advance(61_000);
    assert.equal((await login("admin@example.com", PASSWORD)).statusCode, 200);
  });

  it("validates input strictly", async () => {
    for (const payload of [{}, { email: "a@b.co" }, { email: "a@b.co", password: "x", extra: 1 }, { email: "x".repeat(300) + "@a.co", password: "x" }, { email: "a@b.co", password: "x".repeat(300) }, { email: 5, password: "x" }]) {
      const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: JSON.stringify(payload) });
      assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 60));
      assert.ok(!/stack|at \S+ \(|node_modules/.test(res.body));
    }
  });

  it("rotates: logging in again with a cookie ends the old session", async () => {
    const first = cookieOf(await login("admin@example.com", PASSWORD));
    const second = cookieOf(await login("admin@example.com", PASSWORD, { cookie: first }));
    assert.notEqual(first, second);
    assert.equal((await me(first)).statusCode, 401);
    assert.equal((await me(second)).statusCode, 200);
  });
});

describe("session", () => {
  it("me works with the cookie and returns 401 without it", async () => {
    const cookie = cookieOf(await login("admin@example.com", PASSWORD));
    const res = await me(cookie);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().tenant.name, "Demo Co");
    assert.deepEqual(res.json().user.role, "pm");
    assert.equal((await me()).statusCode, 401);
    assert.deepEqual((await me()).json(), { error: "unauthorized" });
  });

  it("logout revokes it server-side: the old cookie then fails", async () => {
    const cookie = cookieOf(await login("admin@example.com", PASSWORD));
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...H, cookie } });
    assert.equal(out.statusCode, 204);
    assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
    assert.equal((await me(cookie)).statusCode, 401);
    assert.ok(store.audits.some((a) => a.action === "auth.logout"));
  });

  it("logout without a session is harmless", async () => {
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: H })).statusCode, 204);
  });

  it("expires after the absolute lifetime even when used constantly", async () => {
    const cookie = cookieOf(await login("admin@example.com", PASSWORD));
    for (let i = 0; i < 5; i++) { store.advance(20 * 60_000); assert.equal((await me(cookie)).statusCode, 200, `at ${(i + 1) * 20} min`); }
    store.advance(20 * 60_000); // 120 minutes: the 2-hour absolute limit is reached
    assert.equal((await me(cookie)).statusCode, 401);
  });

  it("expires when idle, but activity keeps it alive", async () => {
    const cookie = cookieOf(await login("admin@example.com", PASSWORD));
    store.advance(29 * 60_000);
    assert.equal((await me(cookie)).statusCode, 200);
    store.advance(29 * 60_000);
    assert.equal((await me(cookie)).statusCode, 200, "still alive: it was used 29 minutes ago");
    store.advance(31 * 60_000);
    assert.equal((await me(cookie)).statusCode, 401, "idle for more than 30 minutes");
  });

  it("rejects tampered, random, truncated and well-shaped but unknown tokens", async () => {
    const good = cookieOf(await login("admin@example.com", PASSWORD));
    const token = good.split("=")[1]!;
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const bad of [`${COOKIE_NAME}=${flipped}`, `${COOKIE_NAME}=${"A".repeat(43)}`, `${COOKIE_NAME}=abc`, `${COOKIE_NAME}=`, "other=1", `${COOKIE_NAME}=${token}extra`]) {
      assert.equal((await me(bad)).statusCode, 401, bad.slice(0, 30));
    }
  });

  it("a disabled user's live session stops working", async () => {
    const cookie = cookieOf(await login("admin@example.com", PASSWORD));
    store.users.get("admin@example.com")!.active = false;
    assert.equal((await me(cookie)).statusCode, 401);
  });
});

describe("browser protections on the auth routes", () => {
  it("login and logout need the CSRF header and an allowed origin", async () => {
    const noHeader = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json", origin: UI }, payload: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
    assert.equal(noHeader.statusCode, 403);
    const foreign = await login("admin@example.com", PASSWORD, { origin: "https://evil.example" });
    assert.equal(foreign.statusCode, 403);
    assert.equal(foreign.headers["set-cookie"], undefined);
    assert.equal(store.sessions.length, 0, "a blocked request must not create a session");
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { "content-type": "application/json", origin: UI } })).statusCode, 403);
  });

  it("only the allow-listed origin gets CORS headers, with credentials", async () => {
    const ok = await login("admin@example.com", PASSWORD);
    assert.equal(ok.headers["access-control-allow-origin"], UI);
    assert.equal(ok.headers["access-control-allow-credentials"], "true");
    const pre = await app.inject({ method: "OPTIONS", url: "/api/auth/login", headers: { origin: UI } });
    assert.equal(pre.statusCode, 204);
    const evil = await app.inject({ method: "GET", url: "/api/auth/me", headers: { origin: "https://evil.example" } });
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
  });
});

describe("protected routes", () => {
  it("the ticket and configuration routes answer 401 without a session", async () => {
    for (const [method, url] of [["GET", "/api/tickets"], ["GET", "/api/members"], ["GET", "/api/bots"], ["GET", "/api/integrations"], ["GET", "/api/routing-rules"], ["GET", "/api/sla-policies"], ["GET", "/api/chat-connections"]] as const) {
      const res = await app.inject({ method, url });
      assert.equal(res.statusCode, 401, url);
      assert.deepEqual(res.json(), { error: "unauthorized" });
    }
    for (const [url, payload] of [["/api/members", { name: "x", role: "pm" }], ["/api/bots", {}]] as const) {
      const res = await app.inject({ method: "POST", url, headers: H, payload: JSON.stringify(payload) });
      assert.equal(res.statusCode, 401, url);
    }
  });

  it("a non-pm session can read but not write configuration (403, before any database access)", async () => {
    await store.addUser("dev@example.com", PASSWORD, { role: "developer" });
    const cookie = cookieOf(await login("dev@example.com", PASSWORD));
    for (const [method, url, body] of [
      ["POST", "/api/members", { name: "x", role: "pm" }], ["PATCH", "/api/members/00000000-0000-4000-8000-000000000001", { name: "y" }],
      ["DELETE", "/api/members/00000000-0000-4000-8000-000000000001", undefined], ["POST", "/api/bots", { channel: "telegram", displayName: "b", credentialsRef: "env:X_TOKEN" }],
      ["PATCH", "/api/integrations/00000000-0000-4000-8000-000000000001", { approvalPolicy: "human" }],
    ] as const) {
      const res = await app.inject({ method, url, headers: { ...H, cookie }, ...(body ? { payload: JSON.stringify(body) } : {}) });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.equal(res.json().error, "forbidden");
    }
  });
});

describe("logging", () => {
  it("never records the password, the session token or the cookie", async () => {
    const res = await login("admin@example.com", PASSWORD);
    const cookie = cookieOf(res);
    const token = cookie.split("=")[1]!;
    await login("admin@example.com", "another-WRONG-password-MARKER");
    await me(cookie);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...H, cookie } });
    const logged = lines.join("");
    assert.ok(logged.length > 0);
    for (const secret of [PASSWORD, "another-WRONG-password-MARKER", token, hashToken(token)]) assert.ok(!logged.includes(secret), "log leaked a secret");
  });
});
