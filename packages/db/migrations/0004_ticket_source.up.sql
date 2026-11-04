-- Issue #8: a deterministic identity for tickets created by the pipeline, so replaying the ticket stage
-- for the same message cannot create a second ticket for the same extracted issue.
ALTER TABLE tickets
  ADD COLUMN source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN source_issue_index integer,
  ADD CONSTRAINT tickets_source_pair CHECK ((source_message_id IS NULL) = (source_issue_index IS NULL));

CREATE UNIQUE INDEX tickets_source_unique ON tickets (source_message_id, source_issue_index)
  WHERE source_message_id IS NOT NULL;
