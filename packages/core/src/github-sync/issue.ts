// Pieces shared by the pipeline stage (stage.ts) and the reconcile job (reconcile.ts), so an issue created by
// either path has the same content and leaves the same trail on the ticket.
import { buildIssueBody, labelsFor, type ExternalIssue, type LabelMap } from "@relay/trackers";
import type { Client } from "@relay/db";
import type { SecretProvider } from "@relay/shared";

export interface TicketForIssue {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: string;
  priority_reason: string | null;
  status: string;
  affected_client_count: number;
  tracker_ref: string | null;
  tier: string | null;
}

/** Optional detail the extraction stage produced for this ticket. Absent when reconciling long after the fact. */
export interface ExtractedIssueDetail {
  steps_to_reproduce: string[];
  expected: string | null;
  actual: string | null;
  missing_info: string[];
}

/** Must run inside a tenant transaction (RLS scopes the read). */
export async function loadTicket(c: Client, ticketId: string): Promise<TicketForIssue | null> {
  const { rows } = await c.query<TicketForIssue>(
    `SELECT t.id, t.title, t.summary, t.category, t.priority, t.priority_reason, t.status,
            t.affected_client_count, t.tracker_ref, cl.tier
       FROM tickets t LEFT JOIN clients cl ON cl.id = t.client_id
      WHERE t.id = $1`,
    [ticketId],
  );
  return rows[0] ?? null;
}

/** Title, body and labels for the GitHub issue of a ticket. */
export function composeIssue(ticket: TicketForIssue, labelMap: LabelMap, detail?: ExtractedIssueDetail) {
  const body = buildIssueBody({
    ticketId: ticket.id,
    title: ticket.title,
    summary: ticket.summary,
    category: ticket.category,
    priority: ticket.priority,
    priorityReason: ticket.priority_reason,
    clientTier: ticket.tier,
    affectedClientCount: ticket.affected_client_count,
    stepsToReproduce: detail?.steps_to_reproduce,
    expected: detail?.expected ?? null,
    actual: detail?.actual ?? null,
    missingInfo: detail?.missing_info,
  });
  return { title: ticket.title, body, labels: labelsFor(ticket, labelMap) };
}

export type IssueEventType = "tracker.issue_created" | "tracker.issue_repaired" | "tracker.issue_updated";

/**
 * Records that the ticket's GitHub issue exists: marks the tracker_issues row `created` (or `closed` if the issue
 * is already closed), links the ticket, clears the retry state and appends one timeline event.
 * Must run inside a tenant transaction.
 */
export async function recordIssueLinked(
  c: Client,
  a: { ticketId: string; idempotencyKey: string; repo: string; issue: ExternalIssue; closed?: boolean; eventType: IssueEventType; actorRef: string; via?: string },
): Promise<void> {
  await c.query(
    `UPDATE tracker_issues SET sync_status = $5, external_issue_id = $2, external_issue_number = $3,
       external_issue_url = $4, repo_ref = $6, last_synced_at = now(), last_error = NULL, sync_attempts = 0, next_attempt_at = NULL
     WHERE idempotency_key = $1`,
    [a.idempotencyKey, a.issue.id, a.issue.number, a.issue.url, a.closed ? "closed" : "created", a.repo],
  );
  await c.query("UPDATE tickets SET tracker_ref = $2 WHERE id = $1", [a.ticketId, a.issue.url]);
  await c.query(
    `INSERT INTO ticket_events (tenant_id, ticket_id, type, actor_type, actor_ref, payload, created_at)
     VALUES (relay_current_tenant(), $1, $2, 'system', $3, $4, clock_timestamp())`,
    [a.ticketId, a.eventType, a.actorRef, JSON.stringify({ provider: "github", repo: a.repo, number: a.issue.number, url: a.issue.url, ...(a.via ? { via: a.via } : {}) })],
  );
}

/** Resolves integrations.credentials_ref (env:NAME) to the token. A missing, unsupported or unreadable ref is just "no token". */
export async function resolveToken(secrets: SecretProvider, ref: string | null): Promise<string | undefined> {
  if (!ref) return undefined;
  try {
    return (await secrets.get(ref))?.reveal();
  } catch {
    return undefined; // unsupported scheme or unreadable ref: treated as missing credentials
  }
}
