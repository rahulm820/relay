-- The outbox_kind values 'github.update_issue' and 'switch.post_message' cannot be dropped (Postgres
-- enum limitation, same as 0008/0009/0010); only the auto-approval columns come back.
ALTER TABLE integrations DROP COLUMN auto_approve_min_confidence;
ALTER TABLE integrations DROP COLUMN auto_approve_drafts;
