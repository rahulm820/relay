import { PRIORITIES, TICKET_TRANSITIONS, type Category, type Priority, type TicketStatus } from "@relay/shared/browser";
import type { Ticket } from "./schemas";

export type LaneId = "inbox" | "triaged" | "progress" | "resolved";

// Eleven statuses are too many columns for a glanceable board. Lanes group them by "whose move is it":
// Inbox = nobody has decided yet, Triaged = decided/waiting for a person to pick up, In progress = being worked,
// Resolved = done. The exact status stays visible on every card and in the drawer.
export const LANES: ReadonlyArray<{ id: LaneId; label: string; hint: string; statuses: readonly TicketStatus[] }> = [
  { id: "inbox", label: "Inbox", hint: "New, waiting for information, or held for a human", statuses: ["received", "needs_info", "quarantined"] },
  { id: "triaged", label: "Triaged", hint: "Classified and waiting to be picked up", statuses: ["triaged", "assigned", "escalated"] },
  { id: "progress", label: "In progress", hint: "Being worked on or in review", statuses: ["in_progress", "in_review", "reopened"] },
  { id: "resolved", label: "Resolved", hint: "Fixed or closed", statuses: ["resolved", "closed"] },
];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  received: "Received",
  needs_info: "Needs info",
  triaged: "Triaged",
  assigned: "Assigned",
  in_progress: "In progress",
  in_review: "In review",
  resolved: "Resolved",
  closed: "Closed",
  quarantined: "Needs human triage",
  escalated: "Escalated",
  reopened: "Reopened",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  bug: "Bug", ui: "UI", question: "Question", feature: "Feature", billing: "Billing", other: "Other",
};

export const PRIORITY_LABEL: Record<Priority, string> = { P1: "Urgent", P2: "High", P3: "Normal", P4: "Low" };
export { PRIORITIES };

export function laneOf(status: TicketStatus): LaneId {
  return LANES.find((l) => l.statuses.includes(status))!.id;
}

export function groupByLane(tickets: readonly Ticket[]): Record<LaneId, Ticket[]> {
  const out: Record<LaneId, Ticket[]> = { inbox: [], triaged: [], progress: [], resolved: [] };
  for (const t of tickets) out[laneOf(t.status)].push(t);
  return out;
}

/** Only the moves the API would accept. The server stays the authority; this just avoids offering dead ends. */
export function legalNextStatuses(from: TicketStatus): readonly TicketStatus[] {
  return TICKET_TRANSITIONS[from];
}

/** REL-XXXXXXXX: the first 8 hex digits of the uuid. Display only; the full id is used for API calls. */
export function shortId(id: string): string {
  return `REL-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export interface TicketFilters { priority: Priority | "all"; category: Category | "all"; query: string }
export const NO_FILTERS: TicketFilters = { priority: "all", category: "all", query: "" };

export function matchesQuery(t: Ticket, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || t.title.toLowerCase().includes(q) || shortId(t.id).toLowerCase().includes(q);
}

export function hasActiveFilters(f: TicketFilters): boolean {
  return f.priority !== "all" || f.category !== "all" || f.query.trim() !== "";
}
