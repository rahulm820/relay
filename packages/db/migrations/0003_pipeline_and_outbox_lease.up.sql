-- Issue #6: durable pipeline state and a lease on outbox rows.

-- One run per inbound message. stage_results holds each finished stage's output, so a crashed
-- worker resumes without recomputing expensive stages (architecture §4.3).
CREATE TABLE pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  trace_id text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed')),
  current_stage text,
  stage_results jsonb NOT NULL DEFAULT '{}',
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pipeline_runs_tenant_status ON pipeline_runs (tenant_id, status);

ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pipeline_runs
  USING (tenant_id = relay_current_tenant()) WITH CHECK (tenant_id = relay_current_tenant());
GRANT SELECT, INSERT, UPDATE ON pipeline_runs TO relay_app;

-- Lease: a dispatcher claims a row by setting locked_by to a fresh token. Finishing the row needs the
-- same token, so a dispatcher that lost its lease cannot overwrite the new owner's result.
ALTER TABLE outbox ADD COLUMN locked_at timestamptz, ADD COLUMN locked_by uuid;

-- Due rows are pending rows whose time has come, plus rows stuck in 'processing' past the lease
-- (a dispatcher crashed mid-handler).
DROP FUNCTION relay_due_outbox(integer);
CREATE FUNCTION relay_due_outbox(p_limit integer, p_lease_seconds integer) RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT o.id, o.tenant_id FROM outbox o
        WHERE (o.status = 'pending' AND o.next_attempt_at <= now())
           OR (o.status = 'processing' AND o.locked_at < now() - make_interval(secs => p_lease_seconds))
        ORDER BY o.next_attempt_at LIMIT p_limit $$;
REVOKE ALL ON FUNCTION relay_due_outbox(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay_due_outbox(integer, integer) TO relay_app;
