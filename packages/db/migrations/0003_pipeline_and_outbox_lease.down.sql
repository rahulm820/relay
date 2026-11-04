DROP FUNCTION IF EXISTS relay_due_outbox(integer, integer);
CREATE FUNCTION relay_due_outbox(p_limit integer) RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT o.id, o.tenant_id FROM outbox o
        WHERE o.status = 'pending' AND o.next_attempt_at <= now()
        ORDER BY o.next_attempt_at LIMIT p_limit $$;
REVOKE ALL ON FUNCTION relay_due_outbox(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay_due_outbox(integer) TO relay_app;
ALTER TABLE outbox DROP COLUMN IF EXISTS locked_at, DROP COLUMN IF EXISTS locked_by;
DROP TABLE IF EXISTS pipeline_runs;
