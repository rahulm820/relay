import { withTenant, type Pool } from "@relay/db";
import { encryptText, type NormalizedMessage } from "@relay/shared";
import type { QueueProducer } from "@relay/core";
import type { Redactor } from "./redact.js";

export interface IngestDeps {
  pool: Pool;
  producer: QueueProducer;
  redact: Redactor;
  /** 32-byte AES-256-GCM key for text_encrypted. */
  encryptionKey: Buffer;
}

export interface IngestResult {
  messageId: string;
  /** True when this message was already stored (a redelivery). */
  duplicate: boolean;
}

/**
 * Channel-agnostic ingest. Persist first, enqueue second:
 *  1. ONE tenant-scoped transaction stores client, conversation and message. The message is unique per
 *     (bot, platform_message_id), so a repeat finds the existing row instead of adding one.
 *  2. After commit, the ingest job {messageId} is enqueued with `idempotencyKey`.
 * If the process dies or Redis fails after step 1, this throws; the caller answers 5xx, the platform
 * redelivers, step 1 finds the message, and step 2 runs again (the queue dedupes by key).
 * `msg.tenantId` and `msg.botId` must come from the verified bot record, never from the payload.
 */
export async function ingestMessage(
  deps: IngestDeps,
  msg: NormalizedMessage,
  opts: { idempotencyKey: string; traceId: string },
): Promise<IngestResult> {
  const { tenantId, botId } = msg;
  const textRedacted = deps.redact(msg.text);
  const textEncrypted = encryptText(deps.encryptionKey, msg.text);

  const stored = await withTenant(deps.pool, tenantId, async (c) => {
    // Serialise first messages of one sender so two simultaneous updates cannot create two conversations.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${botId}:${msg.senderRef}`]);

    const client = await c.query<{ id: string }>(
      `INSERT INTO clients (tenant_id, display_name, channel, channel_user_ref)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, channel, channel_user_ref) DO UPDATE SET channel = EXCLUDED.channel
       RETURNING id`,
      [tenantId, `${msg.channel}:${msg.senderRef}`, msg.channel, msg.senderRef],
    );
    const clientId = client.rows[0]!.id;

    let conversationId = (await c.query<{ id: string }>(
      "SELECT id FROM conversations WHERE bot_id = $1 AND client_id = $2 AND status = 'open' ORDER BY last_inbound_at DESC NULLS LAST LIMIT 1",
      [botId, clientId],
    )).rows[0]?.id;
    conversationId ??= (await c.query<{ id: string }>(
      "INSERT INTO conversations (tenant_id, client_id, bot_id) VALUES ($1, $2, $3) RETURNING id",
      [tenantId, clientId, botId],
    )).rows[0]!.id;

    const inserted = await c.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, bot_id, direction, platform_message_id, text_redacted, text_encrypted, created_at)
       VALUES ($1, $2, $3, 'in', $4, $5, $6, $7)
       ON CONFLICT (bot_id, platform_message_id) DO NOTHING
       RETURNING id`,
      [tenantId, conversationId, botId, msg.platformMessageId, textRedacted, textEncrypted, msg.receivedAt],
    );
    if (inserted.rows[0]) {
      await c.query("UPDATE conversations SET last_inbound_at = $2 WHERE id = $1", [conversationId, msg.receivedAt]);
      return { messageId: inserted.rows[0].id, conversationId, duplicate: false };
    }
    const existing = await c.query<{ id: string; conversation_id: string }>(
      "SELECT id, conversation_id FROM messages WHERE bot_id = $1 AND platform_message_id = $2",
      [botId, msg.platformMessageId],
    );
    return { messageId: existing.rows[0]!.id, conversationId: existing.rows[0]!.conversation_id, duplicate: true };
  });

  await deps.producer.enqueue(
    { stage: "ingest", tenantId, conversationId: stored.conversationId, traceId: opts.traceId, payload: { messageId: stored.messageId } },
    { idempotencyKey: opts.idempotencyKey },
  );
  return { messageId: stored.messageId, duplicate: stored.duplicate };
}
