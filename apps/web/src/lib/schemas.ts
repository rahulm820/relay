import { ACTOR_TYPES, APPROVAL_POLICIES, BOT_STATUSES, CATEGORIES, CHANNELS, CHAT_PROVIDERS, INTEGRATION_STATUSES, PRIORITIES, PRIORITY_SOURCES, ROLES, TICKET_STATUSES, TRACKER_PROVIDERS } from "@relay/shared/browser";
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
  items: z.array(z.object({
    id: z.string(), name: z.string(), role: z.enum(ROLES), active: z.boolean(),
    chatHandle: z.string().nullable().optional(), trackerHandle: z.string().nullable().optional(), timezone: z.string().nullable().optional(),
  })),
});
export type Member = z.infer<typeof MembersSchema>["items"][number];
export const MemberEnvelopeSchema = z.object({ member: MembersSchema.shape.items.element });

// ---- Admin / setup (apps/api admin-routes DTOs) ----

export const BotSchema = z.object({
  id: z.string(), channel: z.enum(CHANNELS), displayName: z.string(), status: z.enum(BOT_STATUSES),
  credentialsRef: z.string().nullable(), webhookUrl: z.string().nullable(),
  lastHealthAt: z.string().nullable(), lastError: z.string().nullable(),
});
export type Bot = z.infer<typeof BotSchema>;
export const BotsSchema = z.object({ items: z.array(BotSchema) });
export const BotEnvelopeSchema = z.object({ bot: BotSchema });

export const IntegrationSchema = z.object({
  id: z.string(), provider: z.enum(TRACKER_PROVIDERS), repoRef: z.string().nullable(),
  status: z.enum(INTEGRATION_STATUSES), approvalPolicy: z.enum(APPROVAL_POLICIES),
  codeAwareEnabled: z.boolean(), labelMap: z.record(z.string(), z.unknown()).nullable(),
  credentialsRef: z.string().nullable(), lastSyncAt: z.string().nullable(), lastError: z.string().nullable(),
});
export type Integration = z.infer<typeof IntegrationSchema>;
export const IntegrationsSchema = z.object({ items: z.array(IntegrationSchema) });
export const IntegrationEnvelopeSchema = z.object({ integration: IntegrationSchema });

export const RoutingRuleSchema = z.object({
  id: z.string(), position: z.number(), condition: z.record(z.string(), z.unknown()),
  action: z.record(z.string(), z.unknown()), enabled: z.boolean(),
});
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;
export const RoutingRulesSchema = z.object({ items: z.array(RoutingRuleSchema) });
export const RoutingRuleEnvelopeSchema = z.object({ rule: RoutingRuleSchema });

export const SlaPolicySchema = z.object({
  id: z.string(), priority: z.enum(PRIORITIES), ackMinutes: z.number(), resolveMinutes: z.number(),
});
export type SlaPolicy = z.infer<typeof SlaPolicySchema>;
export const SlaPoliciesSchema = z.object({ items: z.array(SlaPolicySchema) });
export const SlaPolicyEnvelopeSchema = z.object({ policy: SlaPolicySchema });

export const ChatConnectionSchema = z.object({
  id: z.string(), provider: z.enum(CHAT_PROVIDERS), workspaceRef: z.string(),
  defaultChannelRef: z.string().nullable(), switchBridgeRef: z.string().nullable(),
  credentialsRef: z.string().nullable(), status: z.string(),
});
export type ChatConnection = z.infer<typeof ChatConnectionSchema>;
export const ChatConnectionsSchema = z.object({ items: z.array(ChatConnectionSchema) });

export const OutboxStatsSchema = z.object({ attempts: z.number(), lastError: z.string().nullable() });
export const OutbacklogSchema = z.object({ backlogAge: z.number(), failedCount: z.number() });
export const SyncResultSchema = z.object({ status: z.string() });
