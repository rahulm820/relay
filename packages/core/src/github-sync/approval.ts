// Issue draft approval/rejection (Issue #14, architecture §4.10.2). Approval never bypasses idempotency:
// a ticket whose general sync already reached GitHub gets `github.update_issue` (same shared key, so a
// second create is impossible), everyone else releases/creates through the existing `github.create_issue`
// row. Both decisions post to the ticket's Switch room through `switch.post_message`.
// Must run inside a tenant transaction: the row lock plus RLS make a double decision (or another
// tenant's draft) a conflict/not-found, never a second enqueue.
import { randomUUID } from "node:crypto";
import { githubIdempotencyKey, type OutboxKind } from "@relay/shared";
import type { Client } from "@relay/db";
import { enqueueOutbox } from "../outbox/index.js";

/** No row under this tenant's RLS: another tenant's id, or never existed. */
export class DraftNotFoundError extends Error {
  override name = "DraftNotFoundError";
  constructor() { super("issue draft not found"); }
}

/** The draft is not `pending` anymore (already approved/rejected/superseded). */
export class DraftConflictError extends Error {
  override name = "DraftConflictError";
  constructor(actual: string) { super(`draft is ${actual}, not pending`); }
}

interface LockedDraft {
  id: string;
  ticket_id: string;
  status: string;
}

/** Locks the draft row for the decision; RLS means an invisible row is simply not found. */
async function lockPendingDraft(c: Client, draftId: string): Promise<LockedDraft> {
  const { rows } = await c.query<LockedDraft>(
    "SELECT id, ticket_id, status FROM issue_drafts WHERE id = $1 FOR UPDATE", [draftId],
  );
  const row = rows[0];
  if (!row) throw new DraftNotFoundError();
  if (row.status !== "pending") throw new DraftConflictError(row.status);
  return row;
}

/** The decision goes to the ticket's room; a ticket without a room finishes with note `no_room`. */
async function notifyRoom(
  c: Client,
  a: { tenantId: string; draftId: string; ticketId: string; event: "approved" | "rejected"; decidedBy: string; reason?: string },
): Promise<void> {
  await enqueueOutbox(c, {
    kind: "switch.post_message" as OutboxKind,
    tenantId: a.tenantId,
    idempotencyKey: `draft-decision:${a.tenantId}:${a.draftId}`,
    traceId: randomUUID(),
    payload: { ticketId: a.ticketId, draftId: a.draftId, event: a.event, decidedBy: a.decidedBy, ...(a.reason ? { reason: a.reason } : {}) },
  });
}

async function audit(c: Client, decidedBy: string, action: string, draftId: string): Promise<void> {
  await c.query(
    "INSERT INTO audit_log (tenant_id, actor, action, target, diff) VALUES (relay_current_tenant(), $1, $2, $3, $4)",
    [decidedBy, action, `issue_drafts:${draftId}`, JSON.stringify({ fields: ["status", "decided_by", "decided_at"] })],
  );
}

export interface DraftDecision {
  draftId: string;
  ticketId: string;
  /** Which GitHub path the approval took: a fresh create, or an update of the general-sync issue. */
  path: "create" | "update";
}

/**
 * Approves a pending draft: `status = approved` with `decided_by`/`decided_at`, then exactly one GitHub
 * side effect through the outbox — `github.update_issue` when the ticket's issue already exists,
 * otherwise the shared-key `github.create_issue` row (released if it was staged for human approval).
 * A second decision on the same draft is a conflict; an unknown/foreign draft is not found.
 * Must run inside a tenant transaction.
 */
export async function approveIssueDraft(
  c: Client,
  a: { tenantId: string; draftId: string; decidedBy: string },
): Promise<DraftDecision> {
  const draft = await lockPendingDraft(c, a.draftId);
  const key = githubIdempotencyKey(a.tenantId, draft.ticket_id, "general");
  const tracker = (await c.query<{ sync_status: string }>(
    "SELECT sync_status FROM tracker_issues WHERE idempotency_key = $1", [key],
  )).rows[0];
  const issueExists = tracker?.sync_status === "created" || tracker?.sync_status === "closed";

  await c.query(
    "UPDATE issue_drafts SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1",
    [draft.id, a.decidedBy],
  );
  if (issueExists) {
    await enqueueOutbox(c, {
      kind: "github.update_issue" as OutboxKind,
      tenantId: a.tenantId,
      idempotencyKey: `draft-update:${a.tenantId}:${draft.ticket_id}`,
      traceId: randomUUID(),
      payload: { ticketId: draft.ticket_id, draftId: draft.id },
    });
  } else {
    // Release a staged (or previously failed) general row first; the enqueue below then no-ops on the
    // shared key, so the dispatcher sees exactly one create job either way. A failed row gets a fresh
    // attempt budget: the approval is an explicit instruction to create the issue now.
    await c.query(
      `UPDATE outbox SET status = 'pending', next_attempt_at = now(), attempts = 0, last_error = NULL
        WHERE kind = 'github.create_issue' AND idempotency_key = $1 AND status IN ('staged', 'failed')`,
      [key],
    );
    await enqueueOutbox(c, {
      kind: "github.create_issue",
      tenantId: a.tenantId,
      idempotencyKey: key,
      traceId: randomUUID(),
      payload: { ticketId: draft.ticket_id },
    });
  }
  await notifyRoom(c, { tenantId: a.tenantId, draftId: draft.id, ticketId: draft.ticket_id, event: "approved", decidedBy: a.decidedBy });
  await audit(c, a.decidedBy, "issue_drafts.approve", draft.id);
  return { draftId: draft.id, ticketId: draft.ticket_id, path: issueExists ? "update" : "create" };
}

/**
 * Rejects a pending draft: `status = rejected` with `reject_reason`, `decided_by` and `decided_at`.
 * No GitHub row of any kind is written; the decision is only recorded and announced to the room.
 * Must run inside a tenant transaction.
 */
export async function rejectIssueDraft(
  c: Client,
  a: { tenantId: string; draftId: string; decidedBy: string; reason: string },
): Promise<{ draftId: string; ticketId: string }> {
  const draft = await lockPendingDraft(c, a.draftId);
  await c.query(
    "UPDATE issue_drafts SET status = 'rejected', decided_by = $2, decided_at = now(), reject_reason = $3 WHERE id = $1",
    [draft.id, a.decidedBy, a.reason],
  );
  await notifyRoom(c, { tenantId: a.tenantId, draftId: draft.id, ticketId: draft.ticket_id, event: "rejected", decidedBy: a.decidedBy, reason: a.reason });
  await audit(c, a.decidedBy, "issue_drafts.reject", draft.id);
  return { draftId: draft.id, ticketId: draft.ticket_id };
}
