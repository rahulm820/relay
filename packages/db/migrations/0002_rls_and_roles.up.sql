-- Row-level security keyed on the per-transaction setting app.tenant_id, plus least-privilege roles.
-- Roles are cluster-wide, so they are created if missing and never dropped by `down`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'relay_app') THEN CREATE ROLE relay_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'relay_api') THEN CREATE ROLE relay_api NOLOGIN IN ROLE relay_app; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'relay_worker') THEN CREATE ROLE relay_worker NOLOGIN IN ROLE relay_app; END IF;
END $$;

-- NULL when unset or empty, so a connection with no tenant context matches no rows.
CREATE FUNCTION relay_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bots','chat_connections','integrations','members','on_call','clients',
    'conversations','messages','tickets','ticket_events','tracker_issues','issue_drafts',
    'routing_rules','sla_policies','outbox','llm_runs','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = relay_current_tenant()) WITH CHECK (tenant_id = relay_current_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = relay_current_tenant()) WITH CHECK (id = relay_current_tenant());

GRANT USAGE ON SCHEMA public TO relay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, bots, chat_connections, integrations, members, on_call,
  clients, conversations, messages, tickets, tracker_issues, issue_drafts, routing_rules,
  sla_policies, outbox, llm_runs TO relay_app;
-- Append-only: the app can add history but never rewrite it.
GRANT SELECT, INSERT ON ticket_events, audit_log TO relay_app;

-- Lookups that must happen before a tenant is known. SECURITY DEFINER runs as the migration owner,
-- so each exposes only the narrow answer below instead of widening RLS.
CREATE FUNCTION relay_resolve_bot(p_bot_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT tenant_id FROM bots WHERE id = p_bot_id $$;

CREATE FUNCTION relay_due_outbox(p_limit integer) RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT o.id, o.tenant_id FROM outbox o
        WHERE o.status = 'pending' AND o.next_attempt_at <= now()
        ORDER BY o.next_attempt_at LIMIT p_limit $$;

REVOKE ALL ON FUNCTION relay_resolve_bot(uuid), relay_due_outbox(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay_current_tenant(), relay_resolve_bot(uuid), relay_due_outbox(integer) TO relay_app;
