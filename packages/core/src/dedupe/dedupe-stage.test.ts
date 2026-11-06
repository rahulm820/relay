import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { withTenant } from "@relay/db";
import type { ExtractionResult } from "@relay/shared";
import { ticketStage } from "../tickets/stage.js";
import { createTicketsForMessage } from "../tickets/service.js";
import { priorityStage } from "../priority/stage.js";
import type { StageContext } from "../orchestrator/index.js";
import { createMessage, createTenant, createTestDb, type TestDb, type TestTenant } from "../testing/fixtures.js";
import { dedupeStage } from "./stage.js";

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.dispose(); });

const DIMS = 1024;
/** Unit vector along axis 0: the stored ticket's embedding. */
const BASE = [1, ...Array(DIMS - 1).fill(0)];
/** A unit vector whose cosine similarity to BASE is exactly `s`. */
const at = (s: number): number[] => [s, Math.sqrt(1 - s * s), ...Array(DIMS - 2).fill(0)];
/** A unit vector orthogonal to BASE (similarity 0). */
const ORTHOGONAL = [0, 1, ...Array(DIMS - 2).fill(0)];

const NOW = new Date("2026-11-06T12:00:00Z");
const NOOP = new AbortController().signal;

const issue = (over: Record<string, unknown> = {}) => ({
  title: "Checkout fails", summary: "Card payments return 500", category: "bug" as const, product_area: "checkout",
  steps_to_reproduce: [], expected: null, actual: null, environment: {}, severity_signals: [] as string[],
  missing_info: [], confidence: 0.9, ...over,
});
const extraction = (over: Partial<ExtractionResult> = {}): ExtractionResult => ({
  kind: "extracted", language: "en", is_complaint: true, off_topic: false, issues: [issue()], contains_sensitive_data: false,
  sentiment: "neutral", confidence: 0.9, missing_info: [], ...over,
});

const ctxFor = (t: TestTenant, messageId: string, results: Record<string, unknown>, stage: string): StageContext => ({
  tenantId: t.tenantId, conversationId: t.conversationId, messageId, traceId: "trace-d", stage: stage as StageContext["stage"], attempt: 1, results,
  db: (fn) => withTenant(db.worker, t.tenantId, fn), signal: NOOP,
});

/** Creates an existing open ticket with an embedding, through the real insert path. */
async function existingTicket(t: TestTenant, over: { productArea?: string | null; embedding?: number[]; category?: "bug" | "ui"; status?: string } = {}): Promise<string> {
  const messageId = await createMessage(db.owner, t, "earlier complaint");
  const [created] = await withTenant(db.worker, t.tenantId, (c) => createTicketsForMessage(c, {
    tenantId: t.tenantId, messageId, traceId: "seed", actor: { type: "system", ref: "test" },
    tickets: [{
      issueIndex: 0, title: "Earlier checkout failure", summary: "payments fail", category: over.category ?? "bug", priority: "P3",
      priorityReason: "r", prioritySource: "rules", outbox: false, productArea: over.productArea === undefined ? "checkout" : over.productArea,
      embedding: over.embedding ?? BASE,
    }],
  }));
  if (over.status) await db.owner.query("UPDATE tickets SET status = $2 WHERE id = $1", [created!.ticketId, over.status]);
  return created!.ticketId;
}

/** Runs dedupe with a stubbed embedding of `vector` for every issue. */
const runDedupe = (t: TestTenant, messageId: string, vector: number[] | Error, threshold = 0.9) => {
  const embed = async () => { if (vector instanceof Error) throw vector; return vector; };
  return dedupeStage({ embed, similarity: threshold, windowHours: 72 })(ctxFor(t, messageId, { extract: extraction() }, "dedupe"));
};

const matchesOf = (out: { result: Record<string, unknown> }) => (out.result as { matches: { ticketId: string; similarity: number; affectedClientCount: number; issueIndex: number }[] }).matches;

describe("dedupe stage: matching", () => {
  it("a near-identical complaint in the same area matches the open ticket, with the count it will have", async () => {
    const t = await createTenant(db.owner);
    const ticketId = await existingTicket(t);
    const messageId = await createMessage(db.owner, t);
    const m = matchesOf(await runDedupe(t, messageId, at(0.97)));
    assert.equal(m.length, 1);
    assert.equal(m[0]!.ticketId, ticketId);
    assert.equal(m[0]!.affectedClientCount, 2);
    assert.ok(Math.abs(m[0]!.similarity - 0.97) < 1e-3);
  });

  it("a similar complaint in a different product area is not merged", async () => {
    const t = await createTenant(db.owner);
    await existingTicket(t, { productArea: "billing" });
    const messageId = await createMessage(db.owner, t);
    assert.deepEqual(matchesOf(await runDedupe(t, messageId, BASE)), []);
  });

  it("similarity below the threshold does not match", async () => {
    const t = await createTenant(db.owner);
    await existingTicket(t);
    const messageId = await createMessage(db.owner, t);
    assert.deepEqual(matchesOf(await runDedupe(t, messageId, at(0.5))), []);
  });

  it("tenant isolation: an identical ticket in another tenant is never matched", async () => {
    const other = await createTenant(db.owner);
    await existingTicket(other);
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    assert.deepEqual(matchesOf(await runDedupe(t, messageId, BASE)), []);
  });

  it("resolved and quarantined tickets are not candidates", async () => {
    const t = await createTenant(db.owner);
    await existingTicket(t, { status: "resolved" });
    await existingTicket(t, { status: "quarantined" });
    const messageId = await createMessage(db.owner, t);
    assert.deepEqual(matchesOf(await runDedupe(t, messageId, BASE)), []);
  });

  it("an embedding failure is not an error: the complaint simply has no match", async () => {
    const t = await createTenant(db.owner);
    await existingTicket(t);
    const messageId = await createMessage(db.owner, t);
    const out = await runDedupe(t, messageId, new Error("provider down"));
    assert.deepEqual(matchesOf(out), []);
    assert.deepEqual((out.result as { embeddings: unknown[] }).embeddings, [null]);
  });

  it("without an embedder the stage does nothing and says why", async () => {
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    const out = await dedupeStage({ similarity: 0.9, windowHours: 72 })(ctxFor(t, messageId, { extract: extraction() }, "dedupe"));
    assert.equal((out.result as { reason: string }).reason, "embedding_disabled");
  });

  it("sensitive extractions are never matched", async () => {
    const t = await createTenant(db.owner);
    await existingTicket(t);
    const messageId = await createMessage(db.owner, t);
    const embed = async () => BASE;
    const out = await dedupeStage({ embed, similarity: 0.9, windowHours: 72 })(
      ctxFor(t, messageId, { extract: extraction({ contains_sensitive_data: true }) }, "dedupe"));
    assert.deepEqual(matchesOf(out), []);
  });
});

describe("duplicates through the real priority and ticket stages", () => {
  it("one ticket, count 2, a linked event, and no second ticket; replays do not bump the count again", async () => {
    const t = await createTenant(db.owner);
    const ticketId = await existingTicket(t);
    const messageId = await createMessage(db.owner, t);
    const extract = extraction();
    const dedupe = await runDedupe(t, messageId, at(0.97));
    const priority = await priorityStage({ now: () => NOW })(ctxFor(t, messageId, { extract, dedupe: dedupe.result }, "priority"));
    const run = () => ticketStage()(ctxFor(t, messageId, { extract, dedupe: dedupe.result, priority: priority.result }, "ticket"));

    const first = await run();
    assert.deepEqual((first.result as { ticketIds: string[] }).ticketIds, []);
    assert.deepEqual((first.result as { duplicates: { ticketId: string }[] }).duplicates.map((d) => d.ticketId), [ticketId]);

    const counts = await db.owner.query("SELECT affected_client_count FROM tickets WHERE id = $1", [ticketId]);
    assert.equal(counts.rows[0]!.affected_client_count, 2);
    const total = await db.owner.query("SELECT count(*)::int AS n FROM tickets WHERE tenant_id = $1", [t.tenantId]);
    assert.equal(total.rows[0]!.n, 1, "only the original ticket exists");
    const events = await db.owner.query("SELECT payload FROM ticket_events WHERE ticket_id = $1 AND type = 'duplicate_linked'", [ticketId]);
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0]!.payload.messageId, messageId);

    await run();
    assert.equal((await db.owner.query("SELECT affected_client_count FROM tickets WHERE id = $1", [ticketId])).rows[0]!.affected_client_count, 2, "replay is a no-op");
  });

  it("the duplicate re-evaluates priority upward, using the count, and sets SLA from the new priority", async () => {
    const t = await createTenant(db.owner);
    const ticketId = await existingTicket(t);
    const messageId = await createMessage(db.owner, t);
    // A payment failure makes the duplicate P1 by signal floor, which is more urgent than the existing P3.
    const extract = extraction({ issues: [issue({ severity_signals: ["payment_failure"] })] });
    const dedupe = await dedupeStage({ embed: async () => at(0.97), similarity: 0.9, windowHours: 72 })(ctxFor(t, messageId, { extract }, "dedupe"));
    const priority = await priorityStage({ now: () => NOW })(ctxFor(t, messageId, { extract, dedupe: dedupe.result }, "priority"));
    await ticketStage()(ctxFor(t, messageId, { extract, dedupe: dedupe.result, priority: priority.result }, "ticket"));

    const row = (await db.owner.query("SELECT priority, priority_source, EXTRACT(EPOCH FROM (sla_ack_due - created_at))/60 AS ack FROM tickets WHERE id = $1", [ticketId])).rows[0]!;
    assert.equal(row.priority, "P1");
    assert.equal(row.priority_source, "rules");
    assert.equal(Number(row.ack), 15);
    const changed = await db.owner.query("SELECT payload FROM ticket_events WHERE ticket_id = $1 AND type = 'priority_changed'", [ticketId]);
    assert.equal(changed.rows[0]!.payload.reason, "duplicate");
  });

  it("a human-set priority is never changed by a duplicate", async () => {
    const t = await createTenant(db.owner);
    const ticketId = await existingTicket(t);
    await db.owner.query("UPDATE tickets SET priority_source = 'human' WHERE id = $1", [ticketId]);
    const messageId = await createMessage(db.owner, t);
    const extract = extraction({ issues: [issue({ severity_signals: ["payment_failure"] })] });
    const dedupe = await dedupeStage({ embed: async () => at(0.97), similarity: 0.9, windowHours: 72 })(ctxFor(t, messageId, { extract }, "dedupe"));
    const priority = await priorityStage({ now: () => NOW })(ctxFor(t, messageId, { extract, dedupe: dedupe.result }, "priority"));
    await ticketStage()(ctxFor(t, messageId, { extract, dedupe: dedupe.result, priority: priority.result }, "ticket"));
    assert.equal((await db.owner.query("SELECT priority FROM tickets WHERE id = $1", [ticketId])).rows[0]!.priority, "P3");
  });

  it("a duplicate of a synced ticket queues one github.comment outbox row, keyed per message and issue", async () => {
    const t = await createTenant(db.owner);
    const ticketId = await existingTicket(t);
    await db.owner.query(
      `INSERT INTO tracker_issues (tenant_id, ticket_id, provider, repo_ref, external_issue_number, external_issue_url, sync_status, idempotency_key)
       VALUES ($1, $2, 'github', 'acme/app', 42, 'https://github.com/acme/app/issues/42', 'created', $3)`,
      [t.tenantId, ticketId, `github:${t.tenantId}:${ticketId}:general`],
    );
    const messageId = await createMessage(db.owner, t);
    const extract = extraction();
    const dedupe = await runDedupe(t, messageId, at(0.97));
    const priority = await priorityStage({ now: () => NOW })(ctxFor(t, messageId, { extract, dedupe: dedupe.result }, "priority"));
    await ticketStage()(ctxFor(t, messageId, { extract, dedupe: dedupe.result, priority: priority.result }, "ticket"));
    await ticketStage()(ctxFor(t, messageId, { extract, dedupe: dedupe.result, priority: priority.result }, "ticket"));
    const rows = (await db.owner.query("SELECT kind, payload, idempotency_key FROM outbox WHERE tenant_id = $1 AND kind = 'github.comment'", [t.tenantId])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.payload.ticketId, ticketId);
    assert.equal(rows[0]!.idempotency_key, `github-comment:${t.tenantId}:${ticketId}:${messageId}:0`);
  });

  it("a new complaint stores its embedding and product area, so later complaints can match it", async () => {
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    const extract = extraction();
    const dedupe = await runDedupe(t, messageId, ORTHOGONAL);
    const priority = await priorityStage({ now: () => NOW })(ctxFor(t, messageId, { extract, dedupe: dedupe.result }, "priority"));
    const out = await ticketStage()(ctxFor(t, messageId, { extract, dedupe: dedupe.result, priority: priority.result }, "ticket"));
    const ticketId = (out.result as { ticketIds: string[] }).ticketIds[0]!;
    const row = (await db.owner.query("SELECT product_area, embedding IS NOT NULL AS has_embedding FROM tickets WHERE id = $1", [ticketId])).rows[0]!;
    assert.equal(row.product_area, "checkout");
    assert.equal(row.has_embedding, true);
  });
});
