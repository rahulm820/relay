-- Issue #13: the code-aware drafting job. The handler reads the repo and writes issue_drafts; it never
-- writes to GitHub. Only 'pending' rows are dispatched, so the row runs as soon as the ticket exists.
ALTER TYPE outbox_kind ADD VALUE IF NOT EXISTS 'github.draft' AFTER 'github.create_issue';
