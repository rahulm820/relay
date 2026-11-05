import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ApiRequestError, api, mapApiError } from "./api";

const kinds = (s: number, b: unknown, ra?: string | null) => mapApiError(s, b, ra);

test("error mapping: 401 means the session ended", () => {
  const e = kinds(401, { error: "unauthorized" });
  assert.equal(e.kind, "unauthorized");
});

test("error mapping: 403 csrf_failed differs from forbidden", () => {
  assert.equal(kinds(403, { error: "csrf_failed" }).kind, "csrf");
  assert.equal(kinds(403, { error: "forbidden" }).kind, "forbidden");
  assert.equal(kinds(403, null).kind, "forbidden");
});

test("error mapping: 409 illegal_transition vs status_conflict", () => {
  assert.equal(kinds(409, { error: "illegal_transition", message: "cannot move from closed to triaged" }).kind, "illegal_transition");
  assert.equal(kinds(409, { error: "status_conflict", message: "ticket is triaged, not received" }).kind, "status_conflict");
  assert.equal(kinds(409, { error: "illegal_transition", message: "x" }).message, "x");
});

test("error mapping: 429 carries Retry-After seconds", () => {
  assert.equal(kinds(429, { error: "too_many_attempts" }, "42").retryAfter, 42);
  assert.equal(kinds(429, { error: "too_many_attempts" }, "1.2").retryAfter, 2);
  assert.equal(kinds(429, { error: "too_many_attempts" }, "garbage").retryAfter, undefined);
  assert.equal(kinds(429, {}, null).kind, "throttled");
});

test("error mapping: other statuses", () => {
  assert.equal(kinds(404, { error: "not_found" }).kind, "not_found");
  assert.equal(kinds(400, { error: "validation_error", message: "invalid field(s): to" }).kind, "validation");
  assert.equal(kinds(503, { error: "unavailable" }).kind, "server");
  assert.equal(kinds(500, "<html>").kind, "server");
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("client: network failure maps to kind network", async () => {
  globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
  await assert.rejects(api.me(), (e: ApiRequestError) => e.kind === "network");
});

test("client: non-GET sends the CSRF header and credentials; GET does not need it", async () => {
  const seen: RequestInit[] = [];
  globalThis.fetch = ((_: string, init: RequestInit) => { seen.push(init); return Promise.resolve(new Response(null, { status: 204 })); }) as typeof fetch;
  await api.logout();
  const h = seen[0]!.headers as Record<string, string>;
  assert.equal(h["X-Requested-With"], "relay-admin");
  assert.equal(seen[0]!.credentials, "include");
  globalThis.fetch = ((_: string, init: RequestInit) => { seen.push(init); return Promise.resolve(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })); }) as typeof fetch;
  await api.listTickets();
  assert.equal((seen[1]!.headers as Record<string, string>)["X-Requested-With"], undefined);
  assert.equal(seen[1]!.credentials, "include");
});

test("client: a malformed success body is a contract error, not a crash", async () => {
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ nope: 1 }), { status: 200 }))) as typeof fetch;
  await assert.rejects(api.me(), (e: ApiRequestError) => e.kind === "contract");
});

test("client: transition sends from for compare-and-set", async () => {
  let body = "";
  globalThis.fetch = ((_: string, init: RequestInit) => { body = String(init.body); return Promise.resolve(new Response(JSON.stringify({ error: "status_conflict", message: "m" }), { status: 409 })); }) as typeof fetch;
  await assert.rejects(api.transition("id1", "triaged", "received", "why"), (e: ApiRequestError) => e.kind === "status_conflict");
  assert.deepEqual(JSON.parse(body), { to: "triaged", from: "received", reason: "why" });
});
