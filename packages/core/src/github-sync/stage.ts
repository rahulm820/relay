// The `github-sync` pipeline stage (Issues #9/#12, architecture §4.10.1). Reports the GitHub sync state of
// this run's tickets so the stored stage result says where each one stands; it performs no writes and no
// network calls. Creation itself moved to the transactional outbox: the ticket stage writes the
// `tracker_issues` link and the `github.create_issue` row in one transaction (see enqueueTicketOutbox),
// and the outbox handler (handler.ts) makes the GitHub call with retries.
import { githubIdempotencyKey } from "@relay/shared";
import type { StageHandler } from "../orchestrator/index.js";
import { z } from "zod";

const TicketStageResult = z.object({ ticketIds: z.array(z.uuid()) });

/** Where a ticket stands in the general GitHub sync. */
export type TicketSyncState =
  | "queued"             // link row pending; the outbox handler will create the issue
  | "awaiting_approval"  // outbox row staged by approval_policy = human; dispatches on approval
  | "created"            // the issue exists on GitHub
  | "closed"             // the issue exists and is closed on GitHub
  | "failed"             // the last attempt failed; reconcile is the repair path
  | "quarantined"        // held for a human; nothing may leave the platform
  | "not_configured";    // no active integration or no repo selected: nothing was written

interface SyncStateRow {
  ticket_status: string | null;
  sync_status: string | null;
  outbox_status: string | null;
}

export function githubSyncStage(): StageHandler {
  return async (ctx) => {
    const parsed = TicketStageResult.safeParse(ctx.results["ticket"]);
    const ticketIds = parsed.success ? parsed.data.ticketIds : [];
    if (ticketIds.length === 0) return { result: { outcome: "no_tickets", tickets: [] } };

    const tickets = [];
    for (const ticketId of ticketIds) {
      const key = githubIdempotencyKey(ctx.tenantId, ticketId, "general");
      const { rows } = await ctx.db((c) => c.query<SyncStateRow>(
        `SELECT (SELECT status FROM tickets WHERE id = $1) AS ticket_status,
                (SELECT sync_status FROM tracker_issues WHERE idempotency_key = $2) AS sync_status,
                (SELECT status FROM outbox WHERE idempotency_key = $2 AND kind = 'github.create_issue') AS outbox_status`,
        [ticketId, key],
      ));
      tickets.push({ ticketId, state: stateOf(rows[0]) });
    }
    return { result: { outcome: "sync_state", tickets } };
  };
}

function stateOf(r: SyncStateRow | undefined): TicketSyncState {
  if (!r) return "not_configured";
  if (r.ticket_status === "quarantined" && !r.sync_status) return "quarantined";
  if (!r.sync_status) return "not_configured";
  if (r.sync_status === "created") return "created";
  if (r.sync_status === "closed") return "closed";
  if (r.sync_status === "failed") return "failed";
  return r.outbox_status === "staged" ? "awaiting_approval" : "queued";
}
