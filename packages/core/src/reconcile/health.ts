import { getSyncHealthCounts, type Pool, type SyncHealthCounts } from "@relay/db";
import { emptySummary, type ReconcileSummary } from "./reconcile.js";

export interface AlertThresholds {
  /** Alert when the oldest unfinished github.* outbox row is older than this (architecture §13: 10 minutes). */
  backlogSeconds: number;
}

export type SyncAlertCode = "github_outbox_backlog_stale" | "github_sync_failed_beyond_budget" | "github_outbox_failed";
export interface SyncAlert { code: SyncAlertCode; value: number }

/** Pure: which alert conditions hold for these counts. Empty list means healthy. */
export function evaluateAlerts(c: SyncHealthCounts, t: AlertThresholds): SyncAlert[] {
  const alerts: SyncAlert[] = [];
  if (c.outboxOldestSeconds > t.backlogSeconds) alerts.push({ code: "github_outbox_backlog_stale", value: c.outboxOldestSeconds });
  if (c.syncFailedBeyondBudget > 0) alerts.push({ code: "github_sync_failed_beyond_budget", value: c.syncFailedBeyondBudget });
  if (c.outboxFailed > 0) alerts.push({ code: "github_outbox_failed", value: c.outboxFailed });
  return alerts;
}

/** Running totals since this worker started (not persisted: a restart resets them; the database counts are the truth). */
export class SyncMetrics {
  private totals: ReconcileSummary = emptySummary();
  private passes = 0;
  private lastPassAt: Date | null = null;
  private lastPassFailed = false;

  record(s: ReconcileSummary, now: Date = new Date()): void {
    for (const k of Object.keys(this.totals) as (keyof ReconcileSummary)[]) this.totals[k] += s[k];
    this.passes++;
    this.lastPassAt = now;
    this.lastPassFailed = false;
  }
  /** A whole pass threw (database down, ...). */
  recordFailure(now: Date = new Date()): void { this.lastPassAt = now; this.lastPassFailed = true; }

  snapshot() {
    return { passes: this.passes, lastPassAt: this.lastPassAt?.toISOString() ?? null, lastPassFailed: this.lastPassFailed, totals: { ...this.totals } };
  }
}

export interface SyncHealth {
  status: "ok" | "degraded";
  outbox: { githubBacklog: number; oldestSeconds: number; failed: number };
  trackerIssues: { pending: number; failed: number; created: number; closed: number; failedBeyondBudget: number };
  alerts: SyncAlert[];
  reconcile: ReturnType<SyncMetrics["snapshot"]>;
}

export function toSyncHealth(c: SyncHealthCounts, t: AlertThresholds, metrics: SyncMetrics): SyncHealth {
  const alerts = evaluateAlerts(c, t);
  return {
    status: alerts.length === 0 ? "ok" : "degraded",
    outbox: { githubBacklog: c.outboxBacklog, oldestSeconds: c.outboxOldestSeconds, failed: c.outboxFailed },
    trackerIssues: { pending: c.syncPending, failed: c.syncFailed, created: c.syncCreated, closed: c.syncClosed, failedBeyondBudget: c.syncFailedBeyondBudget },
    alerts,
    reconcile: metrics.snapshot(),
  };
}

/** GitHub sync health across all tenants: counts and alert flags only. Worker only (cross-tenant function). */
export async function getSyncHealth(pool: Pool, retryBudget: number, t: AlertThresholds, metrics: SyncMetrics): Promise<SyncHealth> {
  return toSyncHealth(await getSyncHealthCounts(pool, retryBudget), t, metrics);
}
