import { z } from "zod";
import {
  ACTOR_TYPES,
  CATEGORIES,
  CHANNELS,
  OUTBOX_KINDS,
  PRIORITIES,
  QUEUE_STAGES,
  TICKET_STATUSES,
  type SyncMode,
  type SyncStatus,
} from "./enums.js";

// Cross-service contracts: inbound message, queue and outbox envelopes, tracker provider,
// code-aware draft and API DTOs (architecture §4.1, §4.8, §4.10.2).

// ---- Channel Gateway (§4.1) ----
export const NormalizedMessageSchema = z.object({
  tenantId: z.string().min(1),
  botId: z.string().min(1),
  channel: z.enum(CHANNELS),
  platformMessageId: z.string().min(1),
  platformChatId: z.string().min(1),
  senderRef: z.string().min(1),
  text: z.string(),
  attachments: z
    .array(z.object({ type: z.string(), ref: z.string(), mime: z.string() }))
    .default([]),
  receivedAt: z.iso.datetime(),
  replyTo: z.string().nullable().default(null),
});
export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;

export interface InboundRequest {
  headers: Readonly<Record<string, string | undefined>>;
  /** Raw body, needed for HMAC-style verification. */
  rawBody: string | Uint8Array;
}
export interface SendResult {
  platformMessageId: string;
}
export interface HealthStatus {
  ok: boolean;
  detail?: string;
}
export interface ChannelAdapter {
  verifyRequest(req: InboundRequest): boolean;
  parseInbound(req: InboundRequest): NormalizedMessage[];
  send(botId: string, conversationId: string, content: string): Promise<SendResult>;
  fetchMedia(ref: string): Promise<Uint8Array>;
  healthCheck(botId: string): Promise<HealthStatus>;
}

// ---- Queue and outbox envelopes ----
export const QueueEnvelopeSchema = z.object({
  stage: z.enum(QUEUE_STAGES),
  tenantId: z.string().min(1),
  conversationId: z.string().min(1),
  traceId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type QueueEnvelope = z.infer<typeof QueueEnvelopeSchema>;

export const OutboxJobSchema = z.object({
  kind: z.enum(OUTBOX_KINDS),
  tenantId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  traceId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type OutboxJob = z.infer<typeof OutboxJobSchema>;

/** `github:{tenantId}:{ticketId}:{mode}` (architecture §4.10). */
export function githubIdempotencyKey(tenantId: string, ticketId: string, mode: SyncMode): string {
  return `github:${tenantId}:${ticketId}:${mode}`;
}

// ---- Tracker (§4.8) ----
export interface IssueInput {
  title: string;
  body: string;
  labels: string[];
}
export interface ExternalIssueRef {
  externalId: string;
  number: number;
  url: string;
  repo: string;
}
export interface TrackerStatus {
  open: boolean;
  syncStatus: SyncStatus;
}
export interface TrackerWebhookEvent {
  externalId: string;
  action: string;
  labels: string[];
}
export interface TrackerProvider {
  createIssue(input: IssueInput, idempotencyKey: string): Promise<ExternalIssueRef>;
  updateIssue(ref: ExternalIssueRef, patch: Partial<IssueInput>): Promise<void>;
  addComment(ref: ExternalIssueRef, body: string): Promise<void>;
  linkIssues(a: ExternalIssueRef, b: ExternalIssueRef): Promise<void>;
  getStatus(ref: ExternalIssueRef): Promise<TrackerStatus>;
  onWebhook(rawBody: string, signature: string | undefined): Promise<TrackerWebhookEvent[]>;
}

/** Code-aware issue draft (§4.10.2). Files may only be listed if present in retrieved context. */
export const GithubDraftV1Schema = z.object({
  version: z.literal("github.draft.v1"),
  title: z.string().min(1),
  description: z.string(),
  suspected_files: z.array(z.string()).default([]),
  reproduction: z.array(z.string()).default([]),
  expected: z.string().nullable().default(null),
  actual: z.string().nullable().default(null),
  evidence_refs: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});
export type GithubDraftV1 = z.infer<typeof GithubDraftV1Schema>;

// ---- API DTOs (§9) ----
export const TicketPatchSchema = z
  .object({
    priority: z.enum(PRIORITIES),
    assigneeId: z.string().nullable(),
    status: z.enum(TICKET_STATUSES),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "at least one field required" });
export type TicketPatch = z.infer<typeof TicketPatchSchema>;

export const TicketDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  status: z.enum(TICKET_STATUSES),
  assigneeId: z.string().nullable(),
  trackerRef: z.string().nullable(),
  switchRoomRef: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type TicketDto = z.infer<typeof TicketDtoSchema>;

export const TicketEventSchema = z.object({
  type: z.string(),
  actorType: z.enum(ACTOR_TYPES),
  actorRef: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type TicketEvent = z.infer<typeof TicketEventSchema>;

export const ApiErrorSchema = z.object({ error: z.string(), message: z.string().optional() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

