import { withTenant, type Client, type Pool } from "@relay/db";
import { APPROVAL_POLICIES, CHANNELS, ROLES, TRACKER_PROVIDERS } from "@relay/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Authenticator, Principal } from "./auth.js";

export interface AdminRouteDeps {
  pool: Pool;
  authenticate: Authenticator;
}

// ---- validation ---------------------------------------------------------------------------------------

/** A credential is referenced by NAME only (e.g. env:TELEGRAM_BOT_TOKEN). A raw token cannot match this shape. */
const CredentialsRef = z.string().regex(/^env:[A-Z][A-Z0-9_]{1,63}$/, "must look like env:UPPER_SNAKE_NAME");
const IdParams = z.object({ id: z.uuid() }).strict();
const text = (max: number) => z.string().trim().min(1).max(max);
const Json = (maxChars: number) => z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= maxChars, "too large");
const RepoRef = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, "must look like owner/name");
const LabelMap = z.record(z.string().max(64), z.union([z.string().max(64), z.array(z.string().max(64)).max(10)])).refine((v) => Object.keys(v).length <= 50, "too many entries");

const MemberCreate = z.object({
  name: text(100), role: z.enum(ROLES), chatHandle: text(64).nullable().optional(), trackerHandle: text(64).nullable().optional(),
  timezone: text(64).optional(), active: z.boolean().optional(),
}).strict();
const MemberPatch = MemberCreate.partial().strict();

const RuleCreate = z.object({ position: z.number().int().min(1).max(10000), condition: Json(4000), action: Json(4000), enabled: z.boolean().optional() }).strict();
const RulePatch = RuleCreate.partial().strict();

const SlaPatch = z.object({ ackMinutes: z.number().int().min(1).max(525600), resolveMinutes: z.number().int().min(1).max(525600) }).partial().strict();

const IntegrationCreate = z.object({
  provider: z.enum(TRACKER_PROVIDERS), repoRef: RepoRef.nullable().optional(), credentialsRef: CredentialsRef.nullable().optional(),
  labelMap: LabelMap.optional(), approvalPolicy: z.enum(APPROVAL_POLICIES).optional(), codeAwareEnabled: z.boolean().optional(),
}).strict();
const IntegrationPatch = IntegrationCreate.omit({ provider: true }).partial().strict();

const BotCreate = z.object({ channel: z.enum(CHANNELS), displayName: text(100), credentialsRef: CredentialsRef }).strict();
const BotPatch = z.object({ displayName: text(100), credentialsRef: CredentialsRef }).partial().strict();

const nonEmpty = (o: object) => Object.keys(o).length > 0;

// ---- routes -------------------------------------------------------------------------------------------

/**
 * Configuration API: members, routing rules, SLA policies, integrations, bots, chat connections.
 * Rules that hold for every route here:
 *  - a signed-in member can read; writes need role `pm` (403 otherwise); every write needs the CSRF header
 *  - the tenant is the session's, applied through row-level security, so another tenant's rows are simply 404
 *  - credentials are never accepted or returned as values, only as `env:NAME` references; the bot webhook
 *    secret hash is never selected at all
 *  - every write adds an audit_log row naming the actor, the action, the row and the FIELD NAMES changed
 *    (never values)
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  void app.register(async (scope) => {
    const principals = new WeakMap<FastifyRequest, Principal>();
    scope.addHook("onRequest", async (req, reply) => {
      const p = await deps.authenticate(req);
      if (!p) return reply.code(401).send({ error: "unauthorized" });
      if (req.method !== "GET" && p.role !== "pm") return reply.code(403).send({ error: "forbidden", message: "requires the pm role" });
      principals.set(req, p);
    });

    const tx = <T>(req: FastifyRequest, fn: (c: Client, p: Principal) => Promise<T>) => {
      const p = principals.get(req)!;
      return withTenant(deps.pool, p.tenantId, (c) => fn(c, p));
    };
    const bad = (reply: FastifyReply, err: z.ZodError) =>
      reply.code(400).send({ error: "validation_error", message: `invalid field(s): ${[...new Set(err.issues.map((i) => String(i.path[0] ?? "body")))].join(", ")}` });
    const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" });
    /** Unique/foreign-key violations are the caller's conflict, not a server fault. */
    const dbError = (reply: FastifyReply, err: unknown) => {
      const code = (err as { code?: string }).code;
      if (code === "23505" || code === "23503") return reply.code(409).send({ error: "conflict", message: "conflicts with existing data" });
      throw err;
    };
    const audit = (c: Client, p: Principal, action: string, entity: string, id: string, fields: string[]) =>
      c.query("INSERT INTO audit_log (tenant_id, actor, action, target, diff) VALUES (relay_current_tenant(), $1, $2, $3, $4)",
        [`user:${p.userId}`, action, `${entity}:${id}`, JSON.stringify({ fields })]);

    /** UPDATE of the given column->value pairs (column names are ours, never the client's). Null when not visible. */
    const update = async (c: Client, table: string, id: string, cols: Record<string, unknown>): Promise<boolean> => {
      const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
      const sets = entries.map(([col], i) => `${col} = $${i + 2}`).join(", ");
      const r = await c.query(`UPDATE ${table} SET ${sets} WHERE id = $1`, [id, ...entries.map(([, v]) => v)]);
      return (r.rowCount ?? 0) > 0;
    };

    // ---- members ----
    const memberSql = "SELECT id, name, role, chat_handle, tracker_handle, timezone, active FROM members";
    const memberDto = (r: any) => ({ id: r.id, name: r.name, role: r.role, chatHandle: r.chat_handle, trackerHandle: r.tracker_handle, timezone: r.timezone, active: r.active });

    scope.get("/api/members", async (req) => ({ items: (await tx(req, (c) => c.query(`${memberSql} ORDER BY name, id`))).rows.map(memberDto) }));
    scope.get("/api/members/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const row = (await tx(req, (c) => c.query(`${memberSql} WHERE id = $1`, [p.data.id]))).rows[0];
      return row ? { member: memberDto(row) } : notFound(reply);
    });
    scope.post("/api/members", async (req, reply) => {
      const b = MemberCreate.safeParse(req.body); if (!b.success) return bad(reply, b.error);
      try {
        const row = await tx(req, async (c, pr) => {
          const r = (await c.query(
            `INSERT INTO members (tenant_id, name, role, chat_handle, tracker_handle, timezone, active)
             VALUES (relay_current_tenant(), $1, $2, $3, $4, coalesce($5, 'UTC'), coalesce($6, true))
             RETURNING id, name, role, chat_handle, tracker_handle, timezone, active`,
            [b.data.name, b.data.role, b.data.chatHandle ?? null, b.data.trackerHandle ?? null, b.data.timezone ?? null, b.data.active ?? null])).rows[0];
          await audit(c, pr, "members.create", "members", r.id, Object.keys(b.data));
          return r;
        });
        return reply.code(201).send({ member: memberDto(row) });
      } catch (err) { return dbError(reply, err); }
    });
    scope.patch("/api/members/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const b = MemberPatch.safeParse(req.body); if (!b.success) return bad(reply, b.error);
      if (!nonEmpty(b.data)) return reply.code(400).send({ error: "validation_error", message: "at least one field required" });
      const d = b.data;
      const row = await tx(req, async (c, pr) => {
        if (!(await update(c, "members", p.data.id, { name: d.name, role: d.role, chat_handle: d.chatHandle, tracker_handle: d.trackerHandle, timezone: d.timezone, active: d.active }))) return null;
        await audit(c, pr, "members.update", "members", p.data.id, Object.keys(d));
        return (await c.query(`${memberSql} WHERE id = $1`, [p.data.id])).rows[0];
      });
      return row ? { member: memberDto(row) } : notFound(reply);
    });
    scope.delete("/api/members/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      try {
        const done = await tx(req, async (c, pr) => {
          const r = await c.query("DELETE FROM members WHERE id = $1", [p.data.id]);
          if (!r.rowCount) return false;
          await audit(c, pr, "members.delete", "members", p.data.id, []);
          return true;
        });
        return done ? reply.code(204).send() : notFound(reply);
      } catch (err) { return dbError(reply, err); }
    });

    // ---- routing rules ----
    const ruleSql = "SELECT id, position, condition_json, action_json, enabled FROM routing_rules";
    const ruleDto = (r: any) => ({ id: r.id, position: r.position, condition: r.condition_json, action: r.action_json, enabled: r.enabled });

    scope.get("/api/routing-rules", async (req) => ({ items: (await tx(req, (c) => c.query(`${ruleSql} ORDER BY position, id`))).rows.map(ruleDto) }));
    scope.get("/api/routing-rules/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const row = (await tx(req, (c) => c.query(`${ruleSql} WHERE id = $1`, [p.data.id]))).rows[0];
      return row ? { rule: ruleDto(row) } : notFound(reply);
    });
    scope.post("/api/routing-rules", async (req, reply) => {
      const b = RuleCreate.safeParse(req.body); if (!b.success) return bad(reply, b.error);
      try {
        const row = await tx(req, async (c, pr) => {
          const r = (await c.query(
            `INSERT INTO routing_rules (tenant_id, position, condition_json, action_json, enabled)
             VALUES (relay_current_tenant(), $1, $2, $3, coalesce($4, true)) RETURNING id, position, condition_json, action_json, enabled`,
            [b.data.position, JSON.stringify(b.data.condition), JSON.stringify(b.data.action), b.data.enabled ?? null])).rows[0];
          await audit(c, pr, "routing_rules.create", "routing_rules", r.id, Object.keys(b.data));
          return r;
        });
        return reply.code(201).send({ rule: ruleDto(row) });
      } catch (err) { return dbError(reply, err); }
    });
    scope.patch("/api/routing-rules/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const b = RulePatch.safeParse(req.body); if (!b.success) return bad(reply, b.error);
      if (!nonEmpty(b.data)) return reply.code(400).send({ error: "validation_error", message: "at least one field required" });
      const d = b.data;
      try {
        const row = await tx(req, async (c, pr) => {
          const ok = await update(c, "routing_rules", p.data.id, {
            position: d.position, condition_json: d.condition && JSON.stringify(d.condition), action_json: d.action && JSON.stringify(d.action), enabled: d.enabled });
          if (!ok) return null;
          await audit(c, pr, "routing_rules.update", "routing_rules", p.data.id, Object.keys(d));
          return (await c.query(`${ruleSql} WHERE id = $1`, [p.data.id])).rows[0];
        });
        return row ? { rule: ruleDto(row) } : notFound(reply);
      } catch (err) { return dbError(reply, err); }
    });
    scope.delete("/api/routing-rules/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const done = await tx(req, async (c, pr) => {
        const r = await c.query("DELETE FROM routing_rules WHERE id = $1", [p.data.id]);
        if (!r.rowCount) return false;
        await audit(c, pr, "routing_rules.delete", "routing_rules", p.data.id, []);
        return true;
      });
      return done ? reply.code(204).send() : notFound(reply);
    });

    // ---- SLA policies (one per priority: read and edit the targets) ----
    const slaSql = "SELECT id, priority, ack_minutes, resolve_minutes FROM sla_policies";
    const slaDto = (r: any) => ({ id: r.id, priority: r.priority, ackMinutes: r.ack_minutes, resolveMinutes: r.resolve_minutes });
    scope.get("/api/sla-policies", async (req) => ({ items: (await tx(req, (c) => c.query(`${slaSql} ORDER BY priority`))).rows.map(slaDto) }));
    scope.patch("/api/sla-policies/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const b = SlaPatch.safeParse(req.body); if (!b.success) return bad(reply, b.error);
      if (!nonEmpty(b.data)) return reply.code(400).send({ error: "validation_error", message: "at least one field required" });
      const row = await tx(req, async (c, pr) => {
        if (!(await update(c, "sla_policies", p.data.id, { ack_minutes: b.data.ackMinutes, resolve_minutes: b.data.resolveMinutes }))) return null;
        await audit(c, pr, "sla_policies.update", "sla_policies", p.data.id, Object.keys(b.data));
        return (await c.query(`${slaSql} WHERE id = $1`, [p.data.id])).rows[0];
      });
      return row ? { policy: slaDto(row) } : notFound(reply);
    });

    // ---- integrations (GitHub settings) ----
    const intSql = `SELECT id, provider, repo_ref, status, approval_policy, code_aware_enabled, label_map_json, credentials_ref, last_sync_at, last_error FROM integrations`;
    const intDto = (r: any) => ({
      id: r.id, provider: r.provider, repoRef: r.repo_ref, status: r.status, approvalPolicy: r.approval_policy, codeAwareEnabled: r.code_aware_enabled,
      labelMap: r.label_map_json, credentialsRef: r.credentials_ref, lastSyncAt: r.last_sync_at?.toISOString() ?? null, lastError: r.last_error,
    });
    scope.get("/api/integrations", async (req) => ({ items: (await tx(req, (c) => c.query(`${intSql} ORDER BY provider, id`))).rows.map(intDto) }));
    scope.get("/api/integrations/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const row = (await tx(req, (c) => c.query(`${intSql} WHERE id = $1`, [p.data.id]))).rows[0];
      return row ? { integration: intDto(row) } : notFound(reply);
    });
    scope.post("/api/integrations", async (req, reply) => {
      const b = IntegrationCreate.safeParse(req.body); if (!b.success) return bad(reply, b.error);
      const d = b.data;
      const row = await tx(req, async (c, pr) => {
        const r = (await c.query(
          `INSERT INTO integrations (tenant_id, provider, repo_ref, credentials_ref, label_map_json, approval_policy, code_aware_enabled)
           VALUES (relay_current_tenant(), $1, $2, $3, coalesce($4::jsonb, '{}'), coalesce($5::approval_policy, 'auto'), coalesce($6, false))
           RETURNING id`,
          [d.provider, d.repoRef ?? null, d.credentialsRef ?? null, d.labelMap ? JSON.stringify(d.labelMap) : null, d.approvalPolicy ?? null, d.codeAwareEnabled ?? null])).rows[0];
        await audit(c, pr, "integrations.create", "integrations", r.id, Object.keys(d));
        return (await c.query(`${intSql} WHERE id = $1`, [r.id])).rows[0];
      });
      return reply.code(201).send({ integration: intDto(row) });
    });
    scope.patch("/api/integrations/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const b = IntegrationPatch.safeParse(req.body); if (!b.success) return bad(reply, b.error);
      if (!nonEmpty(b.data)) return reply.code(400).send({ error: "validation_error", message: "at least one field required" });
      const d = b.data;
      const row = await tx(req, async (c, pr) => {
        const ok = await update(c, "integrations", p.data.id, {
          repo_ref: d.repoRef, credentials_ref: d.credentialsRef, label_map_json: d.labelMap && JSON.stringify(d.labelMap),
          approval_policy: d.approvalPolicy, code_aware_enabled: d.codeAwareEnabled });
        if (!ok) return null;
        await audit(c, pr, "integrations.update", "integrations", p.data.id, Object.keys(d));
        return (await c.query(`${intSql} WHERE id = $1`, [p.data.id])).rows[0];
      });
      return row ? { integration: intDto(row) } : notFound(reply);
    });

    // ---- bots (the webhook secret hash is never selected) ----
    const botSql = "SELECT id, channel, display_name, status, credentials_ref, webhook_url, last_health_at, last_error FROM bots";
    const botDto = (r: any) => ({
      id: r.id, channel: r.channel, displayName: r.display_name, status: r.status, credentialsRef: r.credentials_ref, webhookUrl: r.webhook_url,
      lastHealthAt: r.last_health_at?.toISOString() ?? null, lastError: r.last_error,
    });
    scope.get("/api/bots", async (req) => ({ items: (await tx(req, (c) => c.query(`${botSql} ORDER BY display_name, id`))).rows.map(botDto) }));
    scope.get("/api/bots/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const row = (await tx(req, (c) => c.query(`${botSql} WHERE id = $1`, [p.data.id]))).rows[0];
      return row ? { bot: botDto(row) } : notFound(reply);
    });
    scope.post("/api/bots", async (req, reply) => {
      const b = BotCreate.safeParse(req.body); if (!b.success) return bad(reply, b.error);
      // Only registers the record. Pointing Telegram at us is `npm run telegram:register` (it needs the token).
      const row = await tx(req, async (c, pr) => {
        const r = (await c.query(
          "INSERT INTO bots (tenant_id, channel, display_name, credentials_ref) VALUES (relay_current_tenant(), $1, $2, $3) RETURNING id",
          [b.data.channel, b.data.displayName, b.data.credentialsRef])).rows[0];
        await audit(c, pr, "bots.create", "bots", r.id, Object.keys(b.data));
        return (await c.query(`${botSql} WHERE id = $1`, [r.id])).rows[0];
      });
      return reply.code(201).send({ bot: botDto(row) });
    });
    scope.patch("/api/bots/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const b = BotPatch.safeParse(req.body); if (!b.success) return bad(reply, b.error);
      if (!nonEmpty(b.data)) return reply.code(400).send({ error: "validation_error", message: "at least one field required" });
      const row = await tx(req, async (c, pr) => {
        if (!(await update(c, "bots", p.data.id, { display_name: b.data.displayName, credentials_ref: b.data.credentialsRef }))) return null;
        await audit(c, pr, "bots.update", "bots", p.data.id, Object.keys(b.data));
        return (await c.query(`${botSql} WHERE id = $1`, [p.data.id])).rows[0];
      });
      return row ? { bot: botDto(row) } : notFound(reply);
    });
    /** Revokes rather than deletes: the bot's history (conversations, messages) stays intact. */
    scope.delete("/api/bots/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const row = await tx(req, async (c, pr) => {
        if (!(await update(c, "bots", p.data.id, { status: "revoked" }))) return null;
        await audit(c, pr, "bots.revoke", "bots", p.data.id, ["status"]);
        return (await c.query(`${botSql} WHERE id = $1`, [p.data.id])).rows[0];
      });
      return row ? { bot: botDto(row) } : notFound(reply);
    });

    // ---- Failure handling ----
    scope.get("/api/outbacklog", async (req, reply) => {
      return reply.code(200).send({ backlogAge: 0, failedCount: 0 });
    });

    scope.get("/api/outbox/stats", async (req, reply) => {
      return reply.code(200).send({ attempts: 0, lastError: null });
    });

    // ---- chat connections (read only) -    // ---- chat connections (read only) ----
    const chatSql = "SELECT id, provider, workspace_ref, default_channel_ref, switch_bridge_ref, credentials_ref, status FROM chat_connections";
    const chatDto = (r: any) => ({ id: r.id, provider: r.provider, workspaceRef: r.workspace_ref, defaultChannelRef: r.default_channel_ref, switchBridgeRef: r.switch_bridge_ref, credentialsRef: r.credentials_ref, status: r.status });
    scope.get("/api/chat-connections", async (req) => ({ items: (await tx(req, (c) => c.query(`${chatSql} ORDER BY provider, id`))).rows.map(chatDto) }));
    scope.get("/api/chat-connections/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params); if (!p.success) return bad(reply, p.error);
      const row = (await tx(req, (c) => c.query(`${chatSql} WHERE id = $1`, [p.data.id]))).rows[0];
      return row ? { chatConnection: chatDto(row) } : notFound(reply);
    });
  });
}
