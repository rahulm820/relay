import type { Ticket } from "./schemas";

export type SlaState = "ok" | "due_soon" | "breached" | "met" | "missed" | "none";

const DONE = new Set(["resolved", "closed"]);
const MIN = 60_000;

/**
 * SLA state for the resolve clock. Active tickets are `breached` once now >= due, `due_soon` when the remaining time
 * is at most a quarter of the whole window (and never less than 30 minutes of warning), otherwise `ok`.
 * Finished tickets report whether they were `met` or `missed`.
 */
export function slaState(t: Pick<Ticket, "slaResolveDue" | "createdAt" | "status" | "resolvedAt">, now: number): SlaState {
  if (!t.slaResolveDue) return "none";
  const due = Date.parse(t.slaResolveDue);
  if (Number.isNaN(due)) return "none";
  if (DONE.has(t.status)) {
    const doneAt = t.resolvedAt ? Date.parse(t.resolvedAt) : now;
    return doneAt <= due ? "met" : "missed";
  }
  if (now >= due) return "breached";
  const window = due - Date.parse(t.createdAt);
  const warn = Math.max(30 * MIN, Number.isFinite(window) && window > 0 ? window / 4 : 0);
  return due - now <= warn ? "due_soon" : "ok";
}

/** "2d 4h", "3h 05m", "42m", "3m 10s", "<1m". Seconds only appear in the last 10 minutes, where they matter. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m >= 10) return `${m}m`;
  if (m >= 1) return `${m}m ${String(s).padStart(2, "0")}s`;
  return total >= 1 ? `${s}s` : "<1s";
}

/** Text for the SLA chip. */
export function slaLabel(t: Pick<Ticket, "slaResolveDue" | "createdAt" | "status" | "resolvedAt">, now: number): string {
  const state = slaState(t, now);
  if (state === "none") return "No SLA";
  if (state === "met") return "SLA met";
  if (state === "missed") return "SLA missed";
  const due = Date.parse(t.slaResolveDue!);
  return state === "breached" ? `Overdue ${formatDuration(now - due)}` : `${formatDuration(due - now)} left`;
}
