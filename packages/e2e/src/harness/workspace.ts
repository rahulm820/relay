// Arranges a tenant the way an operator would have set it up (bot, GitHub integration, team), and drives the platform
// the way its users do: a client writes to the bot (Telegram webhook), an operator signs in and moves tickets.
import { randomUUID } from "node:crypto";
import { generateWebhookSecret, hashWebhookSecret } from "@relay/channels";
import { createTenant, type TestDb, type TestTenant } from "@relay/core/testing";
import { seedAdmin } from "@relay/db";

export const ADMIN_PASSWORD = "e2e-only-password-1";
export const REPO = "acme/storefront";

export interface Workspace extends TestTenant {
  /** The operator's login. Emails are unique across tenants, so each workspace has its own. */
  operatorEmail: string;
  botId: string;
  webhookSecret: string;
  chatId: string;
}

/** A tenant with an active Telegram bot, an auto-approving GitHub integration, a PM in the team, and an operator login. */
export async function createWorkspace(db: TestDb, o: { chatId?: string } = {}): Promise<Workspace> {
  const t = await createTenant(db.owner);
  const botId = randomUUID();
  const webhookSecret = generateWebhookSecret();
  await db.owner.query(
    "INSERT INTO bots (id, tenant_id, channel, display_name, status, webhook_secret_hash, credentials_ref) VALUES ($1,$2,'telegram','Acme support','active',$3,'env:E2E_BOT_TOKEN')",
    [botId, t.tenantId, hashWebhookSecret(webhookSecret)],
  );
  await db.owner.query(
    `INSERT INTO integrations (tenant_id, provider, credentials_ref, repo_ref, label_map_json, status, approval_policy)
     VALUES ($1,'github','env:GITHUB_TOKEN',$2,$3,'active','auto')`,
    [t.tenantId, REPO, JSON.stringify({ category: { bug: "bug", ui: "ui" }, priority: { P1: "priority:p1", P2: "priority:p2", P3: "priority:p3" } })],
  );
  await db.owner.query("INSERT INTO members (tenant_id, name, role, chat_handle) VALUES ($1,'Pat Morgan','pm','pat.pm')", [t.tenantId]);
  const operatorEmail = `operator-${t.tenantId.slice(0, 8)}@e2e.test`;
  await seedAdmin(db.owner, t.tenantId, operatorEmail, ADMIN_PASSWORD);
  return { ...t, operatorEmail, botId, webhookSecret, chatId: o.chatId ?? String(100_000 + Math.floor(Math.random() * 900_000)) };
}

let updateCounter = 5000;
export interface Update { update_id: number; message: Record<string, unknown> }
export const telegramUpdate = (w: Workspace, text: string, messageId = 1): Update => ({
  update_id: updateCounter++,
  message: { message_id: messageId, date: Math.floor(Date.now() / 1000), text, chat: { id: Number(w.chatId), type: "private" }, from: { id: Number(w.chatId), is_bot: false } },
});

/** What Telegram does: POST the update to the bot's webhook with the secret header. */
export const postUpdate = (apiUrl: string, w: Workspace, update: Update, secret = w.webhookSecret): Promise<Response> =>
  fetch(`${apiUrl}/webhooks/telegram/${w.botId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update),
  });

/** A signed-in operator: the session cookie from the real login, and the CSRF header every write needs. */
export interface Operator { get(path: string): Promise<Response>; post(path: string, body: unknown): Promise<Response> }
export async function signIn(apiUrl: string, w: Workspace): Promise<Operator> {
  const res = await fetch(`${apiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "relay-admin" },
    body: JSON.stringify({ email: w.operatorEmail, password: ADMIN_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`operator login failed with ${res.status}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return {
    get: (path) => fetch(`${apiUrl}${path}`, { headers: { cookie } }),
    post: (path, body) => fetch(`${apiUrl}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-requested-with": "relay-admin" }, body: JSON.stringify(body) }),
  };
}

/** Test Redis database for the E2E processes, kept apart from the other suites' keys. */
export function e2eRedisUrl(base: string): string {
  const u = new URL(base);
  u.pathname = "/5";
  return u.toString();
}
