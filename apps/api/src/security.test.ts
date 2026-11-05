import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import Fastify from "fastify";
import { registerApiSecurity } from "./security.js";

const UI = "http://localhost:3000";
let apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.map((a) => a.close())); apps = []; });

function app() {
  const a = Fastify();
  registerApiSecurity(a, { allowedOrigins: [UI] });
  a.get("/api/x", async () => ({ ok: 1 }));
  a.post("/api/x", async () => ({ done: 1 }));
  a.post("/webhooks/x", async () => ({ hook: 1 }));
  apps.push(a);
  return a;
}
const post = (a: ReturnType<typeof Fastify>, headers: Record<string, string>, url = "/api/x") =>
  a.inject({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload: "{}" });

describe("CSRF", () => {
  it("rejects a state-changing request without the custom header", async () => {
    const res = await post(app(), { origin: UI });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "csrf_failed" });
  });
  it("rejects the header with a foreign Origin", async () => {
    assert.equal((await post(app(), { "x-requested-with": "relay-admin", origin: "https://evil.example" })).statusCode, 403);
  });
  it("rejects a wrong header value", async () => {
    assert.equal((await post(app(), { "x-requested-with": "XMLHttpRequest" })).statusCode, 403);
  });
  it("accepts the header from an allowed origin, and from a non-browser client with no Origin", async () => {
    assert.equal((await post(app(), { "x-requested-with": "relay-admin", origin: UI })).statusCode, 200);
    assert.equal((await post(app(), { "x-requested-with": "relay-admin" })).statusCode, 200);
  });
  it("covers PATCH, PUT and DELETE too, and leaves GET alone", async () => {
    const a = Fastify();
    registerApiSecurity(a, { allowedOrigins: [UI] });
    for (const m of ["patch", "put", "delete"] as const) a[m]("/api/y", async () => ({}));
    a.get("/api/y", async () => ({}));
    apps.push(a);
    for (const method of ["PATCH", "PUT", "DELETE"] as const) assert.equal((await a.inject({ method, url: "/api/y" })).statusCode, 403, method);
    assert.equal((await a.inject({ method: "GET", url: "/api/y" })).statusCode, 200);
  });
  it("does not touch routes outside /api (the signed Telegram webhook has its own check)", async () => {
    assert.equal((await post(app(), {}, "/webhooks/x")).statusCode, 200);
  });
});

describe("CORS", () => {
  it("answers an allowed origin with credentials and no wildcard", async () => {
    const res = await app().inject({ method: "GET", url: "/api/x", headers: { origin: UI } });
    assert.equal(res.headers["access-control-allow-origin"], UI);
    assert.equal(res.headers["access-control-allow-credentials"], "true");
    assert.equal(res.headers["vary"], "Origin");
  });
  it("gives other origins no CORS headers at all", async () => {
    const res = await app().inject({ method: "GET", url: "/api/x", headers: { origin: "https://evil.example" } });
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.equal(res.headers["access-control-allow-credentials"], undefined);
  });
  it("answers a preflight for an allowed origin and refuses one for a foreign origin", async () => {
    const ok = await app().inject({ method: "OPTIONS", url: "/api/x", headers: { origin: UI, "access-control-request-method": "POST" } });
    assert.equal(ok.statusCode, 204);
    assert.match(String(ok.headers["access-control-allow-headers"]), /x-requested-with/);
    assert.equal(ok.headers["access-control-allow-origin"], UI);
    const no = await app().inject({ method: "OPTIONS", url: "/api/x", headers: { origin: "https://evil.example" } });
    assert.equal(no.statusCode, 403);
    assert.equal(no.headers["access-control-allow-origin"], undefined);
  });
});
