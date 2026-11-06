import type { Client } from "@relay/db";
import {
  assertTransition, githubIdempotencyKey,
  type ActorType, type Category, type Priority, type PrioritySource, type Role, type TicketStatus,
} from "@relay/shared";
import { enqueueOutbox } from "../outbox/index.js";
import type { ExtractedIssueDetail } from "../github-sync/issue.js";
import { notifyClientStatusChange } from "./client-notify.js";
import { StatusConflictError, TicketNotFoundError, TicketValidationError } from "./errors.js";

export interface Actor {
  type: ActorType;
  /** Who: a user id, an agent name or a component such as `pipeline:ticket`. Never client text. */
  ref: string;
}

/** What the API returns for a ticket (the shared TicketDto plus the fields the board needs). */
export interface TicketView {
  id: string;
  title: string;
  summary: string;
  category: Category;
  priority: Priority;
  priorityReason: string | null;
  prioritySource: PrioritySource;
  status: TicketStatus;
  assigneeId: string | null;
  roleNeeded: Role | null;
  trackerRef: string | null;
  switchRoomRef: string | null;
  affectedClientCount: number;
  slaAckDue: string | null;
  slaResolveDue: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TicketEventView {
  id: string;
  type: string;
  actorType: ActorType;
  actorRef: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

const COLUMNS = `id, title, summary, category, priority, priority_reason, priority_source, status, assignee_id, role_needed,
  tracker_ref, switch_room_ref, affected_client_count, sla_ack_due, sla_resolve_due, source_message_id,
  created_at, created_at::text AS created_at_raw, resolved_at`;

interface TicketRow {
  id: string; title: string; summary: string; category: Category; priority: Priority; priority_reason: string | null;
  priority_source: PrioritySource; status: TicketStatus; assignee_id: string | null; role_needed: Role | null;
  tracker_ref: string | null; switch_room_ref: string | null; affected_client_count: number;
  sla_ack_due: Date | null; sla_resolve_due: Date | null; source_message_id: string | null;
  created_at: Date; created_at_raw: string; resolved_at: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const toView = (r: TicketRow): TicketView => ({
  id: r.id, title: r.title, summary: r.summary, category: r.category, priority: r.priority,
  priorityReason: r.priority_reason, prioritySource: r.priority_source, status: r.status,
  assigneeId: r.assignee_id, roleNeeded: r.role_needed, trackerRef: r.tracker_ref, switchRoomRef: r.switch_room_ref,
  affectedClientCount: r.affected_client_count, slaAckDue: iso(r.sla_ack_due), slaResolveDue: iso(r.sla_resolve_due),
  sourceMessageId: r.source_message_id, createdAt: r.created_at.toISOString(), resolvedAt: iso(r.resolved_at),
});

async function addEvent(c: Client, ticketId: string, type: string, actor: Actor, payload: Record<string, unknown>): Promise<string> {
  // ticket_events is append-only for the app role: this INSERT is the only way history is written.
  const { rows } = await c.query<{ id: string }>(
    // clock_timestamp(), not the default now(): now() is frozen at transaction start, which would give every
    // event of one transaction the same time and leave their order to chance.
    "INSERT INTO ticket_events (tenant_id, ticket_id, type, actor_type, actor_ref, payload, created_at) VALUES (relay_current_tenant(), $1, $2, $3, $4, $5, clock_timestamp()) RETURNING id",
    [ticketId, type, actor.type, actor.ref, JSON.stringify(payload)],
  );
  return rows[0]!.id;
}

async function currentTenant(c: Client): Promise<string> {
  return (await c.query<{ t: string }>("SELECT relay_current_tenant() AS t")).rows[0]!.t;
}

// ---------------------------------------------------------------------------------------------------
// Outbox for a new ticket
// ---------------------------------------------------------------------------------------------------

/**
 * Writes the outbox rows that make a ticket reach GitHub and Switch. Call it in the SAME transaction as the
 * ticket insert (or the release from quarantine). Safe to repeat: the unique idempotency keys make a second
 * call a no-op. client.send is Issue #16's job, not written here.
 *
 * GitHub (#12): only an active integration with a repo selected gets rows, and both of them together — the
 * `tracker_issues` link (pending) and the `github.create_issue` outbox row, so the link can never exist
 * without the job that fills it. `approval_policy = human` stages the outbox row (`staged`), which the
 * dispatcher never picks up until an approval flips it to `pending`. A quarantined ticket gets no GitHub
 * rows: nothing leaves the platform until a human releases it (transitionTicket writes them on release).
 */
export async function enqueueTicketOutbox(
  c: Client, tenantId: string, ticketId: string, traceId: string, detail?: ExtractedIssueDetail,
): Promise<void> {
  const held = (await c.query<{ status: string }>("SELECT status FROM tickets WHERE id = $1", [ticketId])).rows[0]?.status === "quarantined";
  if (!held) {
    const integration = (await c.query<{ repo_ref: string | null; approval_policy: "auto" | "human" }>(
      "SELECT repo_ref, approval_policy FROM integrations WHERE provider = 'github' AND status = 'active' LIMIT 1",
    )).rows[0];
    if (integration?.repo_ref) {
      const key = githubIdempotencyKey(tenantId, ticketId, "general");
      await c.query(
        `INSERT INTO tracker_issues (tenant_id, ticket_id, provider, repo_ref, sync_mode, sync_status, idempotency_key)
         VALUES (relay_current_tenant(), $1, 'github', $2, 'general', 'pending', $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [ticketId, integration.repo_ref, key],
      );
      await enqueueOutbox(
        c,
        { kind: "github.create_issue", tenantId, idempotencyKey: key, traceId, payload: { ticketId, ...(detail ? { detail } : {}) } },
        { status: integration.approval_policy === "human" ? "staged" : "pending" },
      );
    }
  }
  await enqueueOutbox(c, { kind: "switch.create_room", tenantId, idempotencyKey: `switch:${tenantId}:${ticketId}`, traceId, payload: { ticketId } });
}

// ---------------------------------------------------------------------------------------------------
// Status changes (the only code that changes tickets.status)
// ---------------------------------------------------------------------------------------------------

/**
 * Moves a ticket to `to`. In the caller's transaction it locks the row, checks the state machine, updates the
 * ticket and writes exactly one `status_changed` event, so concurrent callers are serialised and an illegal
 * move changes nothing. `expected` makes it a compare-and-set: it fails with StatusConflictError if the
 * ticket is not in that status.
 * Throws TicketNotFoundError, StatusConflictError, or IllegalTransitionError (from @relay/shared).
 */
export async function transitionTicket(
  c: Client,
  input: { ticketId: string; to: TicketStatus; actor: Actor; reason?: string; expected?: TicketStatus },
): Promise<TicketView> {
  const locked = await c.query<{ status: TicketStatus }>("SELECT status FROM tickets WHERE id = $1 FOR UPDATE", [input.ticketId]);
  const from = locked.rows[0]?.status;
  if (!from) throw new TicketNotFoundError();
  if (input.expected && input.expected !== from) throw new StatusConflictError(input.expected, from);
  assertTransition(from, input.to);
  await c.query(
    `UPDATE tickets SET status = $2::ticket_status,
       resolved_at = CASE WHEN $2::ticket_status = 'resolved' THEN now() WHEN $2::ticket_status = 'reopened' THEN NULL ELSE resolved_at END
     WHERE id = $1`,
    [input.ticketId, input.to],
  );
  const eventId = await addEvent(c, input.ticketId, "status_changed", input.actor, { from, to: input.to, ...(input.reason ? { reason: input.reason } : {}) });
  const tenantId = await currentTenant(c);
  if (from === "quarantined" && input.to === "triaged") {
    // Released by a human: now the ticket may leave the platform.
    await enqueueTicketOutbox(c, tenantId, input.ticketId, `release-${input.ticketId}`);
  }
  // The single place every status change passes through, so the client hears about each notifying change exactly
  // once, in this same transaction (queued if and only if the change commits).
  await notifyClientStatusChange(c, { tenantId, ticketId: input.ticketId, to: input.to, eventId, traceId: `ticket-${input.ticketId}` });
  return (await getTicket(c, input.ticketId))!;
}

// ---------------------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------------------

export interface NewTicket {
  /** Position of the issue in the extraction; with messageId it identifies the ticket for replays. */
  issueIndex: number;
  title: string;
  summary: string;
  category: Category;
  priority: Priority;
  priorityReason: string;
  prioritySource: PrioritySource;
  roleNeeded?: Role | null;
  assigneeId?: string | null;
  /** Set to hold the ticket in quarantine; no outbox rows are written unless `outbox` is true. */
  quarantineReason?: string;
  /** Whether GitHub and Switch should be told about this ticket now. */
  outbox: boolean;
  /** Extraction's product area; a rule signal for duplicate detection (#11). */
  productArea?: string | null;
  /** Embedding of title and summary, stored for duplicate detection (#11). */
  embedding?: number[] | null;
  /** Reproduction detail from the extraction, carried in the outbox payload so the GitHub issue keeps it (#12). */
  detail?: ExtractedIssueDetail;
}

export interface CreatedTicket {
  ticketId: string;
  /** False when the ticket already existed (a replay): nothing was written. */
  created: boolean;
}

const MAX_TITLE = 200;
const MAX_SUMMARY = 2000;

/**
 * Creates one ticket per entry for a message, atomically with its events and outbox rows, in the caller's
 * transaction. Replays are safe: the (source_message_id, source_issue_index) unique index turns a repeat into
 * ON CONFLICT DO NOTHING, and because the ticket, events and outbox rows commit together, an existing ticket
 * already has all of them.
 */
export async function createTicketsForMessage(
  c: Client,
  input: { tenantId: string; messageId: string; traceId: string; actor: Actor; tickets: NewTicket[] },
): Promise<CreatedTicket[]> {
  const ctx = await c.query<{ client_id: string; conversation_id: string }>(
    "SELECT v.client_id, m.conversation_id FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE m.id = $1",
    [input.messageId],
  );
  const source = ctx.rows[0];
  if (!source) throw new TicketValidationError("message_not_found");

  const out: CreatedTicket[] = [];
  for (const t of input.tickets) {
    const inserted = await c.query<{ id: string }>(
      `INSERT INTO tickets (tenant_id, client_id, conversation_id, title, summary, category, priority, priority_reason,
                            priority_source, role_needed, assignee_id, source_message_id, source_issue_index,
                            sla_ack_due, sla_resolve_due, product_area)
       VALUES (relay_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               now() + (SELECT make_interval(mins => ack_minutes) FROM sla_policies WHERE priority = $6),
               now() + (SELECT make_interval(mins => resolve_minutes) FROM sla_policies WHERE priority = $6), $13)
       ON CONFLICT (source_message_id, source_issue_index) WHERE source_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        source.client_id, source.conversation_id, t.title.slice(0, MAX_TITLE), t.summary.slice(0, MAX_SUMMARY), t.category,
        t.priority, t.priorityReason, t.prioritySource, t.roleNeeded ?? null, t.assigneeId ?? null, input.messageId, t.issueIndex,
        t.productArea ?? null,
      ],
    );
    if (!inserted.rows[0]) {
      const existing = await c.query<{ id: string }>(
        "SELECT id FROM tickets WHERE source_message_id = $1 AND source_issue_index = $2", [input.messageId, t.issueIndex]);
      out.push({ ticketId: existing.rows[0]!.id, created: false });
      continue;
    }
    const ticketId = inserted.rows[0].id;
    if (t.embedding) await c.query("UPDATE tickets SET embedding = $2::vector WHERE id = $1", [ticketId, `[${t.embedding.join(",")}]`]);
    await addEvent(c, ticketId, "created", input.actor, {
      messageId: input.messageId, issueIndex: t.issueIndex, category: t.category, priority: t.priority, prioritySource: t.prioritySource,
    });
    if (t.quarantineReason) {
      await transitionTicket(c, { ticketId, to: "quarantined", actor: input.actor, reason: t.quarantineReason });
    }
    if (t.outbox) await enqueueTicketOutbox(c, input.tenantId, ticketId, input.traceId, t.detail);
    out.push({ ticketId, created: true });
  }
  return out;
}

/**
 * A client message in a conversation that has a ticket waiting for their answer (status needs_info) is that
 * answer: it is recorded on the ticket (`client_replied`) and the ticket moves on to `triaged`, instead of
 * opening a new ticket. Returns the ticket id, or null when nothing was waiting. Safe to repeat for the same
 * message: the first run's event is found and the same ticket id is returned.
 */
export async function attachClientReply(c: Client, messageId: string, actor: Actor): Promise<string | null> {
  const prior = await c.query<{ ticket_id: string }>("SELECT ticket_id FROM ticket_events WHERE type = 'client_replied' AND payload->>'messageId' = $1 LIMIT 1", [messageId]);
  if (prior.rows[0]) return prior.rows[0].ticket_id;
  const waiting = await c.query<{ id: string }>(
    `SELECT id FROM tickets WHERE status = 'needs_info' AND conversation_id = (SELECT conversation_id FROM messages WHERE id = $1)
     ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`, [messageId]);
  const ticketId = waiting.rows[0]?.id;
  if (!ticketId) return null;
  await addEvent(c, ticketId, "client_replied", actor, { messageId });
  await transitionTicket(c, { ticketId, to: "triaged", actor, reason: "client replied" });
  return ticketId;
}

// ---------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------

export async function getTicket(c: Client, ticketId: string): Promise<TicketView | null> {
  const { rows } = await c.query<TicketRow>(`SELECT ${COLUMNS} FROM tickets WHERE id = $1`, [ticketId]);
  return rows[0] ? toView(rows[0]) : null;
}

export async function getTicketEvents(c: Client, ticketId: string): Promise<TicketEventView[]> {
  const { rows } = await c.query(
    "SELECT id, type, actor_type, actor_ref, payload, created_at FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at, id",
    [ticketId],
  );
  return rows.map((r) => ({ id: r.id, type: r.type, actorType: r.actor_type, actorRef: r.actor_ref, payload: r.payload, createdAt: r.created_at.toISOString() }));
}

export interface TicketFilters {
  status?: TicketStatus;
  priority?: Priority;
  category?: Category;
  assigneeId?: string;
  limit: number;
  cursor?: string;
}

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (at && id && CURSOR_TIME.test(at) && UUID.test(id)) return { at, id };
  } catch { /* fall through */ }
  throw new TicketValidationError("invalid_cursor");
}

/**
 * Newest first, ties broken by id, so the order is total and stable. The cursor carries the last row's exact
 * (microsecond) timestamp and id; pages never repeat or skip rows even when new tickets arrive.
 */
export async function listTickets(c: Client, f: TicketFilters): Promise<{ items: TicketView[]; nextCursor: string | null }> {
  const after = f.cursor ? decodeCursor(f.cursor) : null;
  const { rows } = await c.query<TicketRow>(
    `SELECT ${COLUMNS} FROM tickets
     WHERE ($1::ticket_status IS NULL OR status = $1) AND ($2::priority IS NULL OR priority = $2)
       AND ($3::category IS NULL OR category = $3) AND ($4::uuid IS NULL OR assignee_id = $4)
       AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
     ORDER BY created_at DESC, id DESC LIMIT $7`,
    [f.status ?? null, f.priority ?? null, f.category ?? null, f.assigneeId ?? null, after?.at ?? null, after?.id ?? null, f.limit + 1],
  );
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > f.limit && last ? Buffer.from(`${last.created_at_raw}|${last.id}`).toString("base64url") : null;
  return { items: page.map(toView), nextCursor };
}

// ---------------------------------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------------------------------

export interface TicketPatchInput {
  priority?: Priority;
  assigneeId?: string | null;
  status?: TicketStatus;
}

/**
 * Applies a human/operator override in one transaction: each changed field writes a ticket event, a status
 * change goes through transitionTicket, and one audit_log row records the whole change. Nothing is written if
 * any part fails (the caller's transaction rolls back).
 */
export async function patchTicket(c: Client, ticketId: string, patch: TicketPatchInput, actor: Actor): Promise<TicketView> {
  const locked = await c.query<{ priority: Priority; assignee_id: string | null; status: TicketStatus }>(
    "SELECT priority, assignee_id, status FROM tickets WHERE id = $1 FOR UPDATE", [ticketId]);
  const cur = locked.rows[0];
  if (!cur) throw new TicketNotFoundError();
  const diff: Record<string, { from: unknown; to: unknown }> = {};

  if (patch.priority !== undefined && patch.priority !== cur.priority) {
    await c.query(
      `UPDATE tickets SET priority = $2, priority_source = 'human', priority_reason = 'manual override',
         sla_ack_due = created_at + (SELECT make_interval(mins => ack_minutes) FROM sla_policies WHERE priority = $2),
         sla_resolve_due = created_at + (SELECT make_interval(mins => resolve_minutes) FROM sla_policies WHERE priority = $2)
       WHERE id = $1`,
      [ticketId, patch.priority],
    );
    await addEvent(c, ticketId, "priority_changed", actor, { from: cur.priority, to: patch.priority });
    diff["priority"] = { from: cur.priority, to: patch.priority };
  }
  if (patch.assigneeId !== undefined && patch.assigneeId !== cur.assignee_id) {
    if (patch.assigneeId !== null) {
      const member = await c.query("SELECT 1 FROM members WHERE id = $1 AND active", [patch.assigneeId]);
      if (member.rowCount === 0) throw new TicketValidationError("unknown_assignee");
    }
    await c.query("UPDATE tickets SET assignee_id = $2 WHERE id = $1", [ticketId, patch.assigneeId]);
    await addEvent(c, ticketId, "assignee_changed", actor, { from: cur.assignee_id, to: patch.assigneeId });
    diff["assigneeId"] = { from: cur.assignee_id, to: patch.assigneeId };
  }
  if (patch.status !== undefined && patch.status !== cur.status) {
    await transitionTicket(c, { ticketId, to: patch.status, actor, reason: "manual override" });
    diff["status"] = { from: cur.status, to: patch.status };
  }
  if (Object.keys(diff).length > 0) {
    await c.query(
      "INSERT INTO audit_log (tenant_id, actor, action, target, diff) VALUES (relay_current_tenant(), $1, 'ticket.patch', $2, $3)",
      [`${actor.type}:${actor.ref}`, `ticket:${ticketId}`, JSON.stringify(diff)],
    );
  }
  return (await getTicket(c, ticketId))!;
}
