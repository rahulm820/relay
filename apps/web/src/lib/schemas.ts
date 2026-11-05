import { ACTOR_TYPES, CATEGORIES, PRIORITIES, PRIORITY_SOURCES, ROLES, TICKET_STATUSES } from "@relay/shared/browser";
import { z } from "zod";

// Response shapes of the real API (packages/core TicketView / TicketEventView, apps/api auth + members routes).
// Validating at the boundary means a contract drift shows up as one clear error, not as undefined in a component.
export const TicketSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  priorityReason: z.string().nullable(),
  prioritySource: z.enum(PRIORITY_SOURCES),
  status: z.enum(TICKET_STATUSES),
  assigneeId: z.string().nullable(),
  roleNeeded: z.enum(ROLES).nullable(),
  trackerRef: z.string().nullable(),
  switchRoomRef: z.string().nullable(),
  affectedClientCount: z.number(),
  slaAckDue: z.string().nullable(),
  slaResolveDue: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const TicketListSchema = z.object({ items: z.array(TicketSchema), nextCursor: z.string().nullable() });
export const TicketEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  actorType: z.enum(ACTOR_TYPES),
  actorRef: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type TicketEvent = z.infer<typeof TicketEventSchema>;
export const TicketDetailSchema = z.object({ ticket: TicketSchema, events: z.array(TicketEventSchema) });
export const TicketEnvelopeSchema = z.object({ ticket: TicketSchema });

export const MeSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.string() }),
  tenant: z.object({ id: z.string(), name: z.string().nullable() }),
});
export type Me = z.infer<typeof MeSchema>;

export const MembersSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(ROLES), active: z.boolean() })),
});
export type Member = z.infer<typeof MembersSchema>["items"][number];
