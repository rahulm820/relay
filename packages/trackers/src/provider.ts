// TrackerProvider: the interface every issue tracker implements (architecture §4.8). The orchestrator
// calls providers directly and deterministically; no LLM is involved in these calls.

export type TrackerName = "github";

export interface RepoRef {
  owner: string;
  name: string;
}

/** Parses `owner/name`. Throws TrackerError("invalid_repo") for anything else. */
export function parseRepoRef(ref: string): RepoRef {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(ref.trim());
  if (!m) throw new TrackerError("invalid_repo", "repo_ref must be owner/name");
  return { owner: m[1]!, name: m[2]! };
}

export interface NewIssue {
  title: string;
  body: string;
  labels: string[];
}

export interface ExternalIssue {
  /** Provider-specific id, as a string (GitHub node/REST id). */
  id: string;
  number: number;
  url: string;
}

/** An issue found by `findIssueByTicket`: the reference plus whether it is still open. */
export interface FoundIssue extends ExternalIssue {
  state: "open" | "closed";
}

export interface IssueStatus {
  state: "open" | "closed";
  labels: string[];
}

export interface TrackerProvider {
  readonly provider: TrackerName;
  /** Creates an issue. GitHub has no idempotency keys, so callers must guard against repeats (see tracker_issues). */
  createIssue(repo: string, issue: NewIssue): Promise<ExternalIssue>;
  updateIssue(repo: string, number: number, patch: Partial<NewIssue> & { state?: "open" | "closed" }): Promise<ExternalIssue>;
  addComment(repo: string, number: number, body: string): Promise<{ id: string }>;
  /** Cross-references two issues by commenting on both. */
  linkIssues(repo: string, from: number, to: number): Promise<void>;
  getStatus(repo: string, number: number): Promise<IssueStatus>;
  /**
   * Finds the issue created for a Relay ticket (matched on the ticket id that issue bodies carry), or null.
   * Used by the reconcile job to repair a row whose creation call timed out or crashed after GitHub accepted it.
   * Search is eventually consistent, so callers must not treat null as proof for a very recent attempt.
   */
  findIssueByTicket(repo: string, ticketId: string): Promise<FoundIssue | null>;
  /** Parses a verified inbound webhook into a status event. Implemented in Issue #21. */
  onWebhook(event: string, payload: unknown): WebhookEvent | null;
}

export interface WebhookEvent {
  kind: "issue.state" | "issue.labels";
  repo: string;
  number: number;
  state?: "open" | "closed";
  labels?: string[];
}

/**
 * Error with a stable `code`. The code is the only part that is stored on a row (tracker_issues.last_error),
 * so it must never contain response bodies, tokens or client text.
 */
export class TrackerError extends Error {
  constructor(
    readonly code:
      | "invalid_repo"
      | "auth"
      | "forbidden"
      | "not_found"
      | "rate_limited"
      | "validation"
      | "server"
      | "timeout"
      | "network"
      | "not_implemented",
    message: string,
    /** How long the provider asked us to wait (rate limits). Milliseconds. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TrackerError";
  }
}
