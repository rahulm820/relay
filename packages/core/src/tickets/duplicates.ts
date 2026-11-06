// Linking a duplicate complaint to an existing ticket (Issue #11). Runs in the ticket stage's transaction, so the
// count bump, priority re-evaluation, event and outbox row commit together, or not at all.
import type { Client } from "@relay/db";
import { PRIORITIES, type Priority, type PrioritySource } from "@relay/shared";
import { enqueueOutbox } from "../outbox/index.js";
import type { DuplicateMatch } from "../dedupe/result.js";
import type { PriorityDecision } from "./priority.js";
import type { Actor } from "./service.js";

export interface DuplicateLinkInput {
  tenantId: string;
  messageId: string;
  traceId: string;
  actor: Actor;
  matches: readonly DuplicateMatch[];
  /** Decisions from the priority stage, indexed by issue. Re-evaluation uses the one for each duplicate's issue. */
  decisions: readonly PriorityDecision[];
}

const LEVEL = Object.fromEntries(PRIORITIES.map((p, i) => [p, i])) as Record<Priority, number>;

export interface LinkedDuplicate { issueIndex: number; ticketId: string; linked: boolean }

/**
 * Links each match to its ticket. Replays are no-ops: a `duplicate_linked` event with the same message and issue index
 * means the count was already bumped. A human-set priority is never changed by re-evaluation.
 */
export async function linkDuplicates(c: Client, input: DuplicateLinkInput): Promise<LinkedDuplicate[]> {
  const out: LinkedDuplicate[] = [];
  for (const m of input.matches) {
    const seen = await c.query(
      "SELECT 1 FROM ticket_events WHERE ticket_id = $1 AND type = 'duplicate_linked' AND payload->>'messageId' = $2 AND (payload->>'issueIndex')::int = $3",
      [m.ticketId, input.messageId, m.issueIndex],
    );
    if ((seen.rowCount ?? 0) > 0) {
      out.push({ issueIndex: m.issueIndex, ticketId: m.ticketId, linked: false });
      continue;
    }

    const bumped = await c.query<{ priority: Priority; priority_source: PrioritySource; affected_client_count: number }>(
      `UPDATE tickets SET affected_client_count = affected_client_count + 1 WHERE id = $1
       RETURNING priority, priority_source, affected_client_count`,
      [m.ticketId],
    );
    const row = bumped.rows[0];
    if (!row) throw new Error("duplicate target ticket not found");

    await addEvent(c, m.ticketId, "duplicate_linked", input.actor, {
      messageId: input.messageId, issueIndex: m.issueIndex, similarity: Number(m.similarity.toFixed(4)),
      affectedClientCount: row.affected_client_count,
    });

    // Re-evaluate priority with the new count. Only raises; human overrides stay.
    const decision = input.decisions[m.issueIndex];
    if (decision && row.priority_source !== "human" && LEVEL[decision.priority] < LEVEL[row.priority]) {
      await c.query(
        `UPDATE tickets SET priority = $2, priority_source = $3, priority_reason = $4,
           sla_ack_due = created_at + (SELECT make_interval(mins => ack_minutes) FROM sla_policies WHERE priority = $2),
           sla_resolve_due = created_at + (SELECT make_interval(mins => resolve_minutes) FROM sla_policies WHERE priority = $2)
         WHERE id = $1`,
        [m.ticketId, decision.priority, decision.source, decision.reason.slice(0, 500)],
      );
      await addEvent(c, m.ticketId, "priority_changed", input.actor, { from: row.priority, to: decision.priority, reason: "duplicate" });
    }

    // Comment on the existing GitHub issue, if one was created. Not synced yet: the issue body already reflects the ticket.
    const synced = await c.query(
      "SELECT external_issue_number FROM tracker_issues WHERE ticket_id = $1 AND sync_status = 'created' AND external_issue_number IS NOT NULL LIMIT 1",
      [m.ticketId],
    );
    if ((synced.rowCount ?? 0) > 0) {
      await enqueueOutbox(c, {
        kind: "github.comment", tenantId: input.tenantId, traceId: input.traceId,
        idempotencyKey: `github-comment:${input.tenantId}:${m.ticketId}:${input.messageId}:${m.issueIndex}`,
        payload: { ticketId: m.ticketId, messageId: input.messageId, issueIndex: m.issueIndex },
      });
    }
    out.push({ issueIndex: m.issueIndex, ticketId: m.ticketId, linked: true });
  }
  return out;
}

async function addEvent(c: Client, ticketId: string, type: string, actor: Actor, payload: Record<string, unknown>): Promise<void> {
  await c.query(
    "INSERT INTO ticket_events (tenant_id, ticket_id, type, actor_type, actor_ref, payload, created_at) VALUES (relay_current_tenant(), $1, $2, $3, $4, $5, clock_timestamp())",
    [ticketId, type, actor.type, actor.ref, JSON.stringify(payload)],
  );
}
