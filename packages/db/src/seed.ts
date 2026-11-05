import { hashPassword } from "@relay/shared";
import type { Pool } from "./client.js";

// Fake demo data only. Fixed UUIDs + ON CONFLICT DO NOTHING make the seed safe to re-run.
export const DEMO_TENANT_ID = "00000000-0000-4000-8000-000000000001";
const id = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;

export const SEED_COUNTS = { tenants: 1, bots: 1, clients: 1, members: 4, routing_rules: 1, sla_policies: 4 } as const;

/** Runs as the schema owner (bypasses RLS by design: seeding creates the tenant itself). */
export async function seed(pool: Pool): Promise<void> {
  const t = DEMO_TENANT_ID;
  const run = (sql: string, params: unknown[] = []) => pool.query(sql, params);

  await run("INSERT INTO tenants (id, name, plan) VALUES ($1, 'Demo Co', 'hackathon') ON CONFLICT (id) DO NOTHING", [t]);
  await run(
    `INSERT INTO bots (id, tenant_id, channel, display_name, status, credentials_ref)
     VALUES ($1, $2, 'telegram', 'Demo Support Bot', 'pending', 'env:TELEGRAM_BOT_TOKEN') ON CONFLICT (id) DO NOTHING`,
    [id(1), t],
  );
  await run(
    `INSERT INTO clients (id, tenant_id, display_name, tier, channel, channel_user_ref, verified)
     VALUES ($1, $2, 'Demo Client', 'paid', 'telegram', 'demo-user-1', true) ON CONFLICT (id) DO NOTHING`,
    [id(2), t],
  );
  const members = [
    ["Dana Designer", "designer"],
    ["Dev Developer", "developer"],
    ["Tess Tester", "tester"],
    ["Pat Manager", "pm"],
  ] as const;
  for (const [i, [name, role]] of members.entries()) {
    await run(
      `INSERT INTO members (id, tenant_id, name, role, chat_handle, tracker_handle)
       VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING`,
      [id(10 + i), t, name, role, `demo-${role}`],
    );
  }
  // Default routing (architecture §8.2): bug -> developer, ui -> designer, everything else -> pm.
  await run(
    `INSERT INTO routing_rules (id, tenant_id, position, condition_json, action_json)
     VALUES ($1, $2, 1, '{}', '{"role":"pm"}') ON CONFLICT (id) DO NOTHING`,
    [id(20), t],
  );
  // Default SLA targets in minutes (architecture §8.1).
  const sla = [["P1", 15, 240], ["P2", 60, 1440], ["P3", 1440, 10080], ["P4", 2880, 43200]] as const;
  for (const [i, [p, ack, resolve]] of sla.entries()) {
    await run(
      `INSERT INTO sla_policies (id, tenant_id, priority, ack_minutes, resolve_minutes)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [id(30 + i), t, p, ack, resolve],
    );
  }
}

/**
 * Ensures the demo admin exists with the given password (role pm = full admin). Runs as the schema owner. The
 * password is hashed with scrypt here and never stored, logged or returned. Re-running with a new password
 * replaces the hash, which is how an admin password is reset.
 */
export async function seedAdmin(pool: Pool, tenantId: string, email: string, password: string): Promise<void> {
  await pool.query(
    `INSERT INTO admin_users (tenant_id, email, name, role, password_hash) VALUES ($1, lower($2), 'Admin', 'pm', $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true`,
    [tenantId, email, await hashPassword(password)],
  );
}
