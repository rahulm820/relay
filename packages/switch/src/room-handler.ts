import { PermanentFailureError, type OutboxHandler } from "@relay/core";
import { withTenant, type Pool } from "@relay/db";
import { z } from "zod";
import { SwitchAuthError, SwitchRequestError, SwitchUnavailableError } from "./errors.js";
import type { SwitchClient } from "./client.js";
import { ROOM_INSTRUCTIONS, buildKickoff, roomDescription, roomMarker, roomName, type TicketForRoom } from "./kickoff.js";

export interface RoomHandlerDeps {
  pool: Pool;
  /** Null when Switch is not configured: the handler then fails every row loudly (see `missing`). */
  client: SwitchClient | null;
  /** Names of the settings that are missing, for the failure message. Names only. */
  missing: string[];
  triagerAgent: string;
  notifierAgent: string;
  /** Optional: create the channel on this bridge instead of Switch's default. */
  bridgeId?: string;
  /** Ids, outcomes and codes only; never text. */
  log?: (event: Record<string, unknown>) => void;
}

/** Settings required for the `switch.post_message` outbox handler. */
export interface MessageHandlerDeps {
  pool: Pool;
  /** Null when Switch is not configured: the handler then fails every row loudly (see `missing`). */
  client?: SwitchClient;
  /** Names of the missing settings, for the failure message — leaf-level keys only. */
  missing: string[];
  /** Optional logger; defaults to no-op console.log. */
  log?: (e: unknown) => void;
}

const Payload = z.object({ ticketId: z.uuid() });
const KICKOFF_EVENT = "switch_kickoff_posted";
const LINK_EVENT = "switch_room_linked";
const ACTOR = ["system", "switch:room-handler"] as const;

interface TicketRow {
  id: string; title: string; summary: string; priority: string; category: string; status: string;
  switch_room_ref: string | null; assignee_id: string | null; role_needed: string | null; sla_ack_due: Date | null;
}

/**
 * The outbox handler for `switch.create_room`: one Switch room per ticket, tagged owner, kickoff message.
 *
 * Exactly one room per ticket, even across retries and crashes:
 *   1. an advisory lock on the ticket stops two handlers working on it at once (the loser retries later)
 *   2. tickets.switch_room_ref set  -> that room is used
 *   3. otherwise the room is looked up in Switch by its description marker (recovers a room that was created
 *      before a crash, before the ref was saved) and only if absent is it created
 *   4. the ref is saved with a ticket event and an audit row, in one tenant-scoped transaction
 * The kickoff is posted after the ref is saved and recorded with a ticket event. A crash between Switch accepting
 * the post and that event being committed would repeat the kickoff on retry: the one at-least-once edge.
 *
 * Failures: Switch down, slow, 5xx or 429 -> thrown as-is (the outbox retries with backoff). Bad credentials,
 * a refused request or missing setup -> PermanentFailureError with a code (the outbox row ends `failed`).
 */
export function createSwitchRoomHandler(deps: RoomHandlerDeps): OutboxHandler {
  const log = deps.log ?? ((e) => console.log(JSON.stringify(e)));

  return async (input) => {
    if (!deps.client) throw new PermanentFailureError(`switch is not configured: set ${deps.missing.join(", ")}`, "switch_not_configured");
    const client = deps.client;
    const parsed = Payload.safeParse(input.payload);
    if (!parsed.success) throw new PermanentFailureError("payload must contain a ticketId", "invalid_payload");
    const { ticketId } = parsed.data;
    const ids = { event: "switch_room", outboxId: input.outboxId, tenantId: input.tenantId, ticketId, traceId: input.traceId };
    const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(deps.pool, input.tenantId, fn);

    // (1) one handler per ticket at a time. A session-level lock on its own connection, never a transaction.
    const lockConn = await deps.pool.connect();
    try {
      const lock = await lockConn.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [`switch-room:${ticketId}`]);
      if (!lock.rows[0]!.ok) throw Object.assign(new Error("another handler is working on this ticket"), { code: "switch_room_busy" });
      try {
        await run();
      } finally {
        await lockConn.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`switch-room:${ticketId}`]);
      }
    } catch (err) {
      throw translate(err);
    } finally {
      lockConn.release();
    }

    async function run(): Promise<void> {
      const ticket = await tx(async (c) => (await c.query<TicketRow>(
        `SELECT id, title, summary, priority, category, status, switch_room_ref, assignee_id, role_needed, sla_ack_due
         FROM tickets WHERE id = $1`, [ticketId])).rows[0]);
      if (!ticket) throw new PermanentFailureError("ticket not found", "ticket_not_found");

      const alreadyKicked = await tx(async (c) =>
        ((await c.query("SELECT 1 FROM ticket_events WHERE ticket_id = $1 AND type = $2 LIMIT 1", [ticketId, KICKOFF_EVENT])).rowCount ?? 0) > 0);
      if (ticket.switch_room_ref && alreadyKicked) {
        log({ ...ids, outcome: "already_done" });
        return;
      }

      // (2)+(3) find or create the room
      let roomRef = ticket.switch_room_ref;
      let created = false;
      if (!roomRef) {
        const agents = [deps.triagerAgent, deps.notifierAgent];
        const missing = await client.missingAgents(agents);
        if (missing.length > 0) throw new PermanentFailureError("switch agents are not registered: run npm run switch:bootstrap", "switch_agents_missing");
        const existing = await client.findRoom(roomName(ticketId), roomMarker(ticketId));
        const room = existing ?? (created = true, await client.createRoom({
          name: roomName(ticketId), description: roomDescription(ticketId), instructions: ROOM_INSTRUCTIONS,
          agentNames: agents, ...(deps.bridgeId ? { bridgeId: deps.bridgeId } : {}),
        }));
        roomRef = room.id;
        // (4) link it
        roomRef = await tx(async (c) => {
          const set = await c.query("UPDATE tickets SET switch_room_ref = $2 WHERE id = $1 AND switch_room_ref IS NULL", [ticketId, room.id]);
          if (set.rowCount === 0) {
            return (await c.query<{ switch_room_ref: string }>("SELECT switch_room_ref FROM tickets WHERE id = $1", [ticketId])).rows[0]!.switch_room_ref;
          }
          await c.query(
            "INSERT INTO ticket_events (tenant_id, ticket_id, type, actor_type, actor_ref, payload, created_at) VALUES (relay_current_tenant(), $1, $2, $3, $4, $5, clock_timestamp())",
            [ticketId, LINK_EVENT, ACTOR[0], ACTOR[1], JSON.stringify({ roomRef: room.id, recovered: !created })]);
          await c.query(
            "INSERT INTO audit_log (tenant_id, actor, action, target, diff) VALUES (relay_current_tenant(), $1, 'ticket.switch_room_linked', $2, $3)",
            [`${ACTOR[0]}:${ACTOR[1]}`, `ticket:${ticketId}`, JSON.stringify({ switchRoomRef: room.id })]);
          return room.id;
        });
        log({ ...ids, outcome: created ? "room_created" : "room_recovered" });
      }

      // people: assignee, else the members of the role that should handle it (default: pm)
      const handles = await tx(async (c) => {
        const rows = ticket.assignee_id
          ? (await c.query<{ chat_handle: string | null }>("SELECT chat_handle FROM members WHERE id = $1 AND active", [ticket.assignee_id])).rows
          : (await c.query<{ chat_handle: string | null }>(
              "SELECT chat_handle FROM members WHERE role = coalesce($1::role, 'pm') AND active AND chat_handle IS NOT NULL ORDER BY name LIMIT 3", [ticket.role_needed])).rows;
        return rows.map((r) => r.chat_handle).filter((h): h is string => !!h);
      });
      // Unknown chat users are skipped by Switch; one missing person must not fail the room.
      const { added, missing: unknownUsers } = await client.addUsers(roomRef, handles);
      if (unknownUsers.length > 0) log({ ...ids, outcome: "users_not_found", count: unknownUsers.length });

      // kickoff (once)
      if (!alreadyKicked) {
        const github = await tx(async (c) => (await c.query<{ external_issue_url: string; external_issue_number: number | null }>(
          "SELECT external_issue_url, external_issue_number FROM tracker_issues WHERE ticket_id = $1 AND external_issue_url IS NOT NULL ORDER BY created_at LIMIT 1", [ticketId])).rows[0]);
        const view: TicketForRoom = {
          id: ticket.id, title: ticket.title, summary: ticket.summary, priority: ticket.priority, category: ticket.category,
          status: ticket.status, slaAckDue: ticket.sla_ack_due?.toISOString() ?? null, ownerHandles: added,
          ...(github ? { github: { url: github.external_issue_url, number: github.external_issue_number } } : {}),
        };
        await client.postToRoom(roomRef, buildKickoff(view));
        await tx((c) => c.query(
          "INSERT INTO ticket_events (tenant_id, ticket_id, type, actor_type, actor_ref, payload, created_at) VALUES (relay_current_tenant(), $1, $2, $3, $4, $5, clock_timestamp())",
          [ticketId, KICKOFF_EVENT, ACTOR[0], ACTOR[1], JSON.stringify({ roomRef, ownersTagged: added.length })]));
        log({ ...ids, outcome: "kickoff_posted" });
      }
    }
  };
}

/** Switch errors -> outbox semantics: unavailable = retry, everything else = give up with a code. */
function translate(err: unknown): unknown {
  if (err instanceof PermanentFailureError) return err;
  if (err instanceof SwitchAuthError) return new PermanentFailureError("switch rejected the credentials", err.code);
  if (err instanceof SwitchRequestError) return new PermanentFailureError(err.message, err.code);
  if (err instanceof SwitchUnavailableError) return Object.assign(new Error("switch is unavailable"), { code: err.code });
  return err;
}

export function createSwitchMessageHandler(deps: MessageHandlerDeps): OutboxHandler {
  return async (input) => {
    const log = deps.log ?? ((e) => { });
    if (!deps.client) throw new PermanentFailureError(`switch is not configured: set ${deps.missing.join(", ")}`, "switch_not_configured");

    const parsed = Payload.safeParse(input.payload);
    if (!parsed.success) throw new PermanentFailureError("payload must contain a ticketId", "invalid_payload");
    const { ticketId, draftId, event, decidedBy, reason } = parsed.data;

    // Resolve the room the ticket's Switch room reference.
    const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(deps.pool, input.tenantId, fn);

    const state = await tx(async (c) => {
      const ticket = await c.query<{ title: string; switch_room_ref: string | null }>(
        "SELECT title, switch_room_ref FROM tickets WHERE id = $1", [ticketId],
      ).rows[0];
      if (!ticket) return { kind: "no_ticket" as const };
      if (!ticket.switch_room_ref) return { kind: "no_room" as const };
      const draft = await c.query<{ draft_json: unknown }>(
        "SELECT draft_json FROM issue_drafts WHERE id = $1", [draftId],
      ).rows[0];
      return { kind: "ready" as const, roomRef: ticket.switch_room_ref, ticketTitle: ticket.title, draftTitle: draft?.draft_json?.title ?? null };
    });

    if (state.kind === "no_ticket") throw new PermanentFailureError("ticket not found", "ticket_not_found");
    if (state.kind === "no_room") return { note: "no_room" };

    const text = event === "approved"
      ? `Issue draft approved: "${state.draftTitle ?? state.ticketTitle}" — the GitHub issue is on its way.`
      : `Issue draft rejected${reason ? ` — ${sanitizeUntrusted(reason, 1000)}` : ""} — "${state.draftTitle ?? state.ticketTitle}"`;

    log({ event, ticketId, text: text.slice(0, 200) });
    try {
      await deps.client.postToRoom(state.roomRef, text);
    } catch (err) {
      throw err;
    }
    return { note: "posted" };
  };
}
