DROP INDEX IF EXISTS tickets_source_unique;
ALTER TABLE tickets
  DROP CONSTRAINT IF EXISTS tickets_source_pair,
  DROP COLUMN IF EXISTS source_issue_index,
  DROP COLUMN IF EXISTS source_message_id;
