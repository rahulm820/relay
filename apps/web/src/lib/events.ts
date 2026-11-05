import { TICKET_STATUSES, type TicketStatus } from "@relay/shared/browser";
import type { TicketEvent } from "./schemas";
import { STATUS_LABEL } from "./tickets";

export type EventKind = "created" | "status" | "priority" | "assignee" | "notify" | "other";
export interface EventLine { kind: EventKind; title: string; detail?: string; actor: string }

const isStatus = (v: unknown): v is TicketStatus => typeof v === "string" && (TICKET_STATUSES as readonly string[]).includes(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function actorLabel(e: Pick<TicketEvent, "actorType" | "actorRef">): string {
  if (e.actorType === "human") return "A teammate";
  if (e.actorType === "agent") return e.actorRef ? `Agent ${e.actorRef}` : "An agent";
  return "Relay";
}

/**
 * Plain-text description of an event. Payload values are untrusted, so they are only ever interpolated as text
 * (never as markup) and only after being checked against known enums or looked up in the member list.
 */
export function describeEvent(e: TicketEvent, nameOf: ReadonlyMap<string, string>): EventLine {
  const actor = actorLabel(e);
  const p = e.payload;
  switch (e.type) {
    case "created":
      return { kind: "created", title: "Ticket created", actor };
    case "status_changed": {
      const from = isStatus(p.from) ? STATUS_LABEL[p.from] : "?";
      const to = isStatus(p.to) ? STATUS_LABEL[p.to] : "?";
      const reason = str(p.reason);
      return { kind: "status", title: `${from} → ${to}`, ...(reason ? { detail: reason } : {}), actor };
    }
    case "priority_changed":
      return { kind: "priority", title: `Priority ${str(p.from) ?? "?"} → ${str(p.to) ?? "?"}`, actor };
    case "assignee_changed": {
      const name = (v: unknown) => (typeof v === "string" ? nameOf.get(v) ?? "a teammate" : "nobody");
      return { kind: "assignee", title: `Assignee: ${name(p.from)} → ${name(p.to)}`, actor };
    }
    case "client_notified":
      return { kind: "notify", title: "Client notified", actor };
    default:
      // Unknown event types are shown by name only; their payload is never dumped.
      return { kind: "other", title: e.type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()).slice(0, 60), actor };
  }
}

/** The reason recorded when a ticket was last moved into quarantine, if any. */
export function quarantineReason(events: readonly TicketEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "status_changed" && e.payload.to === "quarantined") return str(e.payload.reason);
  }
  return undefined;
}
