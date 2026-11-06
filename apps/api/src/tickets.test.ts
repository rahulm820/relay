import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { after, afterEach, before, describe, it } from "node:test";
import { QueueProducer, Redis, createTicketsForMessage, type NewTicket } from "@relay/core";
import { createMessage, createMember, createTenant, createTestDb, TEST_REDIS_URL, type TestDb, type TestTenant } from "@relay/core/testing";
import { withTenant } from "@relay/db";
import { parseEncryptionKey, TICKET_STATUSES } from "@relay/shared";
import type { Authenticator } from "./auth.js";
import { buildServer } from "./server.js";

const MARKER = "PERSONAL-DATA-MARKER";
let db: TestDb;
let redis: Redis;
let apps: ReturnType<typeof buildServer>[] = [];
let lines: string[] = [];
const logStream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });

before(async () => { db = await createTestDb(); redis = new Redis(TEST_REDIS_URL); });
after(async () => { await redis.quit(); await db.dispose(); });
afterEach(async () => { await Promise.all(apps.map((a) => a.close())); apps = []; });

/** TEST-ONLY authenticator: the tenant comes from a header. Production never does this. */
const testAuth: Authenticator = async (req) => {
  const tenantId = req.headers["x-test-tenant"];
  return typeof tenantId === "string"
    ? { tenantId, userId: "00000000-0000-4000-8000-0000000000aa", email: "t@example.test", name: "Tester", role: "pm", actor: { type: "human", ref: "api-tester" } }
    : null;
};
function server(auth: "test" | "default" = "test") {
  lines = [];
  const app = buildServer({
    pool: db.api, producer: new QueueProducer(redis), encryptionKey: parseEncryptionKey(Buffer.alloc(32, 1).toString("base64")),
    logStream, logLevel: "trace", ...(auth === "test" && { authenticate: testAuth }),
  });
  apps.push(app);
  return app;
}
const call = (app: ReturnType<typeof buildServer>, method: "GET" | "POST" | "PATCH", url: string, tenant: TestTenant | string | null, body?: unknown) =>
  app.inject({
    method, url,
    headers: {
      ...(tenant ? { "x-test-tenant": typeof tenant === "string" ? tenant : tenant.tenantId } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-requested-with": "relay-admin" } : {}), // the CSRF header every browser call must send
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });

async function makeTickets(t: TestTenant, specs: Partial<NewTicket>[]): Promise<string[]> {
  const messageId = await createMessage(db.owner, t);
  const created = await withTenant(db.worker, t.tenantId, (c) => createTicketsForMessage(c, {
    tenantId: t.tenantId, messageId, traceId: "x", actor: { type: "system", ref: "test" },
    tickets: specs.map((s, i): NewTicket => ({
      issueIndex: i, title: `Ticket ${MARKER} ${i}`, summary: "", category: "bug", priority: "P3", priorityReason: "r", prioritySource: "rules", outbox: false, ...s,
    })),
  }));
  return created.map((c) => c.ticketId);
}
const noTrace = (body: string) => assert.ok(!/stack|at \S+ \(|node_modules|\.ts:/.test(body), `leaks internals: ${body.slice(0, 200)}`);

describe("authentication", () => {
  it("rejects every route without a principal", async () => {
    const app = server();
    const id = randomUUID();
    for (const [m, u, b] of [["GET", "/api/tickets"], ["GET", `/api/tickets/${id}`], ["PATCH", `/api/tickets/${id}`, { priority: "P1" }], ["POST", `/api/tickets/${id}/transition`, { to: "triaged" }], ["POST", `/api/tickets/${id}/github-sync/approve`]] as const) {
      const res = await call(app, m, u, null, b);
      assert.equal(res.statusCode, 401, `${m} ${u}`);
      assert.deepEqual(res.json(), { error: "unauthorized" });
    }
  });

  it("denies everything by default when no authenticator is plugged in", async () => {
    const app = server("default");
    const t = await createTenant(db.owner);
    assert.equal((await app.inject({ method: "GET", url: "/api/tickets", headers: { "x-test-tenant": t.tenantId } })).statusCode, 401);
  });

  it("the tenant cannot be chosen through the query string or body", async () => {
    const app = server();
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const [id] = await makeTickets(b, [{}]);
    assert.equal((await call(app, "GET", `/api/tickets?tenantId=${b.tenantId}`, a)).statusCode, 400);
    assert.equal((await call(app, "PATCH", `/api/tickets/${id}`, a, { tenantId: b.tenantId, priority: "P1" })).statusCode, 400);
    assert.equal((await call(app, "GET", `/api/tickets/${id}`, a)).statusCode, 404);
  });
});

describe("reading", () => {
  it("lists, filters and pages; gets with events", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const ids = await makeTickets(t, [{ priority: "P1" }, { priority: "P3", category: "ui" }, { priority: "P3" }, { priority: "P4", category: "feature" }, { priority: "P3" }]);
    const all: string[] = [];
    let url = "/api/tickets?limit=2";
    for (let i = 0; i < 6; i++) {
      const res = await call(app, "GET", url, t);
      assert.equal(res.statusCode, 200);
      const body = res.json();
      all.push(...body.items.map((x: { id: string }) => x.id));
      if (!body.nextCursor) break;
      url = `/api/tickets?limit=2&cursor=${encodeURIComponent(body.nextCursor)}`;
    }
    assert.equal(new Set(all).size, 5);
    assert.deepEqual([...all].sort(), [...ids].sort());
    assert.equal((await call(app, "GET", "/api/tickets?priority=P1", t)).json().items.length, 1);
    assert.equal((await call(app, "GET", "/api/tickets?category=ui&status=received", t)).json().items.length, 1);
    const one = await call(app, "GET", `/api/tickets/${ids[0]}`, t);
    assert.equal(one.statusCode, 200);
    const { ticket, events } = one.json();
    assert.deepEqual([ticket.id, ticket.status, ticket.priority], [ids[0], "received", "P1"]);
    assert.deepEqual(events.map((e: { type: string }) => e.type), ["created"]);
    assert.ok(ticket.createdAt && "switchRoomRef" in ticket && "trackerRef" in ticket);
  });

  it("rejects bad input with a generic 400 and no internals", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    for (const url of ["/api/tickets/not-a-uuid", "/api/tickets?limit=500", "/api/tickets?limit=0", "/api/tickets?status=nope", "/api/tickets?cursor=garbage", "/api/tickets?unknown=1"]) {
      const res = await call(app, "GET", url, t);
      assert.equal(res.statusCode, 400, url);
      noTrace(res.body);
      assert.equal(res.json().error === "validation_error" || res.json().error === "invalid_cursor", true, url);
    }
  });
});

describe("changing tickets", () => {
  it("transitions legally, rejects illegal moves with 409, and honours the expected status", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const [id] = await makeTickets(t, [{}]);
    const ok = await call(app, "POST", `/api/tickets/${id}/transition`, t, { to: "triaged", reason: "looks fine" });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().ticket.status, "triaged");
    const illegal = await call(app, "POST", `/api/tickets/${id}/transition`, t, { to: "resolved" });
    assert.equal(illegal.statusCode, 409);
    assert.deepEqual(illegal.json(), { error: "illegal_transition", message: "cannot move from triaged to resolved" });
    const stale = await call(app, "POST", `/api/tickets/${id}/transition`, t, { to: "assigned", from: "received" });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, "status_conflict");
    const detail = (await call(app, "GET", `/api/tickets/${id}`, t)).json();
    assert.deepEqual(detail.events.map((e: { type: string }) => e.type), ["created", "status_changed"]);
  });

  it("resolved -> in_progress is a 409 for every route that changes status", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const [id] = await makeTickets(t, [{}]);
    await db.owner.query("UPDATE tickets SET status = 'resolved' WHERE id = $1", [id]);
    assert.equal((await call(app, "POST", `/api/tickets/${id}/transition`, t, { to: "in_progress" })).statusCode, 409);
    assert.equal((await call(app, "PATCH", `/api/tickets/${id}`, t, { status: "in_progress" })).statusCode, 409);
  });

  it("every status is accepted by validation (the state machine decides, not the schema)", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const [id] = await makeTickets(t, [{}]);
    for (const to of TICKET_STATUSES) {
      const res = await call(app, "POST", `/api/tickets/${id}/transition`, t, { to, from: "closed" });
      assert.ok([409].includes(res.statusCode), `${to}: ${res.statusCode}`);
    }
  });

  it("two simultaneous transition requests: one 200, one 409, one event", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const [id] = await makeTickets(t, [{}]);
    const res = await Promise.all([1, 2].map(() => call(app, "POST", `/api/tickets/${id}/transition`, t, { to: "triaged", from: "received" })));
    assert.deepEqual(res.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id = $1 AND type = 'status_changed'", [id])).rows[0].n, 1);
  });

  it("patches priority, assignee and status, with events and an audit row", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const member = await createMember(db.owner, t.tenantId);
    const [id] = await makeTickets(t, [{}]);
    const res = await call(app, "PATCH", `/api/tickets/${id}`, t, { priority: "P2", assigneeId: member, status: "triaged" });
    assert.equal(res.statusCode, 200);
    const ticket = res.json().ticket;
    assert.deepEqual([ticket.priority, ticket.prioritySource, ticket.assigneeId, ticket.status], ["P2", "human", member, "triaged"]);
    const audit = (await db.owner.query("SELECT actor, action FROM audit_log WHERE target = $1", [`ticket:${id}`])).rows;
    assert.deepEqual(audit, [{ actor: "human:api-tester", action: "ticket.patch" }]);
  });

  it("PATCH rejects unknown, forbidden and empty bodies, and an unknown assignee", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const [id] = await makeTickets(t, [{}]);
    for (const body of [{}, { title: "x" }, { tenantId: t.tenantId }, { priority: "P9" }, { assigneeId: "nope" }, { status: "nope" }, { switchRoomRef: "x" }, { priority: "P1", id: randomUUID() }]) {
      const res = await call(app, "PATCH", `/api/tickets/${id}`, t, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      noTrace(res.body);
      assert.ok(!res.body.includes(MARKER));
    }
    const unknown = await call(app, "PATCH", `/api/tickets/${id}`, t, { assigneeId: randomUUID() });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().error, "unknown_assignee");
    assert.equal((await db.owner.query("SELECT priority FROM tickets WHERE id = $1", [id])).rows[0].priority, "P3");
  });

  it("malformed JSON gets a generic 400", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const [id] = await makeTickets(t, [{}]);
    const res = await app.inject({ method: "PATCH", url: `/api/tickets/${id}`, headers: { "x-test-tenant": t.tenantId, "content-type": "application/json", "x-requested-with": "relay-admin" }, payload: "{nope" });
    assert.equal(res.statusCode, 400);
    noTrace(res.body);
  });
});

describe("status changes through the API queue a client update", () => {
  const clientRows = async (id: string) => (await db.owner.query("SELECT payload FROM outbox WHERE kind = 'client.send' AND payload->>'ticketId' = $1", [id])).rows;

  it("the transition and PATCH routes queue exactly one update for a notifying status and none for a silent one", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const [viaTransition, viaPatch] = (await makeTickets(t, [{}, {}])) as [string, string];
    await db.owner.query("UPDATE tickets SET status = 'assigned' WHERE id = ANY($1)", [[viaTransition, viaPatch]]);
    assert.equal((await call(app, "POST", `/api/tickets/${viaTransition}/transition`, t, { to: "in_progress" })).statusCode, 200);
    assert.equal((await call(app, "PATCH", `/api/tickets/${viaPatch}`, t, { status: "in_progress" })).statusCode, 200);
    assert.deepEqual((await clientRows(viaTransition)).map((r) => r.payload.status), ["in_progress"]);
    assert.deepEqual((await clientRows(viaPatch)).map((r) => r.payload.status), ["in_progress"]);
    assert.equal((await call(app, "POST", `/api/tickets/${viaTransition}/transition`, t, { to: "in_review" })).statusCode, 200);
    assert.equal((await clientRows(viaTransition)).length, 1, "in_review is silent");
  });

  it("a rejected transition queues nothing", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const id = (await makeTickets(t, [{}]))[0]!;
    assert.equal((await call(app, "POST", `/api/tickets/${id}/transition`, t, { to: "resolved" })).statusCode, 409);
    assert.equal((await clientRows(id)).length, 0);
  });
});

describe("github sync approval (#12)", () => {
  const stagedRow = async (t: TestTenant, ticketId: string) => {
    const key = `github:${t.tenantId}:${ticketId}:general`;
    await db.owner.query(
      "INSERT INTO outbox (tenant_id, kind, payload, idempotency_key, status) VALUES ($1, 'github.create_issue', $2, $3, 'staged')",
      [t.tenantId, JSON.stringify({ ticketId }), key]);
    return key;
  };
  const statusOf = async (key: string) => (await db.owner.query("SELECT status FROM outbox WHERE idempotency_key = $1", [key])).rows[0]?.status;

  it("releases a staged row to the dispatcher, exactly once, with an audit trail", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const [ticketId] = await makeTickets(t, [{}]);
    const key = await stagedRow(t, ticketId!);

    const res = await call(app, "POST", `/api/tickets/${ticketId}/github-sync/approve`, t);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { approved: true });
    assert.equal(await statusOf(key), "pending");

    const again = await call(app, "POST", `/api/tickets/${ticketId}/github-sync/approve`, t);
    assert.equal(again.statusCode, 409, "nothing staged the second time");
    assert.equal(await statusOf(key), "pending");

    const audit = (await db.owner.query("SELECT action, target FROM audit_log WHERE tenant_id = $1 AND action = 'tickets.approve_github_sync'", [t.tenantId])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].target, `tickets:${ticketId}`);
  });

  it("a ticket with nothing staged, or another tenant's ticket, gets the same 409", async () => {
    const app = server();
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const [plain] = await makeTickets(a, [{}]);
    const [other] = await makeTickets(b, [{}]);
    assert.equal((await call(app, "POST", `/api/tickets/${plain}/github-sync/approve`, a)).statusCode, 409);
    assert.equal((await call(app, "POST", `/api/tickets/${other}/github-sync/approve`, a)).statusCode, 409);
    const key = `github:${b.tenantId}:${other}:general`;
    assert.equal((await db.owner.query("SELECT status FROM outbox WHERE idempotency_key = $1", [key])).rows[0]?.status, undefined, "b's row is untouched");
  });
});

describe("tenant isolation through the API", () => {
  it("another tenant gets 404 for read, patch and transition, and nothing changes", async () => {
    const app = server();
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const [id] = await makeTickets(a, [{}]);
    assert.equal((await call(app, "GET", `/api/tickets/${id}`, b)).statusCode, 404);
    assert.equal((await call(app, "PATCH", `/api/tickets/${id}`, b, { priority: "P1" })).statusCode, 404);
    assert.equal((await call(app, "POST", `/api/tickets/${id}/transition`, b, { to: "triaged" })).statusCode, 404);
    assert.equal((await call(app, "GET", "/api/tickets", b)).json().items.length, 0);
    const row = (await db.owner.query("SELECT priority, status FROM tickets WHERE id = $1", [id])).rows[0];
    assert.deepEqual(row, { priority: "P3", status: "received" });
  });
});

describe("logging", () => {
  it("never records ticket text or request bodies", async () => {
    const app = server();
    const t = await createTenant(db.owner);
    const [id] = await makeTickets(t, [{}]);
    await call(app, "GET", `/api/tickets/${id}`, t);
    await call(app, "GET", "/api/tickets", t);
    await call(app, "PATCH", `/api/tickets/${id}`, t, { priority: "P2", note: MARKER });
    await call(app, "POST", `/api/tickets/${id}/transition`, t, { to: "triaged", reason: MARKER });
    const logged = lines.join("");
    assert.ok(logged.length > 0);
    assert.ok(!logged.includes(MARKER), "log leaked ticket or body text");
  });
});
