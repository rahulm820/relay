import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { PermanentFailureError, createTicketsForMessage, type OutboxHandlerInput } from "@relay/core";
import { createMember, createMessage, createTenant, createTestDb, type TestDb, type TestTenant } from "@relay/core/testing";
import { withTenant } from "@relay/db";
import { Secret } from "@relay/shared";
import { SwitchClient, createSwitchRoomHandler, roomMarker, roomName } from "./index.js";
import { MockSwitch } from "./testing/mock-switch.js";

const MARKER = "PERSONAL-DATA-MARKER";
let db: TestDb;
let mock: MockSwitch;
let notifierKey: Secret;
let logs: Record<string, unknown>[] = [];

before(async () => {
  db = await createTestDb();
  mock = new MockSwitch();
  await mock.start();
});
after(async () => { await mock.stop(); await db.dispose(); });
beforeEach(async () => {
  logs = [];
  mock.rooms.length = 0; mock.messages.length = 0; mock.requests.length = 0; mock.agents.clear(); mock.knownUsers.clear();
  for (const f of ["POST /gateway/rooms", "GET /gateway/rooms"]) mock.fault(f, { times: 0 });
  const admin = new SwitchClient({ gatewayUrl: mock.gatewayUrl, email: mock.email, password: new Secret(mock.password) });
  await admin.registerAgent({ name: "relay-triager", description: "d", displayName: "T" });
  notifierKey = (await admin.registerAgent({ name: "relay-notifier", description: "d", displayName: "N" })).apiKey;
  mock.requests.length = 0;
});

const client = (timeoutMs = 400) =>
  new SwitchClient({ gatewayUrl: mock.gatewayUrl, email: mock.email, password: new Secret(mock.password), notifier: { name: "relay-notifier", apiKey: notifierKey }, timeoutMs });
const handler = (over: Partial<Parameters<typeof createSwitchRoomHandler>[0]> = {}) =>
  createSwitchRoomHandler({ pool: db.worker, client: client(), missing: [], triagerAgent: "relay-triager", notifierAgent: "relay-notifier", log: (e) => logs.push(e), ...over });

/** A quarantined "Needs human triage" ticket, exactly what the placeholder extractor produces today. */
async function newTicket(opts: { title?: string; assigneeHandle?: string; github?: boolean; handleOfPm?: string } = {}): Promise<{ t: TestTenant; ticketId: string; messageId: string }> {
  const t = await createTenant(db.owner);
  const messageId = await createMessage(db.owner, t, `my card number problem ${MARKER}`);
  if (opts.handleOfPm) await db.owner.query("INSERT INTO members (tenant_id, name, role, chat_handle) VALUES ($1,'Pat','pm',$2)", [t.tenantId, opts.handleOfPm]);
  const [created] = await withTenant(db.worker, t.tenantId, (c) => createTicketsForMessage(c, {
    tenantId: t.tenantId, messageId, traceId: "x", actor: { type: "system", ref: "test" },
    tickets: [{ issueIndex: 0, title: opts.title ?? "Needs human triage", summary: "", category: "other", priority: "P3", priorityReason: "r", prioritySource: "rules", quarantineReason: "extraction_fallback:llm_error", outbox: true }],
  }));
  const ticketId = created!.ticketId;
  if (opts.assigneeHandle) {
    const member = await createMember(db.owner, t.tenantId);
    await db.owner.query("UPDATE members SET chat_handle = $2 WHERE id = $1", [member, opts.assigneeHandle]);
    await db.owner.query("UPDATE tickets SET assignee_id = $2 WHERE id = $1", [ticketId, member]);
  }
  if (opts.github) {
    await db.owner.query(
      "INSERT INTO tracker_issues (tenant_id, ticket_id, provider, external_issue_url, external_issue_number, sync_status, idempotency_key) VALUES ($1,$2,'github','https://github.com/o/r/issues/12',12,'created',$3)",
      [t.tenantId, ticketId, `k-${ticketId}`]);
  }
  return { t, ticketId, messageId };
}
const input = (t: TestTenant, ticketId: string, over: Partial<OutboxHandlerInput> = {}): OutboxHandlerInput => ({
  outboxId: randomUUID(), tenantId: t.tenantId, kind: "switch.create_room", idempotencyKey: `switch:${t.tenantId}:${ticketId}`, payload: { ticketId, traceId: "tr" }, attempt: 1, traceId: "tr", ...over,
});
const ticketRow = async (id: string) => (await db.owner.query("SELECT switch_room_ref FROM tickets WHERE id = $1", [id])).rows[0];
const events = async (id: string) => (await db.owner.query("SELECT type, payload FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at, id", [id])).rows;
const roomsFor = (ticketId: string) => mock.rooms.filter((r) => r.description.includes(roomMarker(ticketId)));
const posted = (ticketId: string) => mock.messages.filter((m) => m.content.includes(ticketId));

describe("one room and one kickoff per ticket", () => {
  it("creates the room with both agents, links the ticket, tags the role owner, posts the kickoff", async () => {
    const { t, ticketId } = await newTicket({ handleOfPm: "pat.pm" });
    mock.knownUsers.add("pat.pm");
    await handler()(input(t, ticketId));
    const [room] = roomsFor(ticketId);
    assert.ok(room);
    assert.equal(room.name, `relay-${ticketId.replace(/-/g, "").slice(0, 8)}`);
    assert.deepEqual(room.agent_names, ["relay-triager", "relay-notifier"]);
    assert.deepEqual(room.users, ["pat.pm"]);
    assert.equal((await ticketRow(ticketId)).switch_room_ref, room.id);
    const kickoff = posted(ticketId);
    assert.equal(kickoff.length, 1);
    assert.equal(kickoff[0]!.roomId, room.id);
    for (const part of ["P3", "other", "quarantined", "Needs human triage", "Owner: @pat.pm", ticketId]) assert.ok(kickoff[0]!.content.includes(part), part);
    assert.ok(!kickoff[0]!.content.includes("GitHub"), "no GitHub line while no issue exists");
    assert.deepEqual((await events(ticketId)).map((e) => e.type).slice(-2), ["switch_room_linked", "switch_kickoff_posted"]);
    const audit = await db.owner.query("SELECT action FROM audit_log WHERE target = $1", [`ticket:${ticketId}`]);
    assert.deepEqual(audit.rows, [{ action: "ticket.switch_room_linked" }]);
  });

  it("tags the assignee when one is set, and adds the GitHub reference only when an issue exists", async () => {
    const { t, ticketId } = await newTicket({ assigneeHandle: "dev.dana", github: true });
    mock.knownUsers.add("dev.dana");
    await handler()(input(t, ticketId));
    const text = posted(ticketId)[0]!.content;
    assert.ok(text.includes("Owner: @dev.dana"));
    assert.ok(text.includes("GitHub: https://github.com/o/r/issues/12 (#12)"));
  });

  it("running the same outbox row twice makes one room and one kickoff", async () => {
    const { t, ticketId } = await newTicket();
    const run = input(t, ticketId);
    await handler()(run);
    await handler()({ ...run, attempt: 2 });
    assert.equal(roomsFor(ticketId).length, 1);
    assert.equal(posted(ticketId).length, 1);
    assert.equal((await events(ticketId)).filter((e) => e.type === "switch_kickoff_posted").length, 1);
  });

  it("two handlers racing: one waits (transient), nothing is duplicated, the retry is a no-op", async () => {
    const { t, ticketId } = await newTicket();
    mock.fault("POST /gateway/rooms", { delayMs: 150 });
    const settled = await Promise.allSettled([handler()(input(t, ticketId)), handler()(input(t, ticketId))]);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
    const loser = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    assert.ok(!(loser.reason instanceof PermanentFailureError), "the loser must be retried, not failed");
    assert.equal((loser.reason as { code: string }).code, "switch_room_busy");
    await handler()(input(t, ticketId));
    assert.equal(roomsFor(ticketId).length, 1);
    assert.equal(posted(ticketId).length, 1);
  });

  it("recovers a room that was created before a crash (ref never saved) without making another", async () => {
    const { t, ticketId } = await newTicket();
    mock.rooms.push({ id: randomUUID(), name: roomName(ticketId), description: `Relay ticket room. ${roomMarker(ticketId)}`, bridge_id: "bridge-1", external_channel_id: "c", users: [], archived: false, agent_names: [] });
    await handler()(input(t, ticketId));
    assert.equal(roomsFor(ticketId).length, 1);
    assert.equal((await ticketRow(ticketId)).switch_room_ref, mock.rooms[0]!.id);
    assert.equal(mock.requests.filter((r) => r.method === "POST" && r.path === "/gateway/rooms").length, 0);
    const linked = (await events(ticketId)).find((e) => e.type === "switch_room_linked")!;
    assert.equal(linked.payload.recovered, true);
    assert.equal(posted(ticketId).length, 1);
  });

  it("a crash after the kickoff post leaves at most the documented at-least-once edge, never a second room", async () => {
    const { t, ticketId } = await newTicket();
    await handler()(input(t, ticketId));
    await db.owner.query("DELETE FROM ticket_events WHERE ticket_id = $1 AND type = 'switch_kickoff_posted'", [ticketId]); // simulate: event never committed
    await handler()(input(t, ticketId));
    assert.equal(roomsFor(ticketId).length, 1);
    assert.equal(posted(ticketId).length, 2);
  });
});

describe("people", () => {
  it("an unknown chat user does not fail the room; nobody is tagged", async () => {
    const { t, ticketId } = await newTicket({ handleOfPm: "ghost.user" });
    await handler()(input(t, ticketId));
    assert.equal(roomsFor(ticketId).length, 1);
    assert.ok(posted(ticketId)[0]!.content.includes("Owner: not assigned yet"));
    assert.ok(logs.some((l) => l["outcome"] === "users_not_found" && l["count"] === 1));
  });
});

describe("content safety", () => {
  it("no client message text reaches Switch or the logs; untrusted title text is defused", async () => {
    const { t, ticketId } = await newTicket({ title: "pay @all now [x](http://evil)" });
    await handler()(input(t, ticketId));
    const everything = JSON.stringify([mock.requests.map((r) => r.body), mock.messages, logs]);
    assert.ok(!everything.includes(MARKER), "the message body must never leave Relay");
    assert.ok(!posted(ticketId)[0]!.content.includes("@all"));
    assert.ok(!posted(ticketId)[0]!.content.includes("]("));
    const secrets = [mock.password, notifierKey.reveal()];
    for (const s of secrets) assert.ok(!JSON.stringify(logs).includes(s), "logs must not contain credentials");
  });

  it("the room's instructions treat client text as untrusted data", async () => {
    const { t, ticketId } = await newTicket();
    await handler()(input(t, ticketId));
    const body = mock.requests.find((r) => r.method === "POST" && r.path === "/gateway/rooms")!.body;
    assert.match(body.instructions, /untrusted data/);
    assert.match(body.instructions, /never contact the client/);
  });
});

describe("failure semantics", () => {
  it("missing setup fails loudly with a code and the variable names only", async () => {
    const { t, ticketId } = await newTicket();
    await assert.rejects(handler({ client: null, missing: ["SWITCH_ADMIN_EMAIL", "SWITCH_NOTIFIER_API_KEY"] })(input(t, ticketId)),
      (e) => e instanceof PermanentFailureError && e.code === "switch_not_configured" && /SWITCH_ADMIN_EMAIL, SWITCH_NOTIFIER_API_KEY/.test(e.message));
    assert.equal(mock.requests.length, 0);
    assert.equal((await ticketRow(ticketId)).switch_room_ref, null);
  });

  it("Switch down (5xx) is transient: retried later, ticket untouched, still one room afterwards", async () => {
    const { t, ticketId } = await newTicket();
    mock.fault("POST /gateway/rooms", { status: 500 });
    await assert.rejects(handler()(input(t, ticketId)), (e) => !(e instanceof PermanentFailureError) && (e as { code: string }).code === "switch_http_500");
    assert.equal((await ticketRow(ticketId)).switch_room_ref, null);
    await handler()(input(t, ticketId, { attempt: 2 }));
    assert.equal(roomsFor(ticketId).length, 1);
    assert.equal(posted(ticketId).length, 1);
  });

  it("a slow Switch hits the client timeout and is transient", async () => {
    const { t, ticketId } = await newTicket();
    mock.fault("POST /gateway/rooms", { delayMs: 500 });
    await assert.rejects(handler({ client: client(100) })(input(t, ticketId)), (e) => !(e instanceof PermanentFailureError) && (e as { code: string }).code === "switch_timeout");
  });

  it("a refused request (4xx) and bad credentials are permanent", async () => {
    const { t, ticketId } = await newTicket();
    mock.fault("POST /gateway/rooms", { status: 400 });
    await assert.rejects(handler()(input(t, ticketId)), (e) => e instanceof PermanentFailureError && e.code === "switch_http_400");
    const bad = new SwitchClient({ gatewayUrl: mock.gatewayUrl, email: mock.email, password: new Secret("nope"), notifier: { name: "relay-notifier", apiKey: notifierKey } });
    await assert.rejects(handler({ client: bad })(input(t, ticketId)), (e) => e instanceof PermanentFailureError && e.code === "switch_auth_failed");
  });

  it("missing agents are reported with the fix, not retried forever", async () => {
    const { t, ticketId } = await newTicket();
    mock.agents.delete("relay-triager");
    await assert.rejects(handler()(input(t, ticketId)), (e) => e instanceof PermanentFailureError && e.code === "switch_agents_missing");
  });

  it("rejects a payload without a ticket id", async () => {
    const { t } = await newTicket();
    await assert.rejects(handler()(input(t, "x", { payload: { nope: 1 } })), (e) => e instanceof PermanentFailureError && e.code === "invalid_payload");
  });
});

describe("tenant isolation", () => {
  it("another tenant's job cannot see or link the ticket", async () => {
    const a = await newTicket();
    const b = await createTenant(db.owner);
    await assert.rejects(handler()(input(b, a.ticketId)), (e) => e instanceof PermanentFailureError && e.code === "ticket_not_found");
    assert.equal((await ticketRow(a.ticketId)).switch_room_ref, null);
    assert.equal(mock.rooms.length, 0);
  });

  it("the worker role is not a superuser", async () => {
    const { rows } = await db.worker.query("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s");
    assert.deepEqual(rows[0], { u: "relay_worker", s: false });
  });
});
