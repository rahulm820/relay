"use client";
import { AlertTriangle, CheckCircle2, Clock, ShieldAlert } from "lucide-react";
import type { Priority, TicketStatus } from "@relay/shared/browser";
import { useNow } from "../lib/hooks";
import type { Ticket } from "../lib/schemas";
import { slaLabel, slaState, type SlaState } from "../lib/sla";
import { PRIORITY_LABEL, STATUS_LABEL } from "../lib/tickets";
import { cn } from "./ui";

const PRIORITY_STYLE: Record<Priority, string> = {
  P1: "text-p1 border-p1/35 bg-p1/10",
  P2: "text-p2 border-p2/35 bg-p2/10",
  P3: "text-p3 border-p3/35 bg-p3/10",
  P4: "text-p4 border-p4/30 bg-p4/10",
};

export function PriorityChip({ priority, withLabel }: { priority: Priority; withLabel?: boolean }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-semibold tnum", PRIORITY_STYLE[priority])}>
      {priority}
      {withLabel && <span className="font-medium">{PRIORITY_LABEL[priority]}</span>}
    </span>
  );
}

const STATUS_DOT: Partial<Record<TicketStatus, string>> = {
  quarantined: "bg-quarantine", escalated: "bg-bad", needs_info: "bg-warn", resolved: "bg-ok", closed: "bg-t3", reopened: "bg-warn",
};
export function StatusChip({ status }: { status: TicketStatus }) {
  if (status === "quarantined") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-quarantine">
        <ShieldAlert className="size-3.5" aria-hidden /> {STATUS_LABEL[status]}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-t2">
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[status] ?? "bg-t2")} aria-hidden /> {STATUS_LABEL[status]}
    </span>
  );
}

const SLA_STYLE: Record<SlaState, string> = {
  ok: "text-t2 border-line-strong",
  due_soon: "text-warn border-warn/40 bg-warn/10",
  breached: "text-bad border-bad/40 bg-bad/10",
  met: "text-ok border-ok/30",
  missed: "text-t3 border-line-strong",
  none: "text-t3 border-line-strong",
};
const SLA_ICON: Record<SlaState, typeof Clock> = { ok: Clock, due_soon: Clock, breached: AlertTriangle, met: CheckCircle2, missed: AlertTriangle, none: Clock };

type SlaInput = Pick<Ticket, "slaResolveDue" | "createdAt" | "status" | "resolvedAt">;
export function SlaChip({ ticket }: { ticket: SlaInput }) {
  const now = useNow() || Date.now();
  const state = slaState(ticket, now);
  if (state === "none") return null;
  const Icon = SLA_ICON[state];
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium tnum", SLA_STYLE[state])}>
      <Icon className="size-3" aria-hidden /> {slaLabel(ticket, now)}
    </span>
  );
}
