import { resolveBotTenant, withTenant, type Pool } from "@relay/db";
import { EnvSecretProvider } from "@relay/shared";
import { DEFAULT_TELEGRAM_API, callTelegram } from "./api.js";
import { generateWebhookSecret, hashWebhookSecret } from "./secret.js";

export interface RegisterOptions {
  pool: Pool;
  botId: string;
  /** Environment holding the bot token under the variable named by bots.credentials_ref. */
  env: Readonly<Record<string, string | undefined>>;
  /** https base URL where this API is reachable from the internet. */
  publicUrl: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  dryRun: boolean;
  /** Receives progress lines. They never contain the token, the secret, or a URL carrying either. */
  out: (line: string) => void;
}

/**
 * Points Telegram at this API for one bot: validates the token with getMe, generates a fresh webhook
 * secret, stores only its hash, calls setWebhook (updates limited to `message`), and marks the bot active.
 * Re-running rotates the secret. Order matters: the hash is stored BEFORE setWebhook, so Telegram can
 * never deliver with a secret we do not know; if setWebhook fails the bot is marked 'error'.
 */
export async function registerTelegramWebhook(o: RegisterOptions): Promise<void> {
  const tenantId = await resolveBotTenant(o.pool, o.botId);
  if (!tenantId) throw new Error("bot not found");
  const bot = await withTenant(o.pool, tenantId, async (c) =>
    (await c.query<{ channel: string; credentials_ref: string | null }>("SELECT channel, credentials_ref FROM bots WHERE id = $1", [o.botId])).rows[0]);
  if (!bot || bot.channel !== "telegram") throw new Error("bot is not a Telegram bot");
  if (!bot.credentials_ref) throw new Error("bot has no credentials_ref");

  const token = await new EnvSecretProvider(o.env).get(bot.credentials_ref);
  if (!token) throw new Error(`bot token is not set: define the environment variable named by credentials_ref (${bot.credentials_ref.replace(/^env:/, "")})`);
  const base = o.publicUrl.replace(/\/+$/, "");
  if (!base.startsWith("https://")) throw new Error("TELEGRAM_WEBHOOK_PUBLIC_URL must be an https:// URL");
  const webhookUrl = `${base}/webhooks/telegram/${o.botId}`;
  const call = { baseUrl: o.apiBaseUrl ?? DEFAULT_TELEGRAM_API, token, fetch: o.fetch ?? fetch, timeoutMs: 10_000 };

  o.out(`bot ${o.botId}: token found in environment (value not shown)`);
  o.out(`webhook endpoint: ${base}/webhooks/telegram/<bot id>   allowed_updates: ["message"]`);
  if (o.dryRun) {
    o.out("dry run: would call getMe, generate a webhook secret (hash stored, value never shown), call setWebhook, mark the bot active. Nothing was changed.");
    return;
  }

  await callTelegram({ ...call, method: "getMe" });
  o.out("getMe: ok");
  const secret = generateWebhookSecret();
  await withTenant(o.pool, tenantId, (c) =>
    c.query("UPDATE bots SET webhook_secret_hash = $2, webhook_url = $3 WHERE id = $1", [o.botId, hashWebhookSecret(secret), webhookUrl]));
  try {
    await callTelegram({
      ...call, method: "setWebhook",
      body: { url: webhookUrl, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false, max_connections: 10 },
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "unknown";
    await withTenant(o.pool, tenantId, (c) => c.query("UPDATE bots SET status = 'error', last_error = $2 WHERE id = $1", [o.botId, code]));
    throw err;
  }
  await withTenant(o.pool, tenantId, (c) =>
    c.query("UPDATE bots SET status = 'active', last_health_at = now(), last_error = NULL WHERE id = $1", [o.botId]));
  o.out("setWebhook: ok; bot is now active");
}
