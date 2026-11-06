// GitHub reconcile job (Issue #20, architecture §4.6 and §4.10). Compares tracker_issues with GitHub and repairs drift:
//
//   pending / failed row  ->  look the issue up on GitHub by ticket id.
//                              found    -> link it (repair); never creates a second issue
//                              not found-> create exactly one
//   created row, stale    ->  refresh: a closed issue becomes `closed`; a deleted one becomes `failed` so the next
//                              pass recreates it
//
// Safety rules:
//  - Rows are claimed with a lease (next_attempt_at pushed forward), so several workers never act on the same row.
//  - No database transaction is open during a GitHub call.
//  - Failures back off with jitter, bounded; a rate limit stops the whole pass and honours Retry-After.
//  - After a timeout/network/5xx the create may have succeeded, so the next look is delayed (`ambiguousFloorMs`)
//    to give GitHub's search index time to show the issue before we would create another.
//  - Only fields and codes are logged, never ticket text or tokens.
import { GitHubProvider, TrackerError, type ExternalIssue, type FoundIssue, type LabelMap, type TrackerProvider } from "@relay/trackers";
import type { SecretProvider } from "@relay/shared";
import { computeBackoffMs } from "../outbox/backoff.js";
import { composeIssue, resolveToken, type TicketForIssue } from "../github-sync/issue.js";

export interface ClaimedSync {
  id: string;
  tenantId: string;
  ticketId: string;
  repo: string | null;
  status: "pending" | "failed" | "created";
  externalNumber: number | null;
  /** Reconcile attempts so far, including this one (0 for a `created` refresh). */
  attempts: number;
}

export interface SyncIntegration {
  repo: string | null;
  credentialsRef: string | null;
  labelMap: LabelMap;
}

/** Storage the job needs. Postgres in production (pg-store.ts), memory in unit tests. Every method is tenant-scoped. */
export interface ReconcileStore {
  candidates(limit: number): Promise<{ id: string; tenantId: string }[]>;
  /** Leases the row for `leaseSeconds`; null if someone else got it or it is no longer eligible. */
  claim(candidate: { id: string; tenantId: string }, leaseSeconds: number): Promise<ClaimedSync | null>;
  integration(tenantId: string): Promise<SyncIntegration | null>;
  ticket(tenantId: string, ticketId: string): Promise<TicketForIssue | null>;
  /** The issue exists: link it. `via` says whether we found it (repair) or created it. */
  linked(row: ClaimedSync, issue: ExternalIssue, closed: boolean, via: "repair" | "create"): Promise<void>;
  /** Created row whose GitHub issue is closed. */
  closed(row: ClaimedSync): Promise<void>;
  /** Created row checked and still open: nothing to change but the timestamps. */
  refreshed(row: ClaimedSync): Promise<void>;
  /** Records a failure code and schedules the next look. */
  failed(row: ClaimedSync, code: string, retryInSeconds: number): Promise<void>;
  /** Nothing wrong, but not now (quarantined ticket, credentials temporarily unreadable on a healthy row). */
  deferred(row: ClaimedSync, retryInSeconds: number): Promise<void>;
}

export interface ReconcileOptions {
  store: ReconcileStore;
  secrets: SecretProvider;
  createProvider?: (token: string) => TrackerProvider;
  batchSize?: number;
  leaseSeconds?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Minimum wait after an outcome-unknown failure (timeout, network, 5xx) on a create. */
  ambiguousFloorMs?: number;
  random?: () => number;
  log?: (event: ReconcileLogEvent) => void;
}

export interface ReconcileLogEvent {
  event: "reconcile_repaired" | "reconcile_created" | "reconcile_closed" | "reconcile_failed" | "reconcile_rate_limited" | "reconcile_deferred" | "reconcile_error";
  syncId: string;
  tenantId: string;
  ticketId?: string;
  attempt?: number;
  errorCode?: string;
}

export interface ReconcileSummary {
  examined: number;
  /** Row linked to an issue that already existed on GitHub (no duplicate created). */
  repaired: number;
  /** Missing issue created. */
  created: number;
  closed: number;
  refreshed: number;
  failed: number;
  deferred: number;
  rateLimited: number;
  /** Another worker got the row first. */
  contended: number;
}

export const emptySummary = (): ReconcileSummary => ({ examined: 0, repaired: 0, created: 0, closed: 0, refreshed: 0, failed: 0, deferred: 0, rateLimited: 0, contended: 0 });

const AMBIGUOUS = new Set(["timeout", "network", "server"]);
const DEFER_SECONDS = 3600;

/** One pass over due rows. Never throws for a single bad row; a rate limit ends the pass early. */
export async function reconcileOnce(opts: ReconcileOptions): Promise<ReconcileSummary> {
  const o = {
    batchSize: opts.batchSize ?? 20,
    leaseSeconds: opts.leaseSeconds ?? 120,
    backoffBaseMs: opts.backoffBaseMs ?? 60_000,
    backoffMaxMs: opts.backoffMaxMs ?? 3_600_000,
    ambiguousFloorMs: opts.ambiguousFloorMs ?? 300_000,
    createProvider: opts.createProvider ?? ((token: string) => new GitHubProvider({ token })),
    log: opts.log ?? ((e: ReconcileLogEvent) => console.log(JSON.stringify(e))),
  };
  const summary = emptySummary();

  for (const candidate of await opts.store.candidates(o.batchSize)) {
    const row = await opts.store.claim(candidate, o.leaseSeconds);
    if (!row) { summary.contended++; continue; }
    summary.examined++;
    try {
      const stop = await processRow(opts, o, row, summary);
      if (stop) break;
    } catch (err) {
      // A bug or a database error on one row: record a generic failure and carry on with the others.
      summary.failed++;
      o.log({ event: "reconcile_error", syncId: row.id, tenantId: row.tenantId, errorCode: err instanceof Error ? err.name : "unknown" });
      await opts.store.failed(row, "unexpected_error", retryDelaySeconds(o, row.attempts, opts.random)).catch(() => undefined);
    }
  }
  return summary;
}

type Resolved = Required<Pick<ReconcileOptions, "batchSize" | "leaseSeconds" | "backoffBaseMs" | "backoffMaxMs" | "ambiguousFloorMs">> & {
  createProvider: (token: string) => TrackerProvider;
  log: (e: ReconcileLogEvent) => void;
};

const retryDelaySeconds = (o: Resolved, attempts: number, random?: () => number, hintMs?: number, floorMs = 0): number =>
  Math.ceil(Math.max(computeBackoffMs(attempts, { baseMs: o.backoffBaseMs, maxMs: o.backoffMaxMs, hintMs, ...(random ? { random } : {}) }), floorMs) / 1000);

/** Returns true when the pass should stop (rate limited). */
async function processRow(opts: ReconcileOptions, o: Resolved, row: ClaimedSync, summary: ReconcileSummary): Promise<boolean> {
  const ids = { syncId: row.id, tenantId: row.tenantId, ticketId: row.ticketId, attempt: row.attempts };
  const isCreated = row.status === "created";
  // A healthy `created` row is never turned into a failure because of a problem on our side; it is just retried later.
  const cannot = async (code: string): Promise<boolean> => {
    if (isCreated) { summary.deferred++; o.log({ event: "reconcile_deferred", ...ids, errorCode: code }); await opts.store.deferred(row, retryDelaySeconds(o, 1, opts.random)); }
    else { summary.failed++; o.log({ event: "reconcile_failed", ...ids, errorCode: code }); await opts.store.failed(row, code, retryDelaySeconds(o, row.attempts, opts.random)); }
    return false;
  };

  const integration = await opts.store.integration(row.tenantId);
  if (!integration) return cannot("integration_unavailable");
  const repo = row.repo ?? integration.repo;
  if (!repo) return cannot("no_repo");
  const token = await resolveToken(opts.secrets, integration.credentialsRef);
  if (!token) return cannot("missing_credentials");
  const provider = o.createProvider(token);

  // A created row with its issue number only needs a status refresh; every other row needs the ticket to look up or create.
  const refreshOnly = isCreated && row.externalNumber !== null;
  let ticket: TicketForIssue | null = null;
  if (!refreshOnly) {
    ticket = await opts.store.ticket(row.tenantId, row.ticketId);
    if (!ticket) return false; // the ticket is gone; the row goes with it (ON DELETE CASCADE)
    if (ticket.status === "quarantined") {
      // Held for a human: nothing may leave the platform. Look again much later.
      summary.deferred++;
      o.log({ event: "reconcile_deferred", ...ids, errorCode: "quarantined" });
      await opts.store.deferred(row, DEFER_SECONDS);
      return false;
    }
  }

  try {
    if (refreshOnly) {
      const status = await provider.getStatus(repo, row.externalNumber!);
      if (status.state === "closed") { await opts.store.closed(row); summary.closed++; o.log({ event: "reconcile_closed", ...ids }); }
      else { await opts.store.refreshed(row); summary.refreshed++; }
      return false;
    }

    // 1. Does the issue already exist? (creation may have timed out or crashed after GitHub accepted it)
    const found: FoundIssue | null = await provider.findIssueByTicket(repo, row.ticketId);
    if (found) {
      await opts.store.linked(row, found, found.state === "closed", "repair");
      summary.repaired++;
      o.log({ event: "reconcile_repaired", ...ids });
      return false;
    }
    // 2. Missing: create exactly one. The row's lease and the unique idempotency key keep other workers out.
    const issue = composeIssue(ticket!, integration.labelMap);
    const made = await provider.createIssue(repo, issue);
    await opts.store.linked(row, made, false, "create");
    summary.created++;
    o.log({ event: "reconcile_created", ...ids });
    return false;
  } catch (err) {
    const code = err instanceof TrackerError ? err.code : "unknown";
    // A created row whose issue is gone (404) becomes `failed`, so the next pass looks for it and recreates it.
    if (isCreated && code === "not_found") {
      summary.failed++;
      o.log({ event: "reconcile_failed", ...ids, errorCode: "issue_missing" });
      await opts.store.failed(row, "issue_missing", 0);
      return false;
    }
    const rateLimited = code === "rate_limited";
    const delay = retryDelaySeconds(o, Math.max(1, row.attempts), opts.random, err instanceof TrackerError ? err.retryAfterMs : undefined, AMBIGUOUS.has(code) && !isCreated ? o.ambiguousFloorMs : 0);
    if (isCreated) { summary.deferred++; o.log({ event: "reconcile_deferred", ...ids, errorCode: code }); await opts.store.deferred(row, delay); }
    else { summary.failed++; o.log({ event: rateLimited ? "reconcile_rate_limited" : "reconcile_failed", ...ids, errorCode: code }); await opts.store.failed(row, code, delay); }
    if (rateLimited) { summary.rateLimited++; return true; } // do not hammer a rate-limited API with the rest of the batch
    return false;
  }
}
