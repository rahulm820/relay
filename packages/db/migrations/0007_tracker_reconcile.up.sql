-- Issue #20: bookkeeping for the GitHub reconcile job, and the two cross-tenant reads the worker needs.

-- sync_attempts counts reconcile claims that did not end in success (the retry budget); next_attempt_at is both
-- the backoff and the lease: a claimed row is pushed into the future, so no other worker takes it, and a worker
-- that crashes mid-call simply lets the row become eligible again.
ALTER TABLE tracker_issues
  ADD COLUMN sync_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz;
CREATE INDEX tracker_issues_reconcile ON tracker_issues (sync_status, next_attempt_at);

-- Rows the reconcile job should look at, across tenants (like relay_due_outbox). Claim each with withTenant afterwards.
--   pending/failed: past the grace period (so the pipeline stage that created the row is not raced) and inside the budget
--   created:        not refreshed for p_stale_seconds, so closed or deleted issues are noticed
-- Only general-mode GitHub rows: code-aware drafts (#13/#14) have their own approval path.
CREATE FUNCTION relay_reconcile_candidates(p_limit integer, p_grace_seconds integer, p_stale_seconds integer, p_budget integer)
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT t.id, t.tenant_id FROM tracker_issues t
        WHERE t.provider = 'github' AND t.sync_mode = 'general'
          AND coalesce(t.next_attempt_at, '-infinity') <= now()
          AND ((t.sync_status IN ('pending', 'failed') AND t.sync_attempts < p_budget
                AND coalesce(t.last_synced_at, t.created_at) <= now() - make_interval(secs => p_grace_seconds))
            OR (t.sync_status = 'created' AND t.last_synced_at <= now() - make_interval(secs => p_stale_seconds)))
        ORDER BY coalesce(t.last_synced_at, t.created_at) LIMIT p_limit $$;

-- Backlog and failure counts for the sync health endpoint, across all tenants (counts only, no row data).
CREATE FUNCTION relay_sync_health_all(p_budget integer)
  RETURNS TABLE (outbox_backlog integer, outbox_oldest_seconds integer, outbox_failed integer,
                 sync_pending integer, sync_failed integer, sync_created integer, sync_closed integer,
                 sync_failed_beyond_budget integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT
          (SELECT count(*) FROM outbox WHERE kind::text LIKE 'github.%' AND status IN ('pending', 'processing'))::integer,
          coalesce((SELECT extract(epoch FROM now() - min(created_at)) FROM outbox
                     WHERE kind::text LIKE 'github.%' AND status IN ('pending', 'processing')), 0)::integer,
          (SELECT count(*) FROM outbox WHERE kind::text LIKE 'github.%' AND status = 'failed')::integer,
          (SELECT count(*) FROM tracker_issues WHERE provider = 'github' AND sync_status = 'pending')::integer,
          (SELECT count(*) FROM tracker_issues WHERE provider = 'github' AND sync_status = 'failed')::integer,
          (SELECT count(*) FROM tracker_issues WHERE provider = 'github' AND sync_status = 'created')::integer,
          (SELECT count(*) FROM tracker_issues WHERE provider = 'github' AND sync_status = 'closed')::integer,
          (SELECT count(*) FROM tracker_issues WHERE provider = 'github' AND sync_status = 'failed' AND sync_attempts >= p_budget)::integer $$;

-- Worker only: the API has no use for cross-tenant reads.
REVOKE ALL ON FUNCTION relay_reconcile_candidates(integer, integer, integer, integer), relay_sync_health_all(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay_reconcile_candidates(integer, integer, integer, integer), relay_sync_health_all(integer) TO relay_worker;
