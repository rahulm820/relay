import { findAdminForLogin, resolveSession, withTenant, type Pool } from "@relay/db";
import type { AuthStore } from "./session.js";

/** The production AuthStore: pre-tenant lookups through the SECURITY DEFINER functions, everything else tenant-scoped. */
export function pgAuthStore(pool: Pool): AuthStore {
  return {
    findAdmin: (email) => findAdminForLogin(pool, email),
    resolve: (tokenHash, idleSeconds) => resolveSession(pool, tokenHash, idleSeconds),
    createSession: (tenantId, userId, tokenHash, ttlSeconds) =>
      withTenant(pool, tenantId, async (c) => {
        await c.query(
          "INSERT INTO admin_sessions (tenant_id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
          [tenantId, userId, tokenHash, ttlSeconds]);
      }),
    revoke: (tenantId, tokenHash) =>
      withTenant(pool, tenantId, async (c) => {
        await c.query("UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash]);
      }),
    audit: (tenantId, actor, action) =>
      withTenant(pool, tenantId, async (c) => {
        await c.query("INSERT INTO audit_log (tenant_id, actor, action, target) VALUES (relay_current_tenant(), $1, $2, 'session')", [actor, action]);
      }),
    tenantName: (tenantId) =>
      withTenant(pool, tenantId, async (c) => (await c.query<{ name: string }>("SELECT name FROM tenants WHERE id = relay_current_tenant()")).rows[0]?.name ?? null),
  };
}
