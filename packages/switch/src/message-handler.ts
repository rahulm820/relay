// Issue #14: the `switch.post_message` outbox handler posts a draft approval/rejection to the
// ticket's Switch room, so team members see the decision alongside the GitHub issue (or the
// room-only discussion when there is no GitHub issue). Must run inside a tenant transaction.
import { withTenant, type Pool, type Client } from "@relay/db";
import { PermanentFailureError } from "@relay/core";
import type { OutboxHandler } from "@relay/core";
import { SwitchClient } from "./client.js";
import { z } from "zod";
import { sanitizeUntrusted } from "./kickoff.js";

export interface MessageHandlerDeps {
  pool: Pool;
  client?: SwitchClient;
  /** Names of the missing settings, for the failure message — leaf-level keys only. */
  missing: string[];
  /** Optional logger; defaults to no-op console.log. */
  log?: (e: unknown) => void;
}

const Payload = z.object({
  ticketId: z.uuid(),
  draftId: z.uuid(),
  event: z.enum(["approved", "rejected"]),
  decidedBy: z.string().max(200),
  reason: z.string().max(1000).optional(),
});

export function createSwitchMessageHandler(deps: MessageHandlerDeps): OutboxHandler {
  return async (input) => {
    const log = deps.log ?? ((e) => { });
    if (!deps.client) throw new PermanentFailureError(`switch is not configured: set ${deps.missing.join(", ")}`, "switch_not_configured");

    const parsed = Payload.safeParse(input.payload);
    if (!parsed.success) throw new PermanentFailureError("payload must contain a ticketId", "invalid_payload");
    const { ticketId, draftId, event, decidedBy, reason } = parsed.data;

    // Resolve the room the ticket's Switch room reference.
    const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(deps.pool, input.tenantId, fn);

    const state = await tx(async (c: Client) => {
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
      // Let the outbox dispatcher retry on transient Switch errors; permanent ones become `failed`.
      throw err;
    }
    return { note: "posted" };
  };
}