-- Relay schema (architecture §6). Enum labels mirror @relay/shared; a test keeps them in sync.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE category AS ENUM ('bug','ui','question','feature','billing','other');
CREATE TYPE priority AS ENUM ('P1','P2','P3','P4');
CREATE TYPE priority_source AS ENUM ('rules','llm','human');
CREATE TYPE ticket_status AS ENUM ('received','needs_info','triaged','assigned','in_progress','in_review','resolved','closed','quarantined','escalated','reopened');
CREATE TYPE role AS ENUM ('designer','developer','tester','pm');
CREATE TYPE client_tier AS ENUM ('free','paid','enterprise');
CREATE TYPE channel AS ENUM ('telegram','whatsapp');
CREATE TYPE actor_type AS ENUM ('system','agent','human');
CREATE TYPE approval_policy AS ENUM ('auto','human');
CREATE TYPE sync_mode AS ENUM ('general','code_aware');
CREATE TYPE sync_status AS ENUM ('pending','created','failed','closed');
CREATE TYPE outbox_kind AS ENUM ('github.create_issue','switch.create_room','client.send');
CREATE TYPE outbox_status AS ENUM ('pending','processing','done','failed');
CREATE TYPE bot_status AS ENUM ('pending','active','error','revoked');
CREATE TYPE integration_status AS ENUM ('active','error','revoked');
CREATE TYPE draft_status AS ENUM ('pending','approved','rejected','superseded');
CREATE TYPE message_direction AS ENUM ('in','out');
CREATE TYPE chat_provider AS ENUM ('slack','teams','mattermost','discord');
CREATE TYPE tracker_provider AS ENUM ('github','jira','linear');
CREATE TYPE conversation_status AS ENUM ('open','closed');

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'hackathon',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel channel NOT NULL,
  display_name text NOT NULL,
  status bot_status NOT NULL DEFAULT 'pending',
  credentials_ref text,            -- e.g. env:TELEGRAM_BOT_TOKEN; never a raw secret
  webhook_secret_hash text,
  webhook_url text,
  last_health_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider chat_provider NOT NULL,
  workspace_ref text,
  credentials_ref text,
  default_channel_ref text,
  switch_bridge_ref text,
  status integration_status NOT NULL DEFAULT 'active'
);

CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider tracker_provider NOT NULL,
  credentials_ref text,
  project_ref text,
  status integration_status NOT NULL DEFAULT 'active',
  repo_ref text,                                   -- owner/name for GitHub
  label_map_json jsonb NOT NULL DEFAULT '{}',
  approval_policy approval_policy NOT NULL DEFAULT 'auto',
  code_aware_enabled boolean NOT NULL DEFAULT false,
  last_sync_at timestamptz,
  last_error text
);

CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  role role NOT NULL,
  chat_handle text,
  tracker_handle text,
  timezone text NOT NULL DEFAULT 'UTC',
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE on_call (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role role NOT NULL,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  tier client_tier NOT NULL DEFAULT 'free',
  channel channel NOT NULL,
  channel_user_ref text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  language text NOT NULL DEFAULT 'en',
  UNIQUE (tenant_id, channel, channel_user_ref)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  status conversation_status NOT NULL DEFAULT 'open',
  wa_window_expires_at timestamptz,
  last_inbound_at timestamptz
);

-- Raw inbound events are stored here before any processing (architecture §3, principle 2).
-- Telegram message ids are only unique per chat, so uniqueness is per bot, not global.
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  direction message_direction NOT NULL,
  platform_message_id text,
  text_redacted text,
  text_encrypted bytea,
  media_refs jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, platform_message_id)
);

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  category category NOT NULL,
  priority priority NOT NULL,
  priority_reason text,
  priority_source priority_source NOT NULL DEFAULT 'rules',
  status ticket_status NOT NULL DEFAULT 'received',
  assignee_id uuid REFERENCES members(id) ON DELETE SET NULL,
  role_needed role,
  tracker_ref text,
  switch_room_ref text,
  affected_client_count integer NOT NULL DEFAULT 1,
  embedding vector(1024),
  sla_ack_due timestamptz,
  sla_resolve_due timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type text NOT NULL,
  actor_type actor_type NOT NULL,
  actor_ref text,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tracker_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  provider tracker_provider NOT NULL,
  repo_ref text,
  external_issue_id text,
  external_issue_number integer,
  external_issue_url text,
  sync_mode sync_mode NOT NULL DEFAULT 'general',
  sync_status sync_status NOT NULL DEFAULT 'pending',
  idempotency_key text NOT NULL UNIQUE,            -- github:{tenant}:{ticket}:{mode}
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE issue_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  repo_ref text,
  provider tracker_provider NOT NULL DEFAULT 'github',
  draft_json jsonb NOT NULL,                       -- github.draft.v1
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  confidence numeric(4,3),
  llm_run_id uuid,
  status draft_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by text,
  decided_at timestamptz,
  reject_reason text
);

CREATE TABLE routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  position integer NOT NULL,
  condition_json jsonb NOT NULL DEFAULT '{}',
  action_json jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, position)
);

CREATE TABLE sla_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  priority priority NOT NULL,
  ack_minutes integer NOT NULL,
  resolve_minutes integer NOT NULL,
  UNIQUE (tenant_id, priority)
);

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind outbox_kind NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL UNIQUE,
  status outbox_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  input_hash text NOT NULL,
  output_json jsonb,
  confidence numeric(4,3),
  latency_ms integer,
  cost numeric(12,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor text NOT NULL,
  action text NOT NULL,
  target text,
  diff jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Access paths (architecture §6). Unique keys above double as indexes.
CREATE INDEX tickets_tenant_status_priority ON tickets (tenant_id, status, priority);
CREATE INDEX tickets_embedding_hnsw ON tickets USING hnsw (embedding vector_cosine_ops);
CREATE INDEX outbox_status_next_attempt ON outbox (status, next_attempt_at);
CREATE INDEX tracker_issues_ticket ON tracker_issues (ticket_id);
CREATE INDEX issue_drafts_tenant_status ON issue_drafts (tenant_id, status);
CREATE INDEX ticket_events_ticket ON ticket_events (ticket_id, created_at);
CREATE INDEX messages_conversation ON messages (conversation_id, created_at);
CREATE INDEX llm_runs_ticket ON llm_runs (ticket_id);
