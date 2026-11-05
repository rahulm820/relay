import type { Client } from "@relay/db";
import { TICKET_STATUSES, type TicketStatus } from "@relay/shared";
import { z } from "zod";
import { enqueueOutbox } from "../outbox/index.js";

/**
 * Which status changes the client hears about. Everything else is internal bookkeeping (received, triaged,
 * assigned, in_review, escalated, quarantined, closed) and stays silent.
 */
export const NOTIFYING_STATUSES = ["needs_info", "in_progress", "resolved", "reopened"] as const satisfies readonly TicketStatus[];
export const statusNotifies = (status: TicketStatus): boolean => (NOTIFYING_STATUSES as readonly string[]).includes(status);

/**
 * The payload of a `client.send` outbox row: ids and a kind, never text. The handler builds the text from fixed
 * templates when it sends.
 *   ack     -> "we received your message" for an inbound message (lists the tickets it produced)
 *   refusal -> polite scoped reply to an off-topic message
 *   status  -> a ticket moved to `status`
 */
export const ClientSendPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ack"), messageId: z.uuid(), sensitive: z.boolean().default(false) }),
  z.object({ kind: z.literal("refusal"), messageId: z.uuid() }),
  z.object({ kind: z.literal("status"), ticketId: z.uuid(), status: z.enum(TICKET_STATUSES), eventId: z.uuid() }),
]);
export type ClientSendPayload = z.infer<typeof ClientSendPayloadSchema>;

/**
 * Idempotency key of a client.send row.
 *   ack / refusal: client:{tenantId}:{inboundMessageId}:{kind}   -- once per inbound message
 *   status:        client:{tenantId}:{ticketId}:status:{status}:{eventId}
 * The status key includes the `status_changed` event id, so every occurrence of a transition is its own key:
 * reopened -> resolved a second time notifies again, exactly once, and one transition can never notify twice.
 */
export function clientSendKey(tenantId: string, p: ClientSendPayload): string {
  return p.kind === "status"
    ? `client:${tenantId}:${p.ticketId}:status:${p.status}:${p.eventId}`
    : `client:${tenantId}:${p.messageId}:${p.kind}`;
}

/** Writes a client.send outbox row in the caller's transaction. Safe to repeat (unique key). */
export async function enqueueClientSend(c: Client, tenantId: string, payload: ClientSendPayload, traceId: string): Promise<{ inserted: boolean }> {
  const { inserted } = await enqueueOutbox(c, { kind: "client.send", tenantId, idempotencyKey: clientSendKey(tenantId, payload), traceId, payload });
  return { inserted };
}

/**
 * Called by transitionTicket, inside the same transaction as the status change and its event, so the message is
 * queued if and only if the change commits. Issue #21's webhook reaches it by calling transitionTicket.
 * Returns false (and queues nothing) for silent statuses and for tickets with no conversation to reply in.
 */
export async function notifyClientStatusChange(
  c: Client,
  input: { tenantId: string; ticketId: string; to: TicketStatus; eventId: string; traceId: string },
): Promise<boolean> {
  if (!statusNotifies(input.to)) return false;
  const { rows } = await c.query("SELECT 1 FROM tickets WHERE id = $1 AND conversation_id IS NOT NULL", [input.ticketId]);
  if (rows.length === 0) return false;
  await enqueueClientSend(c, input.tenantId, { kind: "status", ticketId: input.ticketId, status: input.to, eventId: input.eventId }, input.traceId);
  return true;
}
