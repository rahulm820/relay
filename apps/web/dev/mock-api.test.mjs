import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TICKET_STATUSES, TICKET_TRANSITIONS } from "@relay/shared/browser";
import { MOCK_PASSWORD, TRANSITIONS, createMockServer, resetMock, tickets } from "./mock-api.mjs";

let base;
let server;
let cookie = "";
before(async () => {
  resetMock();
  server = createMockServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const call = (method, path, body, { csrf = true, authed = true, headers = {} } = {}) =>
  fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(csrf && method !== "GET" ? { "x-requested-with": "relay-admin" } : {}), ...(authed && cookie ? { cookie } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

test("mock transition table equals @relay/shared TICKET_TRANSITIONS", () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...TICKET_STATUSES].sort());
  for (const s of TICKET_STATUSES) assert.deepEqual([...TRANSITIONS[s]].sort(), [...TICKET_TRANSITIONS[s]].sort(), s);
});

test("login: wrong password is 401, right one sets an HttpOnly Path=/api cookie, no token in the body", async () => {
  let r = await call("POST", "/api/auth/login", { email: "a@b.co", password: "nope" }, { authed: false });
  assert.equal(r.status, 401);
  r = await call("POST", "/api/auth/login", { email: "a@b.co", password: MOCK_PASSWORD }, { authed: false });
  assert.equal(r.status, 200);
  const set = r.headers.get("set-cookie");
  assert.match(set, /^relay_session=[\w-]{43}; .*Path=\/api; HttpOnly; SameSite=Lax/);
  cookie = set.split(";")[0];
  const body = await r.json();
  assert.ok(!JSON.stringify(body).includes(cookie.split("=")[1]));
});

test("401 without a session; csrf_failed without the header; 429 after repeated failures", async () => {
  assert.equal((await call("GET", "/api/tickets", undefined, { authed: false })).status, 401);
  const r = await call("POST", "/api/tickets/x/transition", { to: "triaged" }, { csrf: false });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "csrf_failed");
  let last;
  for (let i = 0; i < 6; i++) last = await call("POST", "/api/auth/login", { email: "x@y.co", password: "bad" }, { authed: false });
  assert.equal(last.status, 429);
  assert.equal(last.headers.get("retry-after"), "30");
});

test("list: filters, limit and cursor paging cover every ticket once", async () => {
  const all = [];
  let cursor = "";
  do {
    const r = await call("GET", `/api/tickets?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
    const j = await r.json();
    all.push(...j.items.map((t) => t.id));
    cursor = j.nextCursor ?? "";
  } while (cursor);
  assert.equal(new Set(all).size, tickets.length);
  assert.equal(all.length, tickets.length);
  const p1 = await (await call("GET", "/api/tickets?priority=P1")).json();
  assert.ok(p1.items.length > 0 && p1.items.every((t) => t.priority === "P1"));
  assert.equal((await call("GET", "/api/tickets?limit=101")).status, 400);
});

test("transition enforces the table, compare-and-set, and records an event", async () => {
  const t = tickets.find((x) => x.status === "received" || x.status === "quarantined");
  assert.ok(t);
  const before = t.status;
  let r = await call("POST", `/api/tickets/${t.id}/transition`, { to: "closed" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "illegal_transition");
  r = await call("POST", `/api/tickets/${t.id}/transition`, { to: "triaged", from: before === "quarantined" ? "received" : "quarantined" });
  assert.equal((await r.json()).error, "status_conflict");
  r = await call("POST", `/api/tickets/${t.id}/transition`, { to: "triaged", from: before, reason: "ok" });
  assert.equal(r.status, 200);
  const d = await (await call("GET", `/api/tickets/${t.id}`)).json();
  assert.equal(d.ticket.status, "triaged");
  assert.deepEqual(d.events.at(-1).payload, { from: before, to: "triaged", reason: "ok" });
  assert.equal((await call("GET", "/api/tickets/nope")).status, 404);
});

test("patch priority and assignee write timeline events", async () => {
  const t = tickets.find((x) => x.status === "triaged");
  const r = await call("PATCH", `/api/tickets/${t.id}`, { priority: t.priority === "P1" ? "P2" : "P1", assigneeId: "7d1c0000-0000-4000-8000-000000000002" });
  assert.equal(r.status, 200);
  const types = (await (await call("GET", `/api/tickets/${t.id}`)).json()).events.map((e) => e.type);
  assert.ok(types.includes("priority_changed") && types.includes("assignee_changed"));
  assert.equal((await call("PATCH", `/api/tickets/${t.id}`, { tenantId: "x" })).status, 400);
});

test("logout clears the session", async () => {
  assert.equal((await call("POST", "/api/auth/logout")).status, 204);
  assert.equal((await call("GET", "/api/auth/me")).status, 401);
});
