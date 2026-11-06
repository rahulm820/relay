-- Issue #11: duplicate detection. product_area is a rule signal for matching; the embedding column already exists (0001).
ALTER TABLE tickets ADD COLUMN product_area text;
CREATE INDEX tickets_dedupe ON tickets (tenant_id, category, product_area, status);

-- A duplicate complaint adds a comment to the existing GitHub issue instead of opening a new one.
ALTER TYPE outbox_kind ADD VALUE IF NOT EXISTS 'github.comment' AFTER 'github.create_issue';
