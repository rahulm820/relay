DROP FUNCTION IF EXISTS relay_sync_health_all(integer);
DROP FUNCTION IF EXISTS relay_reconcile_candidates(integer, integer, integer, integer);
DROP INDEX IF EXISTS tracker_issues_reconcile;
ALTER TABLE tracker_issues DROP COLUMN IF EXISTS next_attempt_at, DROP COLUMN IF EXISTS sync_attempts;
