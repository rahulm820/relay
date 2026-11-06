-- Issue #14: draft approval workflow. github.update_issue applies an approved draft to an issue that
-- general sync already created; switch.post_message announces the decision in the ticket's room.
-- Auto-approval is per-tenant and off unless a tenant sets it explicitly (acceptance: default off).
ALTER TYPE outbox_kind ADD VALUE IF NOT EXISTS 'github.update_issue' AFTER 'github.draft';
ALTER TYPE outbox_kind ADD VALUE IF NOT EXISTS 'switch.post_message' AFTER 'switch.create_room';

ALTER TABLE integrations ADD COLUMN auto_approve_drafts boolean NOT NULL DEFAULT false;
ALTER TABLE integrations ADD COLUMN auto_approve_min_confidence numeric(4,3) NOT NULL DEFAULT 0.90;
