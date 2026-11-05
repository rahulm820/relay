import { listReconcileCandidates, withTenant, type Pool } from "@relay/db";
import { parseLabelMap } from "@relay/trackers";
import { loadTicket, recordIssueLinked } from "../github-sync/issue.js";
import type { ClaimedSync, ReconcileStore } from "./reconcile.js";

const ACTOR_REF = "job:github-reconcile";

export interface PgReconcileStoreOptions {
  pool: Pool;
  /** A pending/failed row must be this old (since its last attempt) before reconcile touches it. */
  graceSeconds: number;
  /** A created row is re-checked against GitHub after this long. */
  staleSeconds: number;
  /** Failed rows beyond this many reconcile attempts are left alone (and alerted on). */
  retryBudget: number;
}

interface ClaimedRow {
  id: string; ticket_id: string; repo_ref: string | null; sync_status: ClaimedSync["status"];
  external_issue_number: number | null; sync_attempts: number; idempotency_key: string;
}

/** Postgres implementation. Candidates come from a SECURITY DEFINER function; everything else runs under RLS. */
export function createPgReconcileStore(o: PgReconcileStoreOptions): ReconcileStore {
  const db = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(o.pool, tenantId, fn);
  // The idempotency key is kept next to the claimed row so every write targets exactly that row.
  const keys = new WeakMap<ClaimedSync, string>();
  const keyOf = (row: ClaimedSync) => keys.get(row)!;
  const secs = (n: number) => Math.max(0, Math.ceil(n));

  return {
    candidates: (limit) => listReconcileCandidates(o.pool, { limit, graceSeconds: o.graceSeconds, staleSeconds: o.staleSeconds, retryBudget: o.retryBudget }),

    claim: (cand, leaseSeconds) => db(cand.tenantId, async (c) => {
      // Compare-and-set: only one worker moves next_attempt_at out of the past. A created refresh costs no attempt.
      const { rows } = await c.query<ClaimedRow>(
        `UPDATE tracker_issues
            SET next_attempt_at = now() + make_interval(secs => $2),
                sync_attempts = sync_attempts + CASE WHEN sync_status = 'created' THEN 0 ELSE 1 END
          WHERE id = $1 AND provider = 'github' AND sync_status IN ('pending', 'failed', 'created')
            AND coalesce(next_attempt_at, '-infinity') <= now()
        RETURNING id, ticket_id, repo_ref, sync_status, external_issue_number, sync_attempts, idempotency_key`,
        [cand.id, leaseSeconds],
      );
      const r = rows[0];
      if (!r) return null;
      const row: ClaimedSync = { id: r.id, tenantId: cand.tenantId, ticketId: r.ticket_id, repo: r.repo_ref, status: r.sync_status, externalNumber: r.external_issue_number, attempts: r.sync_attempts };
      keys.set(row, r.idempotency_key);
      return row;
    }),

    integration: (tenantId) => db(tenantId, async (c) => {
      const { rows } = await c.query<{ repo_ref: string | null; credentials_ref: string | null; label_map_json: unknown }>(
        "SELECT repo_ref, credentials_ref, label_map_json FROM integrations WHERE provider = 'github' AND status = 'active' LIMIT 1");
      const r = rows[0];
      return r ? { repo: r.repo_ref, credentialsRef: r.credentials_ref, labelMap: parseLabelMap(r.label_map_json) } : null;
    }),

    ticket: (tenantId, ticketId) => db(tenantId, (c) => loadTicket(c, ticketId)),

    linked: (row, issue, closed, via) => db(row.tenantId, (c) => recordIssueLinked(c, {
      ticketId: row.ticketId, idempotencyKey: keyOf(row), repo: row.repo ?? "", issue, closed,
      eventType: via === "repair" ? "tracker.issue_repaired" : "tracker.issue_created", actorRef: ACTOR_REF, via: "reconcile",
    })).then(() => undefined),

    closed: (row) => db(row.tenantId, (c) => c.query(
      "UPDATE tracker_issues SET sync_status = 'closed', last_synced_at = now(), last_error = NULL, next_attempt_at = NULL WHERE id = $1", [row.id])).then(() => undefined),

    refreshed: (row) => db(row.tenantId, (c) => c.query(
      "UPDATE tracker_issues SET last_synced_at = now(), last_error = NULL, next_attempt_at = NULL WHERE id = $1", [row.id])).then(() => undefined),

    failed: (row, code, retryInSeconds) => db(row.tenantId, (c) => c.query(
      `UPDATE tracker_issues SET sync_status = 'failed', last_error = $2, last_synced_at = now(),
              next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`, [row.id, code, secs(retryInSeconds)])).then(() => undefined),

    deferred: (row, retryInSeconds) => db(row.tenantId, (c) => c.query(
      "UPDATE tracker_issues SET next_attempt_at = now() + make_interval(secs => $2) WHERE id = $1", [row.id, secs(retryInSeconds)])).then(() => undefined),
  };
}
