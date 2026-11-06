import { DraftConflictError, DraftNotFoundError, approveIssueDraft, rejectIssueDraft } from "@relay/core";
import { withTenant, type Pool } from "@relay/db";
import { DRAFT_STATUSES } from "@relay/shared";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Authenticator, Principal } from "./auth.js";

const IdParams = z.object({ id: z.uuid() }).strict();
const ListQuery = z.object({ status: z.enum(DRAFT_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
const RejectBody = z.object({ reason: z.string().min(1).max(500) }).strict();

function loadDraft(c: Client, id: string) {
  const { rows } = c.query(
    `SELECT d.id, d.ticket_id, d.status, d.repo_ref, d.draft_json, d.evidence_refs, d.confidence, d.decided_by, d.decided_at, d.reject_reason, d.created_at, t.title AS ticket_title
       FROM issue_drafts d JOIN tickets t ON t.id = d.ticket_id
      WHERE d.id = $1`, [id],
  );
  return rows[0];
}

function dtoFromRow(r: any) {
  const conf = Number(r.confidence);
  return {
    id: r.id, ticketId: r.ticket_id, ticketTitle: r.ticketTitle,
    status: r.status, repoRef: r.repo_ref, draftJson: r.draft_json,
    confidence: isNaN(conf) ? undefined : conf,
    decidedBy: r.decided_by, decidedAt: r.decided_at?.toISOString() ?? null,
    rejectReason: r.reject_reason, createdAt: r.created_at?.toISOString() ?? null,
  };
}

export function registerIssueDraftRoutes(app: FastifyInstance, deps: { pool: Pool; authenticate: Authenticator }): void {
  void app.register(async (scope) => {
    const principals = new WeakMap<FastifyRequest, Principal>();

    scope.addHook("onRequest", async (req, reply) => {
      const principal = await deps.authenticate(req);
      if (!principal) return reply.code(401).send({ error: "unauthorized" });
      principals.set(req, principal);
    });

    const tenantTx = <T>(req: FastifyRequest, fn: (c: Client, p: Principal) => Promise<T>) => withTenant(deps.pool, principals.get(req)!.tenantId, fn);

    scope.get("/api/issue-drafts", async (req, reply) => {
      const q = ListQuery.safeParse(req.query);
      if (!q.success) return invalid(reply, q.error);
      try {
        const { status, limit } = q.data;
        const where = status ? "AND d.status = $${status_offset}" : "";
        // build with $2 offset — the status value placeholder needs a distinct $ marker
        // We'll use a simpler pattern: always pass status, which defaults to all, and filter client-side
        // Actually pass status if provided; the DTO already has where clause below
        const base = `
          SELECT d.id, d.ticket_id, d.status, d.repo_ref, d.draft_json, d.evidence_refs, d.confidence,
                 d.decided_by, d.decided_at, d.reject_reason, d.created_at, t.title AS ticket_title
            FROM issue_drafts d JOIN tickets t ON t.id = d.ticket_id
           WHERE 1=1 ${status ? "AND d.status = $2" : ""}
           ORDER BY d.created_at DESC LIMIT $${status ? 3 : 4}
        `;
        const params = status ? [status, limit] : [limit];
        const { rows } = await tenantTx(req, (c) => c.query(base, params));
        return { items: rows.map(dtoFromRow) };
      } catch (err) { return handle(reply, err); }
    });

    scope.post("/api/issue-drafts/:id/approve", async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) return invalid(reply, p.error);
      try {
        const principal = principals.get(req)!;
        const approved = await tenantTx(req, async (c) => {
          const ok = await approveIssueDraft(c, { tenantId: principal.tenantId, draftId: p.data.id, decidedBy: `user:${principal.userId}` });
          return ok;
        });
        if (!approved) return reply.code(409).send({ error: "conflict", message: "no staged github sync for this ticket" });
        return { approved: true };
      } catch (err) {
        if (err instanceof DraftNotFoundError) return reply.code(404).send({ error: "not_found", message: "issue draft not found" });
        if (err instanceof DraftConflictError) return reply.code(409).send({ error: "conflict", message: err.message });
        return handle(reply, err);
      }
    });

    scope.post("/api/issue-drafts/:id/reject", async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) return invalid(reply, p.error);
      try {
        const body = RejectBody.safeParse(req.body);
        if (!body.success) return invalid(reply, body.error);
        const principal = principals.get(req)!;
        const result = await tenantTx(req, async (c) => {
          return rejectIssueDraft(c, { tenantId: principal.tenantId, draftId: p.data.id, decidedBy: `user:${principal.userId}`, reason: body.data.reason });
        });
        return { approved: false, ...result };
      } catch (err) {
        if (err instanceof DraftNotFoundError) return reply.code(404).send({ error: "not_found", message: "issue draft not found" });
        if (err instanceof DraftConflictError) return reply.code(409).send({ error: "conflict", message: err.message });
        return handle(reply, err);
      }
    });
  });
}

function invalid(reply: FastifyReply, err: z.ZodError) {
  const fields = [...new Set(err.issues.map((i) => String(i.path[0] ?? "body")))].join(", ");
  return reply.code(400).send({ error: "validation_error", message: `invalid field(s): ${fields}` });
}

function handle(reply: FastifyReply, err: unknown) {
  if (err instanceof DraftNotFoundError) return reply.code(404).send({ error: "not_found", message: err.message });
  if (err instanceof DraftConflictError) return reply.code(409).send({ error: "conflict", message: err.message });
  throw err;
}