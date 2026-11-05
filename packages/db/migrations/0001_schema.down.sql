DROP TABLE IF EXISTS audit_log, llm_runs, outbox, sla_policies, routing_rules, issue_drafts,
  tracker_issues, ticket_events, tickets, messages, conversations, clients, on_call, members,
  integrations, chat_connections, bots, tenants CASCADE;
DROP TYPE IF EXISTS category, priority, priority_source, ticket_status, role, client_tier, channel,
  actor_type, approval_policy, sync_mode, sync_status, outbox_kind, outbox_status, bot_status,
  integration_status, draft_status, message_direction, chat_provider, tracker_provider,
  conversation_status;
DROP EXTENSION IF EXISTS vector;
