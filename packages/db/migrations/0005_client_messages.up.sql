-- Issue #16: outbound client messages.
-- contact_blocked_at: set when Telegram says the client blocked the bot, so later sends are skipped;
-- cleared when the client writes to us again.
ALTER TABLE clients ADD COLUMN contact_blocked_at timestamptz;

-- messages.idempotency_key: the outbox key of an outbound message, so a retry can tell it was already sent.
ALTER TABLE messages ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX messages_idempotency_key ON messages (bot_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
