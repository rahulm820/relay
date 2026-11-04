import { resolveBotTenant, withTenant, type Pool } from "@relay/db";
import { ingestMessage, type ChannelRegistry, type Redactor, type TelegramAdapter } from "@relay/channels";
import type { QueueProducer } from "@relay/core";
import type { FastifyInstance, FastifyRequest } from "fastify";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Telegram updates are a few KB; this leaves room for a 4096-character message with entities. */
export const WEBHOOK_BODY_LIMIT = 128 * 1024;

export interface WebhookDeps {
  pool: Pool;
  producer: QueueProducer;
  registry: ChannelRegistry;
  redact: Redactor;
  encryptionKey: Buffer;
}

interface VerifiedBot {
  botId: string;
  adapter: TelegramAdapter;
}

interface BotRow {
  channel: string;
  status: string;
  webhook_secret_hash: string | null;
}

/**
 * POST /webhooks/telegram/:botId
 *
 * Order of work (nothing is written until the secret has been checked):
 *   onRequest (before the body is read): resolve bot -> read its row -> constant-time secret check
 *   handler: validate update -> persist (one transaction) -> enqueue -> 200
 * Unknown bot, bad or missing secret, inactive bot and malformed bot id all answer the same 401, so the
 * endpoint cannot be used to discover which bot ids exist. Answers are 2xx only when the message is
 * stored AND queued; anything else we could not finish is 5xx so Telegram redelivers.
 * Never log message text, the secret header or request bodies: only ids and outcomes.
 */
export function registerTelegramWebhook(app: FastifyInstance, deps: WebhookDeps): void {
  const verified = new WeakMap<FastifyRequest, VerifiedBot>();

  app.route<{ Params: { botId: string } }>({
    method: "POST",
    url: "/webhooks/telegram/:botId",
    bodyLimit: WEBHOOK_BODY_LIMIT,

    onRequest: async (req, reply) => {
      const { botId } = req.params;
      let tenantId: string | null = null;
      let bot: BotRow | undefined;
      if (UUID.test(botId)) {
        tenantId = await resolveBotTenant(deps.pool, botId);
        if (tenantId) {
          bot = await withTenant(deps.pool, tenantId, async (c) =>
            (await c.query<BotRow>("SELECT channel, status, webhook_secret_hash FROM bots WHERE id = $1", [botId])).rows[0]);
        }
      }
      // The check runs even for an unknown bot (against a dummy hash) so both paths do the same work.
      const adapter = deps.registry.forBot("telegram", {
        tenantId: tenantId ?? "", botId, webhookSecretHash: bot?.webhook_secret_hash ?? null,
      }) as TelegramAdapter;
      const secretOk = adapter.verifyRequest({ headers: stringHeaders(req.headers), rawBody: "" });
      if (!secretOk || !tenantId || !bot || bot.status !== "active" || bot.channel !== "telegram") {
        req.log.warn({ event: "webhook", outcome: "rejected" }, "webhook rejected");
        return reply.code(401).send({ error: "unauthorized" });
      }
      verified.set(req, { botId, adapter });
    },

    handler: async (req, reply) => {
      const { botId, adapter } = verified.get(req)!;
      const parsed = adapter.parseUpdate(req.body);
      if (parsed.kind === "invalid") {
        req.log.info({ event: "webhook", outcome: "invalid", botId }, "webhook invalid");
        return reply.code(400).send({ error: "bad_request" });
      }
      if (parsed.kind === "ignored") {
        // 200, not an error: an update we deliberately skip must never be redelivered.
        req.log.info({ event: "webhook", outcome: "ignored", reason: parsed.reason, botId, updateId: parsed.updateId }, "webhook ignored");
        return reply.code(200).send({ ok: true });
      }
      const result = await ingestMessage(deps, parsed.message, {
        idempotencyKey: `tg:${botId}:${parsed.updateId}`,
        traceId: req.id,
      });
      req.log.info(
        { event: "webhook", outcome: result.duplicate ? "duplicate" : "accepted", botId, updateId: parsed.updateId, messageId: result.messageId },
        "webhook accepted",
      );
      return reply.code(200).send({ ok: true });
    },
  });
}

function stringHeaders(headers: FastifyRequest["headers"]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = typeof v === "string" ? v : undefined;
  return out;
}
