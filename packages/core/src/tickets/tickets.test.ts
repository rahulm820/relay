import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { withTenant } from "@relay/db";
import {
  IllegalTransitionError, TICKET_STATUSES, TICKET_TRANSITIONS, canTransition,
  type ExtractionOutcome, type ExtractionResult, type TicketStatus,
} from "@relay/shared";
import { Redis } from "ioredis";
import { Orchestrator, createDefaultStageRegistry, type StageContext } from "../orchestrator/index.js";
import { PermanentFailureError, QueueProducer } from "../queue/index.js";
import {
  createMember, createMessage, createTenant, createTestDb, flushQueueKeys, waitFor, TEST_REDIS_URL, type TestDb, type TestTenant,
} from "../testing/fixtures.js";
import {
  StatusConflictError, TicketNotFoundError, TicketValidationError, createTicketsForMessage, getTicket, listTickets,
  patchTicket, provisionalPriority, ticketStage, transitionTicket, type Actor,
} from "./index.js";

const MARKER = "PERSONAL-DATA-MARKER";
const HUMAN: Actor = { type: "human", ref: "tester" };
let db: TestDb;
let redis: Redis;

before(async () => { db = await createTestDb(); redis = new Redis(TEST_REDIS_URL); });
after(async () => { await redis.quit(); await db.dispose(); });
beforeEach(async () => { await flushQueueKeys(redis); });
afterEach(async () => { await flushQueueKeys(redis); });

const issue = (over: Record<string, unknown> = {}) => ({
  title: `Checkout fails ${MARKER}`, summary: "Card payments return 500", category: "bug" as const, product_area: "checkout",
  steps_to_reproduce: [], expected: null, actual: null, environment: {}, severity_signals: ["payment_failure"],
  missing_info: [], confidence: 0.9, ...over,
});
const extraction = (over: Partial<ExtractionResult> = {}): ExtractionResult => ({
  kind: "extracted", language: "en", is_complaint: true, off_topic: false, issues: [issue()], contains_sensitive_data: false,
  sentiment: "neutral", confidence: 0.9, missing_info: [], ...over,
});
const fallback: ExtractionOutcome = { kind: "fallback", reason: "timeout" };

async function setup(): Promise<{ t: TestTenant; messageId: string }> {
  const t = await createTenant(db.owner);
  return { t, messageId: await createMessage(db.owner, t) };
}
const tx = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.worker, tenantId, fn);

function stageCtx(t: TestTenant, messageId: string, results: Record<string, unknown>): StageContext {
  return {
    tenantId: t.tenantId, conversationId: t.conversationId, messageId, traceId: "trace-1", stage: "ticket", attempt: 1,
    results, db: (fn) => tx(t.tenantId, fn), signal: new AbortController().signal,
  };
}
const runStage = (t: TestTenant, messageId: string, results: Record<string, unknown>) => ticketStage()(stageCtx(t, messageId, results));
const rows = async (sql: string, params: unknown[]) => (await db.owner.query(sql, params)).rows;
const ticketsOf = (messageId: string) => rows("SELECT * FROM tickets WHERE source_message_id = $1 ORDER BY source_issue_index", [messageId]);
const eventsOf = (ticketId: string) => rows("SELECT type, actor_type, actor_ref, payload FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at, id", [ticketId]);
const outboxOf = (ticketId: string) => rows("SELECT kind, idempotency_key, payload, status FROM outbox WHERE payload->>'ticketId' = $1 ORDER BY kind", [ticketId]);

describe("provisionalPriority", () => {
  it("follows severity signals first, then category", () => {
    assert.equal(provisionalPriority("bug", ["payment_failure"]), "P1");
    assert.equal(provisionalPriority("question", ["security"]), "P1");
    assert.equal(provisionalPriority("bug", ["blocking"]), "P2");
    assert.equal(provisionalPriority("bug", []), "P3");
    assert.equal(provisionalPriority("ui", []), "P3");
    assert.equal(provisionalPriority("billing", []), "P3");
    assert.equal(provisionalPriority("feature", []), "P4");
    assert.equal(provisionalPriority("question", ["blocking"]), "P2");
  });
});

describe("ticket stage", () => {
  it("creates a ticket from a valid extraction with priority, SLA, event and the two outbox rows", async () => {
    const { t, messageId } = await setup();
    const out = await runStage(t, messageId, { extract: extraction() });
    assert.equal(out.result["outcome"], "tickets");
    const [ticket] = await ticketsOf(messageId);
    assert.deepEqual(out.result["ticketIds"], [ticket.id]);
    assert.equal(ticket.status, "received");
    assert.equal(ticket.category, "bug");
    assert.equal(ticket.priority, "P1");
    assert.equal(ticket.priority_source, "rules");
    assert.match(ticket.priority_reason, /^provisional/);
    assert.equal(ticket.source_issue_index, 0);
    assert.equal(ticket.conversation_id, t.conversationId);
    assert.ok(ticket.client_id);
    const sla = await rows("SELECT extract(epoch FROM sla_ack_due - created_at)/60 AS ack, extract(epoch FROM sla_resolve_due - created_at)/60 AS res FROM tickets WHERE id = $1", [ticket.id]);
    assert.deepEqual([Number(sla[0].ack), Number(sla[0].res)], [15, 240]);
    const events = await eventsOf(ticket.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "created");
    assert.equal(events[0].actor_type, "system");
    assert.ok(!JSON.stringify(events).includes(MARKER), "events carry no client text");
    const outbox = await outboxOf(ticket.id);
    assert.deepEqual(outbox.map((o) => [o.kind, o.idempotency_key]), [
      ["github.create_issue", `github:${t.tenantId}:${ticket.id}:general`],
      ["switch.create_room", `switch:${t.tenantId}:${ticket.id}`],
    ]);
    for (const o of outbox) {
      assert.deepEqual(Object.keys(o.payload).sort(), ["ticketId", "traceId"]);
      assert.ok(!JSON.stringify(o.payload).includes(MARKER));
    }
  });

  it("replaying the stage creates no duplicates", async () => {
    const { t, messageId } = await setup();
    const results = { extract: extraction({ issues: [issue(), issue({ title: "second" })] }) };
    const first = await runStage(t, messageId, results);
    const second = await runStage(t, messageId, results);
    assert.deepEqual(second.result["ticketIds"], first.result["ticketIds"]);
    const tickets = await ticketsOf(messageId);
    assert.equal(tickets.length, 2);
    for (const tk of tickets) {
      assert.equal((await eventsOf(tk.id)).length, 1);
      assert.equal((await outboxOf(tk.id)).length, 2);
    }
  });

  it("two issues in one message make two tickets with their own outbox rows", async () => {
    const { t, messageId } = await setup();
    await runStage(t, messageId, { extract: extraction({ issues: [issue(), issue({ title: "Logo is blurry", category: "ui", severity_signals: [] })] }) });
    const tickets = await ticketsOf(messageId);
    assert.deepEqual(tickets.map((x) => [x.source_issue_index, x.category, x.priority]), [[0, "bug", "P1"], [1, "ui", "P3"]]);
    assert.notEqual(tickets[0].id, tickets[1].id);
    assert.equal((await rows("SELECT count(*)::int AS n FROM outbox WHERE payload->>'ticketId' = ANY($1)", [tickets.map((x) => x.id)]))[0].n, 4);
  });

  it("an LLM fallback becomes a quarantined P3 'needs human triage' ticket that is still routed", async () => {
    const { t, messageId } = await setup();
    const out = await runStage(t, messageId, { extract: fallback });
    assert.equal(out.result["outcome"], "fallback");
    const [ticket] = await ticketsOf(messageId);
    assert.deepEqual([ticket.title, ticket.status, ticket.priority, ticket.category], ["Needs human triage", "quarantined", "P3", "other"]);
    const events = await eventsOf(ticket.id);
    assert.deepEqual(events.map((e) => e.type), ["created", "status_changed"]);
    assert.deepEqual(events[1].payload, { from: "received", to: "quarantined", reason: "extraction_fallback:timeout" });
    assert.equal((await outboxOf(ticket.id)).length, 2);
  });

  it("low confidence is quarantined with priority at least P3, but never lowers urgency", async () => {
    const { t, messageId } = await setup();
    await runStage(t, messageId, { extract: extraction({ issues: [issue({ category: "question", severity_signals: [], confidence: 0.2 }), issue({ confidence: 0.2 })] }) });
    const [q, urgent] = await ticketsOf(messageId);
    assert.deepEqual([q.status, q.priority], ["quarantined", "P3"]);
    assert.deepEqual([urgent.status, urgent.priority], ["quarantined", "P1"]);
    assert.equal((await outboxOf(q.id)).length, 2);
    const ev = await eventsOf(q.id);
    assert.equal(ev[1].payload.reason, "low_confidence");
  });

  it("sensitive data is quarantined with NO outbox rows until a human releases it", async () => {
    const { t, messageId } = await setup();
    await runStage(t, messageId, { extract: extraction({ contains_sensitive_data: true }) });
    const [ticket] = await ticketsOf(messageId);
    assert.equal(ticket.status, "quarantined");
    assert.equal((await outboxOf(ticket.id)).length, 0);
    await tx(t.tenantId, (c) => transitionTicket(c, { ticketId: ticket.id, to: "triaged", actor: HUMAN, reason: "reviewed" }));
    const released = await outboxOf(ticket.id);
    assert.deepEqual(released.map((o) => o.kind), ["github.create_issue", "switch.create_room"]);
    // Leaving quarantine again and back never duplicates the rows.
    await tx(t.tenantId, (c) => transitionTicket(c, { ticketId: ticket.id, to: "escalated", actor: HUMAN }));
    assert.equal((await outboxOf(ticket.id)).length, 2);
  });

  it("off-topic and non-complaint messages create no ticket and say why", async () => {
    for (const [over, name] of [[{ off_topic: true }, "off_topic"], [{ is_complaint: false }, "not_a_complaint"]] as const) {
      const { t, messageId } = await setup();
      const out = await runStage(t, messageId, { extract: extraction(over) });
      assert.deepEqual(out.result, { outcome: name, ticketIds: [], duplicates: [] });
      assert.equal((await ticketsOf(messageId)).length, 0);
    }
  });

  it("a complaint with no extracted issues becomes a quarantined triage ticket", async () => {
    const { t, messageId } = await setup();
    const out = await runStage(t, messageId, { extract: extraction({ issues: [] }) });
    assert.equal(out.result["outcome"], "no_issues");
    const [ticket] = await ticketsOf(messageId);
    assert.deepEqual([ticket.title, ticket.status], ["Needs human triage", "quarantined"]);
  });

  it("uses the priority stage's decisions when present, instead of the provisional rule", async () => {
    const { t, messageId } = await setup();
    const assignee = await createMember(db.owner, t.tenantId);
    await runStage(t, messageId, {
      extract: extraction({ issues: [issue({ severity_signals: [] })] }),
      priority: { decisions: [{ priority: "P2", reason: "enterprise client", source: "llm", roleNeeded: "developer", assigneeId: assignee }] },
    });
    const [ticket] = await ticketsOf(messageId);
    assert.deepEqual([ticket.priority, ticket.priority_source, ticket.priority_reason, ticket.role_needed, ticket.assignee_id], ["P2", "llm", "enterprise client", "developer", assignee]);
  });

  it("fails permanently without a usable extraction result", async () => {
    const { t, messageId } = await setup();
    await assert.rejects(runStage(t, messageId, {}), (e) => e instanceof PermanentFailureError && e.code === "no_extraction");
    await assert.rejects(runStage(t, messageId, { extract: { noop: true } }), PermanentFailureError);
  });

  it("rolls back everything when a part fails", async () => {
    const { t } = await setup();
    const unknownMessage = randomUUID();
    await assert.rejects(runStage(t, unknownMessage, { extract: extraction() }), TicketValidationError);
    assert.equal((await rows("SELECT count(*)::int AS n FROM tickets WHERE source_message_id = $1", [unknownMessage]))[0].n, 0);
  });
});

describe("state machine", () => {
  async function ticketIn(t: TestTenant, status: TicketStatus): Promise<string> {
    const messageId = await createMessage(db.owner, t);
    const [created] = await tx(t.tenantId, (c) => createTicketsForMessage(c, {
      tenantId: t.tenantId, messageId, traceId: "x", actor: HUMAN,
      tickets: [{ issueIndex: 0, title: "t", summary: "", category: "bug", priority: "P3", priorityReason: "r", prioritySource: "rules", outbox: false }],
    }));
    await db.owner.query("UPDATE tickets SET status = $2 WHERE id = $1", [created!.ticketId, status]); // arrange only
    return created!.ticketId;
  }
  const statusEvents = async (id: string) => (await eventsOf(id)).filter((e) => e.type === "status_changed");

  it("every legal transition works and writes exactly one event", async () => {
    const { t } = await setup();
    for (const [from, targets] of Object.entries(TICKET_TRANSITIONS) as [TicketStatus, readonly TicketStatus[]][]) {
      for (const to of targets) {
        const id = await ticketIn(t, from);
        const view = await tx(t.tenantId, (c) => transitionTicket(c, { ticketId: id, to, actor: HUMAN, reason: "test" }));
        assert.equal(view.status, to, `${from} -> ${to}`);
        const events = await statusEvents(id);
        assert.equal(events.length, 1, `${from} -> ${to}`);
        assert.deepEqual(events[0]!.payload, { from, to, reason: "test" });
        assert.equal(events[0]!.actor_ref, "tester");
      }
    }
  });

  it("every illegal pair is rejected and changes nothing", async () => {
    const { t } = await setup();
    let checked = 0;
    for (const from of TICKET_STATUSES) {
      const id = await ticketIn(t, from);
      for (const to of TICKET_STATUSES) {
        if (canTransition(from, to)) continue;
        await assert.rejects(tx(t.tenantId, (c) => transitionTicket(c, { ticketId: id, to, actor: HUMAN })), IllegalTransitionError, `${from} -> ${to}`);
        checked++;
      }
      assert.equal((await rows("SELECT status FROM tickets WHERE id = $1", [id]))[0].status, from);
      assert.equal((await statusEvents(id)).length, 0);
    }
    const legal = Object.values(TICKET_TRANSITIONS).reduce((n, x) => n + x.length, 0);
    assert.equal(checked, TICKET_STATUSES.length ** 2 - legal);
  });

  it("resolved -> in_progress is rejected", async () => {
    const { t } = await setup();
    const id = await ticketIn(t, "resolved");
    await assert.rejects(tx(t.tenantId, (c) => transitionTicket(c, { ticketId: id, to: "in_progress", actor: HUMAN })), (e) => e instanceof IllegalTransitionError && e.from === "resolved");
  });

  it("sets resolved_at on resolve and clears it on reopen", async () => {
    const { t } = await setup();
    const id = await ticketIn(t, "in_progress");
    assert.ok((await tx(t.tenantId, (c) => transitionTicket(c, { ticketId: id, to: "resolved", actor: HUMAN }))).resolvedAt);
    assert.equal((await tx(t.tenantId, (c) => transitionTicket(c, { ticketId: id, to: "reopened", actor: HUMAN }))).resolvedAt, null);
  });

  it("two concurrent transitions: exactly one wins, the other fails, one event", async () => {
    const { t } = await setup();
    for (const expected of [true, false]) {
      const id = await ticketIn(t, "received");
      const attempt = () => tx(t.tenantId, (c) => transitionTicket(c, { ticketId: id, to: "triaged", actor: HUMAN, ...(expected && { expected: "received" as const }) }));
      const results = await Promise.allSettled([attempt(), attempt()]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `expected=${expected}`);
      const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.ok(failure.reason instanceof (expected ? StatusConflictError : IllegalTransitionError));
      assert.equal((await statusEvents(id)).length, 1);
    }
  });

  it("an unknown ticket is not found", async () => {
    const { t } = await setup();
    await assert.rejects(tx(t.tenantId, (c) => transitionTicket(c, { ticketId: randomUUID(), to: "triaged", actor: HUMAN })), TicketNotFoundError);
  });
});

describe("patch", () => {
  async function fresh() {
    const { t, messageId } = await setup();
    await runStage(t, messageId, { extract: extraction({ issues: [issue({ severity_signals: [] })] }) });
    return { t, ticketId: (await ticketsOf(messageId))[0].id as string };
  }

  it("overrides priority, assignee and status with events, recomputed SLA and one audit row", async () => {
    const { t, ticketId } = await fresh();
    const member = await createMember(db.owner, t.tenantId);
    const view = await tx(t.tenantId, (c) => patchTicket(c, ticketId, { priority: "P1", assigneeId: member, status: "triaged" }, HUMAN));
    assert.deepEqual([view.priority, view.prioritySource, view.priorityReason, view.assigneeId, view.status], ["P1", "human", "manual override", member, "triaged"]);
    const sla = await rows("SELECT extract(epoch FROM sla_ack_due - created_at)/60 AS ack FROM tickets WHERE id = $1", [ticketId]);
    assert.equal(Number(sla[0].ack), 15);
    assert.deepEqual((await eventsOf(ticketId)).map((e) => e.type), ["created", "priority_changed", "assignee_changed", "status_changed"]);
    const audit = await rows("SELECT actor, action, target, diff FROM audit_log WHERE target = $1", [`ticket:${ticketId}`]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor, "human:tester");
    assert.equal(audit[0].action, "ticket.patch");
    assert.deepEqual(Object.keys(audit[0].diff).sort(), ["assigneeId", "priority", "status"]);
  });

  it("is all-or-nothing: an illegal status leaves the other changes unapplied", async () => {
    const { t, ticketId } = await fresh();
    await assert.rejects(tx(t.tenantId, (c) => patchTicket(c, ticketId, { priority: "P1", status: "resolved" }, HUMAN)), IllegalTransitionError);
    const [row] = await rows("SELECT priority, status FROM tickets WHERE id = $1", [ticketId]);
    assert.deepEqual([row.priority, row.status], ["P3", "received"]);
    assert.equal((await eventsOf(ticketId)).length, 1);
    assert.equal((await rows("SELECT count(*)::int AS n FROM audit_log WHERE target = $1", [`ticket:${ticketId}`]))[0].n, 0);
  });

  it("rejects an unknown assignee, and a no-op patch writes nothing", async () => {
    const { t, ticketId } = await fresh();
    await assert.rejects(tx(t.tenantId, (c) => patchTicket(c, ticketId, { assigneeId: randomUUID() }, HUMAN)), (e) => e instanceof TicketValidationError && e.code === "unknown_assignee");
    await tx(t.tenantId, (c) => patchTicket(c, ticketId, { priority: "P3", status: "received" }, HUMAN));
    assert.equal((await eventsOf(ticketId)).length, 1);
    assert.equal((await rows("SELECT count(*)::int AS n FROM audit_log WHERE target = $1", [`ticket:${ticketId}`]))[0].n, 0);
  });

  it("cannot assign a member of another tenant", async () => {
    const { t, ticketId } = await fresh();
    const other = await createTenant(db.owner);
    const foreign = await createMember(db.owner, other.tenantId);
    await assert.rejects(tx(t.tenantId, (c) => patchTicket(c, ticketId, { assigneeId: foreign }, HUMAN)), TicketValidationError);
  });
});

describe("list", () => {
  it("filters, and pages through every ticket once in a stable newest-first order", async () => {
    const { t } = await setup();
    const messageId = await createMessage(db.owner, t);
    // One transaction => identical created_at for all seven: the id tiebreaker must keep the order total.
    await tx(t.tenantId, (c) => createTicketsForMessage(c, {
      tenantId: t.tenantId, messageId, traceId: "x", actor: HUMAN,
      tickets: Array.from({ length: 7 }, (_, i) => ({
        issueIndex: i, title: `t${i}`, summary: "", category: i % 2 ? "ui" as const : "bug" as const, priority: i < 3 ? "P1" as const : "P3" as const,
        priorityReason: "r", prioritySource: "rules" as const, outbox: false,
      })),
    }));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await tx(t.tenantId, (c) => listTickets(c, { limit: 3, ...(cursor && { cursor }) }));
      seen.push(...r.items.filter((i) => i.sourceMessageId === messageId).map((i) => i.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    assert.equal(new Set(seen).size, 7);
    const again = (await tx(t.tenantId, (c) => listTickets(c, { limit: 100 }))).items.filter((i) => i.sourceMessageId === messageId).map((i) => i.id);
    assert.deepEqual(seen, again);
    const p1 = await tx(t.tenantId, (c) => listTickets(c, { limit: 100, priority: "P1" }));
    assert.equal(p1.items.filter((i) => i.sourceMessageId === messageId).length, 3);
    const ui = await tx(t.tenantId, (c) => listTickets(c, { limit: 100, category: "ui", status: "received" }));
    assert.equal(ui.items.filter((i) => i.sourceMessageId === messageId).length, 3);
    await assert.rejects(tx(t.tenantId, (c) => listTickets(c, { limit: 3, cursor: "garbage" })), TicketValidationError);
  });
});

describe("tenant isolation", () => {
  it("another tenant can neither see, change nor list a ticket", async () => {
    const a = await setup();
    const b = await createTenant(db.owner);
    await runStage(a.t, a.messageId, { extract: extraction() });
    const ticketId = (await ticketsOf(a.messageId))[0].id as string;
    assert.equal(await tx(b.tenantId, (c) => getTicket(c, ticketId)), null);
    await assert.rejects(tx(b.tenantId, (c) => transitionTicket(c, { ticketId, to: "triaged", actor: HUMAN })), TicketNotFoundError);
    await assert.rejects(tx(b.tenantId, (c) => patchTicket(c, ticketId, { priority: "P4" }, HUMAN)), TicketNotFoundError);
    assert.ok(!(await tx(b.tenantId, (c) => listTickets(c, { limit: 100 }))).items.some((i) => i.id === ticketId));
    assert.equal((await rows("SELECT priority FROM tickets WHERE id = $1", [ticketId]))[0].priority, "P1");
  });
});

describe("end to end through the real orchestrator", () => {
  it("an ingested message ends with a ticket and its outbox rows, and logs carry no ticket text", async () => {
    const logs: unknown[] = [];
    const stages = createDefaultStageRegistry({ extract: async () => extraction() });
    stages.register("ticket", ticketStage());
    const o = new Orchestrator({
      pool: db.worker, redis, stages, log: (e) => logs.push(e),
      consumer: { blockMs: 30, maxAttempts: 3, backoffBaseMs: 5, backoffMaxMs: 20, minIdleMs: 500, reclaimIntervalMs: 50 },
    });
    await o.start();
    try {
      const { t, messageId } = await setup();
      await new QueueProducer(redis).enqueue({ stage: "ingest", tenantId: t.tenantId, conversationId: t.conversationId, traceId: "e2e", payload: { messageId } });
      await waitFor(async () => (await rows("SELECT status FROM pipeline_runs WHERE message_id = $1", [messageId]))[0]?.status === "completed");
      const [ticket] = await ticketsOf(messageId);
      assert.ok(ticket);
      assert.equal(ticket.title.includes(MARKER), true);
      assert.equal((await outboxOf(ticket.id)).length, 2);
      const run = (await rows("SELECT stage_results FROM pipeline_runs WHERE message_id = $1", [messageId]))[0];
      assert.deepEqual(run.stage_results.ticket, { outcome: "tickets", ticketIds: [ticket.id], duplicates: [] });
      assert.ok(!JSON.stringify(logs).includes(MARKER));
      assert.equal(await redis.xlen("q.dlq"), 0);
    } finally {
      await o.close();
    }
  });
});
