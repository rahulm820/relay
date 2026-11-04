import type { TicketStatus } from "./enums.js";

// Allowed ticket transitions (architecture §5). The diagram is ambiguous about a few arrows;
// the choices below are documented in the PR. Terminal-ish states can only be left via `reopened`.
export const TICKET_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  received: ["needs_info", "triaged", "quarantined"],
  needs_info: ["triaged", "quarantined"],
  quarantined: ["received", "triaged"],
  triaged: ["assigned", "escalated"],
  assigned: ["in_progress", "escalated"],
  escalated: ["assigned", "in_progress"],
  in_progress: ["in_review", "resolved", "escalated"],
  in_review: ["in_progress", "resolved"],
  resolved: ["closed", "reopened"],
  closed: ["reopened"],
  reopened: ["assigned", "in_progress"],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TicketStatus,
    readonly to: TicketStatus,
  ) {
    super(`Illegal ticket transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(from: TicketStatus, to: TicketStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
