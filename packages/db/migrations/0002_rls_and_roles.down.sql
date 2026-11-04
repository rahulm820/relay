DROP FUNCTION IF EXISTS relay_due_outbox(integer);
DROP FUNCTION IF EXISTS relay_resolve_bot(uuid);
DROP OWNED BY relay_app, relay_api, relay_worker;  -- revokes grants in this database only
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','bots','chat_connections','integrations','members','on_call','clients',
    'conversations','messages','tickets','ticket_events','tracker_issues','issue_drafts',
    'routing_rules','sla_policies','outbox','llm_runs','audit_log']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS relay_current_tenant();
