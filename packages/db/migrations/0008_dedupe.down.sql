-- Postgres cannot drop an enum value; the 'github.comment' value is left in place.
DROP INDEX IF EXISTS tickets_dedupe;
ALTER TABLE tickets DROP COLUMN IF EXISTS product_area;
