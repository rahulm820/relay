import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import { withTenant } from "@relay/db";
import { TICKET_TRANSITIONS, type ExtractionResult, type TicketStatus } from "@relay/shared";
import { Redis } from "ioredis";
import { createMessage, createTenant, createTestDb, flushQueueKeys, TEST_REDIS_URL, type TestDb, type TestTenant } from "../testing/fixtures.js";
import type { StageContext } from "../orchestrator/index.js";
import { createTicketsForMessage, patchTicket, statusNotifies, ticketStage, notifyStage, transitionTicket, type Actor } from "./index.js";

// Needs Postgres and Redis (see packages/core/src/testing/fixtures.ts).
const HUMAN: Actor = { type: "human", ref: "tester" };
let db: TestDb;
let redis: Redis;
before(async () => { db = await createTestDb(); redis = new Redis(TEST_REDIS_URL); });
after(async () => { await redis.quit(); await db.dispose(); });
afterEach(async () => { await flushQueueKeys(redis); });

const tx = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.worker, tenantId, fn);
const rows = async (sql: string, params: unknown[]) => (await db.owner.query(sql, params)).rows;
const sendRows = (ticketId: string) => rows("SELECT idempotency_key, payload FROM outbox WHERE kind = 'client.send' AND payload->>'ticketId' = $1 ORDER BY created_at", [ticketId]);

async function ticketIn(t: TestTenant, status: TicketStatus, over: { noConversation?: boolean } = {}): Promise<string> {
  const messageId = await createMessage(db.owner, t);
  const [c] = await tx(t.tenantId, (cl) => createTicketsForMessage(cl, {
    tenantId: t.tenantId, messageId, traceId: "x", actor: HUMAN,
    tickets: [{ issueIndex: 0, title: "t", summary: "", category: "bug", priority: "P3", priorityReason: "r", prioritySource: "rules", outbox: false }],
  }));
  await db.owner.query("UPDATE tickets SET status = $2 WHERE id = $1", [c!.ticketId, status]); // arrange only
  if (over.noConversation) await db.owner.query("UPDATE tickets SET conversation_id = NULL WHERE id = $1", [c!.ticketId]);
  return c!.ticketId;
}

describe("status updates are queued by transitionTicket, in its transaction", () => {
  it("every legal transition queues exactly one row when it notifies and none when it does not", async () => {
    const t = await createTenant(db.owner);
    for (const [from, targets] of Object.entries(TICKET_TRANSITIONS) as [TicketStatus, readonly TicketStatus[]][]) {
      for (const to of targets) {
        const id = await ticketIn(t, from);
        await tx(t.tenantId, (c) => transitionTicket(c, { ticketId: id, to, actor: HUMAN }));
        const queued = await sendRows(id);
        assert.equal(queued.length, statusNotifies(to) ? 1 : 0, `${from} -> ${to}`);
        if (queued[0]) {
          assert.deepEqual(Object.keys(queued[0].payload).sort(), ["eventId", "kind", "status", "ticketId", "traceId"]);
          assert.equal(queued[0].payload.status, to);
        }
      }
    }
  });

  it("rolling the transaction back leaves no outbox row", async () => {
    const t = await createTenant(db.owner);
    const id = await ticketIn(t, "assigned");
    await assert.rejects(tx(t.tenantId, async (c) => {
      await transitionTicket(c, { ticketId: id, to: "in_progress", actor: HUMAN });
      throw new Error("abort");
    }));
    assert.equal((await sendRows(id)).length, 0);
    assert.equal((await rows("SELECT status FROM tickets WHERE id = $1", [id]))[0].status, "assigned");
  });

  it("the patch path is covered too", async () => {
    const t = await createTenant(db.owner);
    const id = await ticketIn(t, "assigned");
    await tx(t.tenantId, (c) => patchTicket(c, id, { status: "in_progress" }, HUMAN));
    assert.equal((await sendRows(id)).length, 1);
  });

  it("an illegal transition queues nothing", async () => {
    const t = await createTenant(db.owner);
    const id = await ticketIn(t, "resolved");
    await assert.rejects(tx(t.tenantId, (c) => transitionTicket(c, { ticketId: id, to: "in_progress", actor: HUMAN })));
    assert.equal((await sendRows(id)).length, 0);
  });

  it("reopen then resolve again notifies again, once per occurrence, with distinct keys", async () => {
    const t = await createTenant(db.owner);
    const id = await ticketIn(t, "in_progress");
    for (const to of ["resolved", "reopened", "in_progress", "resolved"] as const) await tx(t.tenantId, (c) => transitionTicket(c, { ticketId: id, to, actor: HUMAN }));
    const queued = await sendRows(id);
    assert.deepEqual(queued.map((q) => q.payload.status), ["resolved", "reopened", "in_progress", "resolved"]);
    assert.equal(new Set(queued.map((q) => q.idempotency_key)).size, 4);
  });

  it("a ticket without a conversation has nobody to tell", async () => {
    const t = await createTenant(db.owner);
    const id = await ticketIn(t, "assigned", { noConversation: true });
    await tx(t.tenantId, (c) => transitionTicket(c, { ticketId: id, to: "in_progress", actor: HUMAN }));
    assert.equal((await sendRows(id)).length, 0);
  });
});

// ---- the notify stage -------------------------------------------------------------------------------

const extraction = (over: Partial<ExtractionResult> = {}, issueOver: Record<string, unknown> = {}): ExtractionResult => ({
  kind: "extracted", language: "en", is_complaint: true, off_topic: false, contains_sensitive_data: false, sentiment: "neutral", confidence: 0.9, missing_info: [],
  issues: [{ title: "Checkout fails", summary: "s", category: "bug", product_area: null, steps_to_reproduce: [], expected: null, actual: null, environment: {}, severity_signals: [], missing_info: [], confidence: 0.9, ...issueOver }],
  ...over,
});
function ctx(t: TestTenant, messageId: string, results: Record<string, unknown>): StageContext {
  return { tenantId: t.tenantId, conversationId: t.conversationId, messageId, traceId: "tr", stage: "notify", attempt: 1, results, db: (fn) => tx(t.tenantId, fn), signal: new AbortController().signal };
}
const clientRowsForMessage = (messageId: string) => rows("SELECT idempotency_key, payload FROM outbox WHERE kind = 'client.send' AND payload->>'messageId' = $1", [messageId]);

async function runPipelineStages(t: TestTenant, messageId: string, ex: unknown) {
  const results: Record<string, unknown> = { extract: ex };
  const ticket = await ticketStage()({ ...ctx(t, messageId, results), stage: "ticket" });
  results["ticket"] = ticket.result;
  const notify = await notifyStage()(ctx(t, messageId, results));
  return { ticket: ticket.result, notify: notify.result, results };
}

describe("notify stage", () => {
  it("queues an acknowledgement for a created ticket, once even if the stage runs twice", async () => {
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    const { results } = await runPipelineStages(t, messageId, extraction());
    await notifyStage()(ctx(t, messageId, results));
    const queued = await clientRowsForMessage(messageId);
    assert.equal(queued.length, 1);
    assert.deepEqual([queued[0].payload.kind, queued[0].payload.sensitive], ["ack", false]);
    assert.equal(queued[0].idempotency_key, `client:${t.tenantId}:${messageId}:ack`);
  });

  it("flags sensitive-data tickets so the ack carries the safety line", async () => {
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    await runPipelineStages(t, messageId, extraction({ contains_sensitive_data: true }));
    assert.equal((await clientRowsForMessage(messageId))[0].payload.sensitive, true);
  });

  it("a fallback ticket gets the same neutral acknowledgement", async () => {
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    const { ticket } = await runPipelineStages(t, messageId, { kind: "fallback", reason: "timeout" });
    assert.equal(ticket["outcome"], "fallback");
    assert.equal((await clientRowsForMessage(messageId))[0].payload.kind, "ack");
  });

  it("off-topic gets a refusal; a non-complaint gets nothing; a skeleton ticket result does nothing", async () => {
    const t = await createTenant(db.owner);
    const off = await createMessage(db.owner, t);
    await runPipelineStages(t, off, extraction({ off_topic: true }));
    assert.equal((await clientRowsForMessage(off))[0].payload.kind, "refusal");
    const thanks = await createMessage(db.owner, t);
    await runPipelineStages(t, thanks, extraction({ is_complaint: false }));
    assert.equal((await clientRowsForMessage(thanks)).length, 0);
    const skeleton = await createMessage(db.owner, t);
    const out = await notifyStage()(ctx(t, skeleton, { ticket: { noop: true } }));
    assert.equal(out.result["noop"], true);
    assert.equal((await clientRowsForMessage(skeleton)).length, 0);
  });

  it("missing information moves the ticket to needs_info and queues the question instead of an ack", async () => {
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    const { ticket } = await runPipelineStages(t, messageId, extraction({}, { missing_info: ["app_version", "device model", "third"] }));
    const id = (ticket["ticketIds"] as string[])[0]!;
    assert.equal((await rows("SELECT status FROM tickets WHERE id = $1", [id]))[0].status, "needs_info");
    assert.equal((await clientRowsForMessage(messageId)).length, 0, "no separate ack");
    const queued = await sendRows(id);
    assert.deepEqual(queued.map((q) => q.payload.status), ["needs_info"]);
  });
});

describe("a reply to a question belongs to the waiting ticket", () => {
  it("attaches to the needs_info ticket instead of opening a new one, and replays cleanly", async () => {
    const t = await createTenant(db.owner);
    const first = await createMessage(db.owner, t);
    const { ticket } = await runPipelineStages(t, first, extraction({}, { missing_info: ["app_version"] }));
    const id = (ticket["ticketIds"] as string[])[0]!;
    const reply = await createMessage(db.owner, t, "it is version 4.2");
    const run = () => ticketStage()({ ...ctx(t, reply, { extract: extraction() }), stage: "ticket" });
    assert.deepEqual((await run()).result, { outcome: "reply_appended", ticketIds: [id], duplicates: [] });
    assert.deepEqual((await run()).result, { outcome: "reply_appended", ticketIds: [id], duplicates: [] });
    assert.equal((await rows("SELECT status FROM tickets WHERE id = $1", [id]))[0].status, "triaged");
    assert.equal((await rows("SELECT count(*)::int AS n FROM tickets WHERE source_message_id = $1", [reply]))[0].n, 0);
    assert.equal((await rows("SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id = $1 AND type = 'client_replied'", [id]))[0].n, 1);
    const out = await notifyStage()(ctx(t, reply, { ticket: { outcome: "reply_appended", ticketIds: [id] } }));
    assert.deepEqual(out.result, { sent: [], reason: "reply_appended" });
  });

  it("a message in a conversation with nothing waiting creates a ticket as usual", async () => {
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    const { ticket } = await runPipelineStages(t, messageId, extraction());
    assert.equal(ticket["outcome"], "tickets");
  });
});

describe("tenant isolation", () => {
  it("tenant B's context cannot queue or see tenant A's status updates", async () => {
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const id = await ticketIn(a, "assigned");
    await assert.rejects(tx(b.tenantId, (c) => transitionTicket(c, { ticketId: id, to: "in_progress", actor: HUMAN })));
    assert.equal((await sendRows(id)).length, 0);
    void randomUUID;
  });
});
