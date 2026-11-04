import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "./client.js";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

interface Migration {
  name: string;
  up: string;
  down: string;
}

async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".up.sql")).sort();
  return Promise.all(
    files.map(async (file) => {
      const name = file.replace(/\.up\.sql$/, "");
      return {
        name,
        up: await readFile(new URL(file, MIGRATIONS_DIR), "utf8"),
        down: await readFile(new URL(`${name}.down.sql`, MIGRATIONS_DIR), "utf8"),
      };
    }),
  );
}

async function applied(pool: Pool): Promise<string[]> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const { rows } = await pool.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
  return rows.map((r) => r.name);
}

/** Applies every pending migration in order, each in its own transaction. Safe to re-run. */
export async function migrateUp(pool: Pool): Promise<string[]> {
  const done = new Set(await applied(pool));
  const ran: string[] = [];
  for (const m of await loadMigrations()) {
    if (done.has(m.name)) continue;
    await inTransaction(pool, async (q) => {
      await q(m.up);
      await q("INSERT INTO schema_migrations (name) VALUES ($1)", [m.name]);
    });
    ran.push(m.name);
  }
  return ran;
}

/** Reverts the last `steps` applied migrations (default 1), newest first. Returns what was reverted. */
export async function migrateDown(pool: Pool, steps = 1): Promise<string[]> {
  const done = await applied(pool);
  const byName = new Map((await loadMigrations()).map((m) => [m.name, m]));
  const reverted: string[] = [];
  for (const name of done.reverse().slice(0, steps)) {
    const m = byName.get(name);
    if (!m) throw new Error(`Applied migration ${name} has no file on disk`);
    await inTransaction(pool, async (q) => {
      await q(m.down);
      await q("DELETE FROM schema_migrations WHERE name = $1", [name]);
    });
    reverted.push(name);
  }
  return reverted;
}

async function inTransaction(pool: Pool, fn: (q: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn((sql, params) => client.query(sql, params));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Gives the service roles a login password (cluster-level, so not part of a migration file).
 * Passwords come from the caller; ALTER ROLE cannot take bind parameters, so the statement is
 * built server-side with format(%L), which quotes the literal safely.
 */
export async function setRolePasswords(pool: Pool, passwords: { relay_api?: string; relay_worker?: string }): Promise<void> {
  for (const [role, password] of Object.entries(passwords)) {
    if (!password) continue;
    const { rows } = await pool.query<{ stmt: string }>("SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS stmt", [role, password]);
    await pool.query(rows[0]!.stmt);
  }
}
