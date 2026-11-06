// Domain enums shared by every package (architecture §5, §6, §8). Each is a const tuple
// plus a derived type so zod schemas and plain TypeScript use the same source of truth.

export const CATEGORIES = ["bug", "ui", "question", "feature", "billing", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ["P1", "P2", "P3", "P4"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_SOURCES = ["rules", "llm", "human"] as const;
export type PrioritySource = (typeof PRIORITY_SOURCES)[number];

export const TICKET_STATUSES = [
  "received",
  "needs_info",
  "triaged",
  "assigned",
  "in_progress",
  "in_review",
  "resolved",
  "closed",
  "quarantined",
  "escalated",
  "reopened",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const ROLES = ["designer", "developer", "tester", "pm"] as const;
export type Role = (typeof ROLES)[number];

export const CLIENT_TIERS = ["free", "paid", "enterprise"] as const;
export type ClientTier = (typeof CLIENT_TIERS)[number];

export const CHANNELS = ["telegram", "whatsapp"] as const;
export type Channel = (typeof CHANNELS)[number];

export const ACTOR_TYPES = ["system", "agent", "human"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const APPROVAL_POLICIES = ["auto", "human"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const SYNC_MODES = ["general", "code_aware"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const SYNC_STATUSES = ["pending", "created", "failed", "closed"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Outbox job kinds: every external side effect goes through one of these (architecture §4.6). */
export const OUTBOX_KINDS = ["github.create_issue", "github.draft", "github.update_issue", "github.comment", "switch.create_room", "switch.post_message", "client.send"] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/** Ordered pipeline stages run by the orchestrator (architecture §4.3, Issue #6). */
export const PIPELINE_STAGES = [
  "extract",
  "dedupe",
  "priority",
  "ticket",
  "github-sync",
  "switch",
  "notify",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Queue consumer groups: the pipeline stages plus the raw-event `ingest` step (Issue #4). */
export const QUEUE_STAGES = ["ingest", ...PIPELINE_STAGES] as const;
export type QueueStage = (typeof QUEUE_STAGES)[number];

export const OUTBOX_STATUSES = ["pending", "staged", "processing", "done", "failed"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const BOT_STATUSES = ["pending", "active", "error", "revoked"] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

/** Status of a chat connection or tracker integration. */
export const INTEGRATION_STATUSES = ["active", "error", "revoked"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const DRAFT_STATUSES = ["pending", "approved", "rejected", "superseded"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ["in", "out"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const CHAT_PROVIDERS = ["slack", "teams", "mattermost", "discord"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export const TRACKER_PROVIDERS = ["github", "jira", "linear"] as const;
export type TrackerProviderName = (typeof TRACKER_PROVIDERS)[number];

export const CONVERSATION_STATUSES = ["open", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
