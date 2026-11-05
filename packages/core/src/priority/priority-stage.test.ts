import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { withTenant } from "@relay/db";
import type { ExtractionOutcome, ExtractionResult } from "@relay/shared";
import { patchTicket } from "../tickets/service.js";
import { ticketStage } from "../tickets/stage.js";
import type { StageContext } from "../orchestrator/index.js";
import { createMember, createMessage, createTenant, createTestDb, type TestDb, type TestTenant } from "../testing/fixtures.js";
import { priorityStage } from "./stage.js";

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.dispose(); });

const issue = (over: Record<string, unknown> = {}) => ({
  title: "Checkout fails", summary: "Card payments return 500", category: "bug" as const, product_area: "checkout",
  steps_to_reproduce: [], expected: null, actual: null, environment: {}, severity_signals: [] as string[],
  missing_info: [], confidence: 0.9, ...over,
});
const extraction = (over: Partial<ExtractionResult> = {}): ExtractionResult => ({
  kind: "extracted", language: "en", is_complaint: true, off_topic: false, issues: [issue()], contains_sensitive_data: false,
  sentiment: "neutral", confidence: 0.9, missing_info: [], ...over,
});
const HUMAN = { type: "human", ref: "tester" } as const;

const NOW = new Date("2026-11-05T12:00:00Z");

async function setup(opts: { tier?: "free" | "paid" | "enterprise" } = {}): Promise<TestTenant> {
  const t = await createTenant(db.owner);
  await db.owner.query("UPDATE clients SET tier = $2 WHERE tenant_id = $1", [t.tenantId, opts.tier ?? "free"]);
  return t;
}

const ctxFor = (t: TestTenant, messageId: string, results: Record<string, unknown>, stage: "priority" | "ticket"): StageContext => ({
  tenantId: t.tenantId, conversationId: t.conversationId, messageId, traceId: "trace-p", stage, attempt: 1, results,
  db: (fn) => withTenant(db.worker, t.tenantId, fn),
  signal: new AbortController().signal,
});

/** Runs the real priority stage, then the real ticket stage with its decisions. Returns the created ticket ids. */
async function runPipeline(t: TestTenant, outcome: ExtractionOutcome, messageId?: string): Promise<{ messageId: string; ticketIds: string[]; decisions: unknown[] }> {
  const mid = messageId ?? (await createMessage(db.owner, t));
  const priority = await priorityStage({ now: () => NOW })(ctxFor(t, mid, { extract: outcome }, "priority"));
  const ticket = await ticketStage()(ctxFor(t, mid, { extract: outcome, priority: priority.result }, "ticket"));
  return {
    messageId: mid,
    ticketIds: (ticket.result as { ticketIds: string[] }).ticketIds,
    decisions: (priority.result as { decisions: unknown[] }).decisions,
  };
}

const ticketRow = async (id: string) => (await db.owner.query(
  `SELECT priority, priority_source, priority_reason, role_needed, assignee_id,
          EXTRACT(EPOCH FROM (sla_ack_due - created_at))/60 AS ack_min,
          EXTRACT(EPOCH FROM (sla_resolve_due - created_at))/60 AS resolve_min
     FROM tickets WHERE id = $1`, [id])).rows[0];

describe("priority stage with the real ticket stage", () => {
  it("one decision per issue, stored with the ticket, with SLA dates from the matching policy", async () => {
    const t = await setup();
    const out = await runPipeline(t, extraction());
    assert.equal(out.decisions.length, 1);
    const row = await ticketRow(out.ticketIds[0]!);
    assert.equal(row.priority, "P3");
    assert.equal(row.priority_source, "rules");
    assert.match(row.priority_reason, /^rules: bug base 3/);
    assert.equal(row.role_needed, "developer");
    assert.equal(Number(row.ack_min), 1440, "P3 ack target from sla_policies");
    assert.equal(Number(row.resolve_min), 10080, "P3 resolve target from sla_policies");
  });

  it("enterprise client with a payment failure is P1 with the P1 SLA targets", async () => {
    const t = await setup({ tier: "enterprise" });
    const out = await runPipeline(t, extraction({ issues: [issue({ severity_signals: ["payment_failure"] })] }));
    const row = await ticketRow(out.ticketIds[0]!);
    assert.equal(row.priority, "P1");
    assert.equal(Number(row.ack_min), 15);
    assert.equal(Number(row.resolve_min), 240);
  });

  it("a question is P4 and routed to pm", async () => {
    const t = await setup();
    const out = await runPipeline(t, extraction({ issues: [issue({ category: "question" as const })] }));
    const row = await ticketRow(out.ticketIds[0]!);
    assert.equal(row.priority, "P4");
    assert.equal(row.role_needed, "pm");
  });

  it("a routing rule sets the role and is recorded in the reason", async () => {
    const t = await setup();
    await db.owner.query(
      "INSERT INTO routing_rules (tenant_id, position, condition_json, action_json) VALUES ($1, 1, $2, $3)",
      [t.tenantId, JSON.stringify({ category: "bug" }), JSON.stringify({ role: "tester", tracker_labels: ["qa"] })],
    );
    const out = await runPipeline(t, extraction());
    const row = await ticketRow(out.ticketIds[0]!);
    assert.equal(row.role_needed, "tester");
    assert.match(row.priority_reason, /route rule 1 -> tester/);
    assert.deepEqual((out.decisions[0] as { labels: string[] }).labels, ["qa"]);
  });

  it("an on-call developer is assigned, and the ticket carries the assignee", async () => {
    const t = await setup();
    const dev = await createMember(db.owner, t.tenantId, "developer");
    await db.owner.query(
      "INSERT INTO on_call (tenant_id, role, member_id, starts_at, ends_at) VALUES ($1, 'developer', $2, now() - interval '1 hour', now() + interval '1 hour')",
      [t.tenantId, dev],
    );
    const out = await runPipeline(t, extraction());
    assert.equal((await ticketRow(out.ticketIds[0]!)).assignee_id, dev);
  });

  it("with no active member for the role, the ticket is a role broadcast with no assignee", async () => {
    const t = await setup();
    const out = await runPipeline(t, extraction({ issues: [issue({ category: "ui" as const })] }));
    const row = await ticketRow(out.ticketIds[0]!);
    assert.equal(row.role_needed, "designer");
    assert.equal(row.assignee_id, null);
  });

  it("a fallback extraction gets no decisions and the ticket stage keeps its triage ticket", async () => {
    const t = await setup();
    const out = await runPipeline(t, { kind: "fallback", reason: "timeout" });
    assert.deepEqual(out.decisions, []);
    const row = await ticketRow(out.ticketIds[0]!);
    assert.equal(row.priority, "P3");
    assert.match(row.priority_reason, /provisional: extraction_fallback:timeout/);
  });

  it("an off-topic message gets no decisions and no tickets", async () => {
    const t = await setup();
    const out = await runPipeline(t, extraction({ off_topic: true }));
    assert.deepEqual(out.decisions, []);
    assert.deepEqual(out.ticketIds, []);
  });

  it("a human override via patchTicket sets priority_source human, moves the SLA and writes the audit row", async () => {
    const t = await setup();
    const out = await runPipeline(t, extraction());
    const ticketId = out.ticketIds[0]!;
    await withTenant(db.worker, t.tenantId, (c) => patchTicket(c, ticketId, { priority: "P1" }, HUMAN));
    const row = await ticketRow(ticketId);
    assert.equal(row.priority, "P1");
    assert.equal(row.priority_source, "human");
    assert.equal(Number(row.ack_min), 15);
    const audit = (await db.owner.query("SELECT action, diff FROM audit_log WHERE target = $1", [`ticket:${ticketId}`])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.action, "ticket.patch");
    assert.deepEqual(audit[0]!.diff.priority, { from: "P3", to: "P1" });
    const events = (await db.owner.query("SELECT type FROM ticket_events WHERE ticket_id = $1 AND type = 'priority_changed'", [ticketId])).rows;
    assert.equal(events.length, 1);
  });

  it("the stage writes nothing: no tickets, events or audit rows come from the priority stage alone", async () => {
    const t = await setup();
    const messageId = await createMessage(db.owner, t);
    await priorityStage({ now: () => NOW })(ctxFor(t, messageId, { extract: extraction() }, "priority"));
    assert.equal((await db.owner.query("SELECT 1 FROM tickets WHERE tenant_id = $1", [t.tenantId])).rowCount, 0);
    assert.equal((await db.owner.query("SELECT 1 FROM audit_log WHERE tenant_id = $1", [t.tenantId])).rowCount, 0);
  });
});
