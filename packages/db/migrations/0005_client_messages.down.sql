DROP INDEX IF EXISTS messages_idempotency_key;
ALTER TABLE messages DROP COLUMN IF EXISTS idempotency_key;
ALTER TABLE clients DROP COLUMN IF EXISTS contact_blocked_at;
