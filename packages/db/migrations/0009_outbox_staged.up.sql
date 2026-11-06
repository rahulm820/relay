-- Issue #12: approval_policy = human stages the github.create_issue row. Only 'pending' rows are
-- dispatched (relay_due_outbox picks status = 'pending'); approval flips the row to 'pending'.
ALTER TYPE outbox_status ADD VALUE IF NOT EXISTS 'staged' AFTER 'pending';
