// Test-only helpers (excluded from the build). They talk to REAL Postgres and Redis.
import { randomUUID } from "node:crypto";
import { createPool, migrateUp, setRolePasswords, type Pool } from "@relay/db";
import { Redis } from "ioredis";

export const TEST_ADMIN_URL = process.env["TEST_ADMIN_URL"] ?? "postgres://relay:change-me@localhost:5433/postgres";
export const TEST_REDIS_URL = process.env["TEST_REDIS_URL"] ?? "redis://127.0.0.1:6380";

const withDb = (url: string, db: string, user?: string, password?: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = password ?? ""; }
  return u.toString();
};

export interface TestDb {
  /** Schema owner: bypasses RLS, used only to arrange and inspect. */
  owner: Pool;
  /** The runtime login (relay_worker): what the worker uses. */
  worker: Pool;
  /** The runtime login (relay_api): what the API uses. */
  api: Pool;
  dispose(): Promise<void>;
}

/** A throwaway database with every migration applied and the relay_worker login enabled. */
export async function createTestDb(): Promise<TestDb> {
  const name = `relay_core_${process.pid}_${randomUUID().slice(0, 8)}`;
  const admin = createPool(TEST_ADMIN_URL);
  await admin.query(`CREATE DATABASE ${name}`);
  const owner = createPool(withDb(TEST_ADMIN_URL, name));
  await migrateUp(owner);
  await setRolePasswords(owner, { relay_worker: "test-worker-pw", relay_api: "test-api-pw" });
  const worker = createPool(withDb(TEST_ADMIN_URL, name, "relay_worker", "test-worker-pw"));
  const api = createPool(withDb(TEST_ADMIN_URL, name, "relay_api", "test-api-pw"));
  return {
    owner,
    worker,
    api,
    async dispose() {
      await api.end();
      await worker.end();
      await owner.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export interface TestTenant {
  tenantId: string;
  conversationId: string;
}

export async function createTenant(owner: Pool): Promise<TestTenant> {
  const tenantId = randomUUID();
  const botId = randomUUID();
  const clientId = randomUUID();
  const conversationId = randomUUID();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'T')", [tenantId]);
  await owner.query("INSERT INTO bots (id, tenant_id, channel, display_name) VALUES ($1,$2,'telegram','b')", [botId, tenantId]);
  await owner.query("INSERT INTO clients (id, tenant_id, display_name, channel, channel_user_ref) VALUES ($1,$2,'c','telegram',$3)", [clientId, tenantId, randomUUID()]);
  await owner.query("INSERT INTO conversations (id, tenant_id, client_id, bot_id) VALUES ($1,$2,$3,$4)", [conversationId, tenantId, clientId, botId]);
  return { tenantId, conversationId };
}

export async function createMessage(owner: Pool, t: TestTenant, textRedacted: string | null = "checkout is broken"): Promise<string> {
  const id = randomUUID();
  const { rows } = await owner.query<{ bot_id: string }>("SELECT bot_id FROM conversations WHERE id = $1", [t.conversationId]);
  await owner.query(
    "INSERT INTO messages (id, tenant_id, conversation_id, bot_id, direction, platform_message_id, text_redacted) VALUES ($1,$2,$3,$4,'in',$5,$6)",
    [id, t.tenantId, t.conversationId, rows[0]!.bot_id, randomUUID(), textRedacted],
  );
  return id;
}

export async function flushQueueKeys(redis: Redis): Promise<void> {
  const keys = [...(await redis.keys("q:*")), ...(await redis.keys("idem:*")), "q.dlq"];
  await redis.del(...keys);
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
