import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client can die (server restart, admin kill). Without a listener Node treats the
  // event as an uncaught exception; log it and let the pool open a fresh connection next time.
  pool.on("error", (err) => console.error("pg pool: idle client error:", err.message));
  return pool;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in one transaction with the tenant context set, so row-level security applies.
 * set_config(..., true) is SET LOCAL with a bind parameter: the setting disappears at COMMIT/ROLLBACK
 * and cannot leak to the next user of a pooled connection. Throws if `fn` throws (after ROLLBACK).
 */
export async function withTenant<T>(pool: Pool, tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("withTenant: tenantId must be a UUID");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Tenant that owns a bot, for webhook handlers that only know the bot id. Null if the bot is unknown. */
export async function resolveBotTenant(pool: Pool, botId: string): Promise<string | null> {
  const { rows } = await pool.query<{ tenant_id: string | null }>("SELECT relay_resolve_bot($1) AS tenant_id", [botId]);
  return rows[0]?.tenant_id ?? null;
}

/**
 * Due outbox rows across all tenants (worker entry point): pending rows whose time has come, plus rows
 * stuck in 'processing' for longer than `leaseSeconds`. Claim each with withTenant afterwards.
 */
export async function listDueOutbox(pool: Pool, limit: number, leaseSeconds = 60): Promise<{ id: string; tenantId: string }[]> {
  const { rows } = await pool.query<{ id: string; tenant_id: string }>("SELECT * FROM relay_due_outbox($1, $2)", [limit, leaseSeconds]);
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/** Tracker rows the reconcile job should examine, across tenants. See migration 0007 for the selection rules. */
export async function listReconcileCandidates(
  pool: Pool, opts: { limit: number; graceSeconds: number; staleSeconds: number; retryBudget: number },
): Promise<{ id: string; tenantId: string }[]> {
  const { rows } = await pool.query<{ id: string; tenant_id: string }>(
    "SELECT * FROM relay_reconcile_candidates($1, $2, $3, $4)", [opts.limit, opts.graceSeconds, opts.staleSeconds, opts.retryBudget]);
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

export interface SyncHealthCounts {
  outboxBacklog: number;
  outboxOldestSeconds: number;
  outboxFailed: number;
  syncPending: number;
  syncFailed: number;
  syncCreated: number;
  syncClosed: number;
  syncFailedBeyondBudget: number;
}

/** GitHub sync backlog and failure counts across all tenants (worker only). Counts, never row contents. */
export async function getSyncHealthCounts(pool: Pool, retryBudget: number): Promise<SyncHealthCounts> {
  const { rows } = await pool.query("SELECT * FROM relay_sync_health_all($1)", [retryBudget]);
  const r = rows[0];
  return {
    outboxBacklog: r.outbox_backlog, outboxOldestSeconds: r.outbox_oldest_seconds, outboxFailed: r.outbox_failed,
    syncPending: r.sync_pending, syncFailed: r.sync_failed, syncCreated: r.sync_created, syncClosed: r.sync_closed,
    syncFailedBeyondBudget: r.sync_failed_beyond_budget,
  };
}
