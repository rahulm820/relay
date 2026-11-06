import {
  StatusConflictError, TicketNotFoundError, TicketValidationError,
  approveGithubSync, getTicket, getTicketEvents, listTickets, patchTicket, transitionTicket,
} from "@relay/core";
import { withTenant, type Pool } from "@relay/db";
import { CATEGORIES, IllegalTransitionError, PRIORITIES, TICKET_STATUSES } from "@relay/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Authenticator, Principal } from "./auth.js";

export interface TicketRouteDeps {
  pool: Pool;
  authenticate: Authenticator;
}

const MAX_PAGE = 100;

const IdParams = z.object({ id: z.uuid() }).strict();
const ListQuery = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  category: z.enum(CATEGORIES).optional(),
  assigneeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(25),
  cursor: z.string().max(200).optional(),
}).strict();
// Strict on purpose: unknown fields (tenantId, status injection, ...) are rejected, not ignored.
const PatchBody = z.object({
  priority: z.enum(PRIORITIES),
  assigneeId: z.uuid().nullable(),
  status: z.enum(TICKET_STATUSES),
}).partial().strict().refine((p) => Object.keys(p).length > 0, { message: "at least one field required" });
const TransitionBody = z.object({
  to: z.enum(TICKET_STATUSES),
  /** Compare-and-set: fail with 409 unless the ticket is currently in this status. */
  from: z.enum(TICKET_STATUSES).optional(),
  reason: z.string().max(200).optional(),
}).strict();

/** Only field names are reported, never values: the values are untrusted text. */
function invalid(reply: FastifyReply, err: z.ZodError) {
  const fields = [...new Set(err.issues.map((i) => String(i.path[0] ?? "body")))].join(", ");
  return reply.code(400).send({ error: "validation_error", message: `invalid field(s): ${fields}` });
}

/**
 * Routes under /api/tickets. Every route needs an authenticated principal (401 otherwise) and runs its database
 * work in a transaction scoped to that principal's tenant, so another tenant's tickets do not exist for it (404).
 * Responses carry codes and generic messages only; unexpected errors fall through to the server's 503 handler.
 */
export function registerTicketRoutes(app: FastifyInstance, deps: TicketRouteDeps): void {
  void app.register(async (scope) => {
    const principals = new WeakMap<FastifyRequest, Principal>();

    scope.addHook("onRequest", async (req, reply) => {
      const principal = await deps.authenticate(req);
      if (!principal) return reply.code(401).send({ error: "unauthorized" });
      principals.set(req, principal);
    });

    const tenantTx = <T>(req: FastifyRequest, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(deps.pool, principals.get(req)!.tenantId, fn);

    /** Maps domain errors to HTTP; anything else is rethrown for the generic 503 handler. */
    const handle = (reply: FastifyReply, err: unknown) => {
      if (err instanceof TicketNotFoundError) return reply.code(404).send({ error: "not_found" });
      if (err instanceof IllegalTransitionError) return reply.code(409).send({ error: "illegal_transition", message: `cannot move from ${err.from} to ${err.to}` });
      if (err instanceof StatusConflictError) return reply.code(409).send({ error: "status_conflict", message: `ticket is ${err.actual}, not ${err.expected}` });
      if (err instanceof TicketValidationError) return reply.code(400).send({ error: err.code });
      throw err;
    };

    scope.get("/api/tickets", async (req, reply) => {
      const q = ListQuery.safeParse(req.query);
      if (!q.success) return invalid(reply, q.error);
      try {
        const { status, priority, category, assigneeId, limit, cursor } = q.data;
        return await tenantTx(req, (c) => listTickets(c, {
          limit, ...(status && { status }), ...(priority && { priority }), ...(category && { category }),
          ...(assigneeId && { assigneeId }), ...(cursor && { cursor }),
        }));
      } catch (err) { return handle(reply, err); }
    });

    scope.get("/api/tickets/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) return invalid(reply, p.error);
      try {
        return await tenantTx(req, async (c) => {
          const ticket = await getTicket(c, p.data.id);
          if (!ticket) throw new TicketNotFoundError();
          return { ticket, events: await getTicketEvents(c, p.data.id) };
        });
      } catch (err) { return handle(reply, err); }
    });

    scope.patch("/api/tickets/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) return invalid(reply, p.error);
      const b = PatchBody.safeParse(req.body);
      if (!b.success) return invalid(reply, b.error);
      try {
        const actor = principals.get(req)!.actor;
        return { ticket: await tenantTx(req, (c) => patchTicket(c, p.data.id, b.data, actor)) };
      } catch (err) { return handle(reply, err); }
    });

    // Releases a staged GitHub sync (approval_policy = human) to the outbox dispatcher (#12).
    scope.post("/api/tickets/:id/github-sync/approve", async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) return invalid(reply, p.error);
      try {
        const principal = principals.get(req)!;
        const approved = await tenantTx(req, async (c) => {
          const ok = await approveGithubSync(c, principal.tenantId, p.data.id);
          if (ok) await c.query(
            "INSERT INTO audit_log (tenant_id, actor, action, target, diff) VALUES (relay_current_tenant(), $1, $2, $3, $4)",
            [`user:${principal.userId}`, "tickets.approve_github_sync", `tickets:${p.data.id}`, JSON.stringify({ fields: ["github_sync"] })]);
          return ok;
        });
        if (!approved) return reply.code(409).send({ error: "conflict", message: "no staged github sync for this ticket" });
        return { approved: true };
      } catch (err) { return handle(reply, err); }
    });

    scope.post("/api/tickets/:id/transition", async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) return invalid(reply, p.error);
      const b = TransitionBody.safeParse(req.body);
      if (!b.success) return invalid(reply, b.error);
      try {
        const actor = principals.get(req)!.actor;
        return { ticket: await tenantTx(req, (c) => transitionTicket(c, {
          ticketId: p.data.id, to: b.data.to, actor, ...(b.data.from && { expected: b.data.from }), ...(b.data.reason && { reason: b.data.reason }),
        })) };
      } catch (err) { return handle(reply, err); }
    });
  });
}
