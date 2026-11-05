import { ClientSendPayloadSchema, PermanentFailureError, type ClientSendPayload, type OutboxHandler } from "@relay/core";
import { withTenant, type Pool } from "@relay/db";
import type { Secret, SecretProvider, SendResult } from "@relay/shared";
import { ackText, cleanClarificationItems, refusalText, statusText, ticketRef } from "./client-messages.js";
import { TelegramAdapter, TelegramApiError, TelegramAuthError, TelegramBlockedError, TelegramNetworkError, TelegramRateLimitError } from "./telegram/index.js";

/** Where and to whom a client.send row goes, and what it is about. All of it comes from our own tables. */
export interface SendContext {
  botId: string;
  channel: string;
  credentialsRef: string | null;
  chatId: string;
  clientId: string;
  conversationId: string;
  blocked: boolean;
  /** Tickets the message concerns (ack: those created from the inbound message; status: the one ticket). */
  ticketIds: string[];
  /** Cleaned clarification items for a needs_info update. */
  clarificationItems: string[];
}

/** Everything the handler needs from the database, so the Telegram logic can be tested without one. */
export interface ClientSendStore {
  load(tenantId: string, payload: ClientSendPayload): Promise<SendContext | null>;
  alreadySent(tenantId: string, botId: string, key: string): Promise<boolean>;
  recordSent(tenantId: string, ctx: SendContext, key: string, sent: SendResult, text: string, payload: ClientSendPayload): Promise<void>;
  markClientBlocked(tenantId: string, clientId: string): Promise<void>;
  markBotError(tenantId: string, botId: string, code: string): Promise<void>;
}

export interface ClientSendDeps {
  store: ClientSendStore;
  tokens: SecretProvider;
  /** Telegram Bot API base URL; only set to point at a local mock. */
  apiBaseUrl?: string;
  /** Builds the sender for a bot. Injectable so tests can point it at a local mock. */
  senderFor?: (bot: { tenantId: string; botId: string; token: Secret }) => { send: TelegramAdapter["send"] };
  log?: (event: Record<string, unknown>) => void;
}

const transient = (message: string, code: string) => Object.assign(new Error(message), { code });

/**
 * The outbox handler for `client.send`: sends one fixed-template message to the client's Telegram chat.
 *
 * Duplicate guard: before sending, the store is asked whether this outbox key already has an outbound message
 * (written after the previous successful send). Telegram has no idempotency key, so one window remains
 * at-least-once: Telegram accepts the message and the process dies before the record is committed; the retry
 * then sends it again.
 *
 * Outcomes: sent -> row done. Client blocked the bot -> permanent, client marked, later sends skipped.
 * Bad bot token -> permanent, bot marked `error`. Rate limited, 5xx or network -> transient (outbox backoff).
 * Missing token or unsupported channel -> permanent with a code. Messages and logs carry codes and ids only.
 */
export function createClientSendHandler(deps: ClientSendDeps): OutboxHandler {
  const log = deps.log ?? ((e) => console.log(JSON.stringify(e)));
  const senders = new Map<string, { send: TelegramAdapter["send"] }>();
  const senderFor = deps.senderFor ?? ((b) => new TelegramAdapter({
    tenantId: b.tenantId, botId: b.botId, token: b.token, ...(deps.apiBaseUrl ? { apiBaseUrl: deps.apiBaseUrl } : {}),
    // Keep one send well inside the outbox lease: honour short retry_after waits here, leave long ones to the outbox backoff.
    maxSendRetries: 2, maxRetryWaitMs: 15_000,
  }));

  return async (input) => {
    const parsed = ClientSendPayloadSchema.safeParse(input.payload);
    if (!parsed.success) throw new PermanentFailureError("invalid client.send payload", "invalid_payload");
    const payload = parsed.data;
    const ids = { event: "client_send", outboxId: input.outboxId, tenantId: input.tenantId, kind: payload.kind, traceId: input.traceId };

    const ctx = await deps.store.load(input.tenantId, payload);
    if (!ctx) throw new PermanentFailureError("nothing to send to", "target_not_found");
    if (ctx.blocked) { log({ ...ids, outcome: "skipped_blocked" }); return { note: "skipped: the client blocked the bot" }; }
    if (ctx.channel !== "telegram") throw new PermanentFailureError("unsupported channel", "unsupported_channel");
    if (await deps.store.alreadySent(input.tenantId, ctx.botId, input.idempotencyKey)) { log({ ...ids, outcome: "already_sent" }); return { note: "already sent" }; }

    let text: string;
    if (payload.kind === "refusal") text = refusalText();
    else if (ctx.ticketIds.length === 0) throw new PermanentFailureError("no ticket to talk about", "no_ticket");
    else if (payload.kind === "ack") text = ackText(ctx.ticketIds.map(ticketRef), payload.sensitive);
    else text = statusText(payload.status, ticketRef(ctx.ticketIds[0]!), ctx.clarificationItems);

    if (!ctx.credentialsRef) throw new PermanentFailureError("bot has no credentials", "bot_token_missing");
    let token: Secret | undefined;
    try { token = await deps.tokens.get(ctx.credentialsRef); } catch { throw new PermanentFailureError("bot credentials reference is invalid", "bot_credentials_invalid"); }
    if (!token) throw new PermanentFailureError("bot token is not configured", "bot_token_missing");

    let sender = senders.get(ctx.botId);
    if (!sender) { sender = senderFor({ tenantId: input.tenantId, botId: ctx.botId, token }); senders.set(ctx.botId, sender); }

    let sent: SendResult;
    try {
      sent = await sender.send(ctx.botId, ctx.chatId, text);
    } catch (err) {
      if (err instanceof TelegramBlockedError) {
        await deps.store.markClientBlocked(input.tenantId, ctx.clientId);
        throw new PermanentFailureError("the client blocked the bot", "client_blocked_bot");
      }
      if (err instanceof TelegramAuthError) {
        await deps.store.markBotError(input.tenantId, ctx.botId, "unauthorized");
        senders.delete(ctx.botId); // the token may be replaced
        throw new PermanentFailureError("telegram rejected the bot token", "telegram_unauthorized");
      }
      if (err instanceof TelegramRateLimitError) throw transient("telegram rate limit", "telegram_rate_limited");
      if (err instanceof TelegramNetworkError) throw transient("telegram unreachable", err.code);
      if (err instanceof TelegramApiError) {
        if (err.status >= 500) throw transient("telegram server error", `telegram_api_${err.status}`);
        throw new PermanentFailureError("telegram refused the message", `telegram_api_${err.status}`);
      }
      throw err;
    }
    await deps.store.recordSent(input.tenantId, ctx, input.idempotencyKey, sent, text, payload);
    log({ ...ids, outcome: "sent" });
  };
}

// ---------------------------------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------------------------------

/** Reads and writes through tenant-scoped transactions as the worker's own (non-owner) role. */
export function createPgClientSendStore(pool: Pool): ClientSendStore {
  const tx = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, tenantId, fn);

  return {
    async load(tenantId, payload) {
      return tx(tenantId, async (c) => {
        // Resolve the conversation (and for a status update, the ticket) the message belongs to.
        let conversationId: string | undefined;
        let ticketIds: string[] = [];
        let items: string[] = [];
        if (payload.kind === "status") {
          const t = (await c.query<{ conversation_id: string | null; source_message_id: string | null; source_issue_index: number | null }>(
            "SELECT conversation_id, source_message_id, source_issue_index FROM tickets WHERE id = $1", [payload.ticketId])).rows[0];
          if (!t?.conversation_id) return null;
          conversationId = t.conversation_id;
          ticketIds = [payload.ticketId];
          if (payload.status === "needs_info" && t.source_message_id !== null) {
            const run = (await c.query<{ missing: unknown }>(
              "SELECT stage_results->'extract'->'issues'->$2::int->'missing_info' AS missing FROM pipeline_runs WHERE message_id = $1", [t.source_message_id, t.source_issue_index])).rows[0];
            if (Array.isArray(run?.missing)) items = cleanClarificationItems(run.missing.filter((x): x is string => typeof x === "string"));
          }
        } else {
          const m = (await c.query<{ conversation_id: string }>("SELECT conversation_id FROM messages WHERE id = $1", [payload.messageId])).rows[0];
          if (!m) return null;
          conversationId = m.conversation_id;
          if (payload.kind === "ack") {
            ticketIds = (await c.query<{ id: string }>("SELECT id FROM tickets WHERE source_message_id = $1 ORDER BY source_issue_index", [payload.messageId])).rows.map((r) => r.id);
          }
        }
        const row = (await c.query<{ bot_id: string; channel: string; credentials_ref: string | null; client_id: string; channel_user_ref: string; blocked: boolean }>(
          `SELECT b.id AS bot_id, b.channel, b.credentials_ref, cl.id AS client_id, cl.channel_user_ref, (cl.contact_blocked_at IS NOT NULL) AS blocked
           FROM conversations v JOIN clients cl ON cl.id = v.client_id JOIN bots b ON b.id = v.bot_id WHERE v.id = $1`, [conversationId])).rows[0];
        if (!row) return null;
        return {
          botId: row.bot_id, channel: row.channel, credentialsRef: row.credentials_ref, chatId: row.channel_user_ref,
          clientId: row.client_id, conversationId, blocked: row.blocked, ticketIds, clarificationItems: items,
        };
      });
    },

    async alreadySent(tenantId, botId, key) {
      return tx(tenantId, async (c) => (await c.query("SELECT 1 FROM messages WHERE bot_id = $1 AND idempotency_key = $2", [botId, key])).rows.length > 0);
    },

    async recordSent(tenantId, ctx, key, sent, text, payload) {
      await tx(tenantId, async (c) => {
        await c.query(
          `INSERT INTO messages (tenant_id, conversation_id, bot_id, direction, platform_message_id, text_redacted, idempotency_key)
           VALUES ($1, $2, $3, 'out', $4, $5, $6) ON CONFLICT (bot_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
          [tenantId, ctx.conversationId, ctx.botId, sent.platformMessageId, text, key]);
        for (const ticketId of ctx.ticketIds) {
          await c.query(
            `INSERT INTO ticket_events (tenant_id, ticket_id, type, actor_type, actor_ref, payload, created_at)
             VALUES (relay_current_tenant(), $1, 'client_notified', 'system', 'client.send', $2, clock_timestamp())`,
            [ticketId, JSON.stringify({ kind: payload.kind, ...(payload.kind === "status" ? { status: payload.status } : {}) })]);
        }
      });
    },

    async markClientBlocked(tenantId, clientId) {
      await tx(tenantId, (c) => c.query("UPDATE clients SET contact_blocked_at = now() WHERE id = $1", [clientId]));
    },

    async markBotError(tenantId, botId, code) {
      await tx(tenantId, (c) => c.query("UPDATE bots SET status = 'error', last_error = $2 WHERE id = $1", [botId, code]));
    },
  };
}
