// The `github.create_issue` outbox handler (Issue #12, architecture §4.10.1). The ticket stage writes the
// outbox row and the `tracker_issues` link in one transaction; this handler performs the GitHub call and
// fills the link in. It is the only place a general-mode issue is created (reconcile repairs drift later).
//
// Never two issues for one ticket:
//   1. the unique `idempotency_key` means only one row (and one job) can ever exist for the ticket
//   2. a pre-create lookup: a row already `created`/`closed` finishes without a request
//   3. before creating, the issue is searched by its ticket id marker: a crash between GitHub accepting
//      the create and our row being saved links that issue instead of making a second one
// Failures mark `tracker_issues` failed with a stable code (the ticket itself is never touched) and are
// rethrown: permanent ones fail the outbox row, transient ones retry with backoff — and leave the row
// eligible for the reconcile job, which is the long-term repair path.
import { GitHubProvider, TrackerError, labelsFor, parseLabelMap, type FoundIssue, type TrackerProvider } from "@relay/trackers";
import { githubIdempotencyKey, type SecretProvider } from "@relay/shared";
import { withTenant, type Client, type Pool } from "@relay/db";
import { z } from "zod";
import { PermanentFailureError } from "../queue/index.js";
import type { OutboxHandler } from "../outbox/index.js";
import { composeIssue, loadTicket, recordIssueLinked, resolveToken, type ExtractedIssueDetail } from "./issue.js";
import { GithubDraftSchema, draftIssueBody } from "./draft.js";

export interface GithubCreateIssueOptions {
  /** Worker pool; every database call runs tenant-scoped through withTenant. */
  pool: Pool;
  /** Resolves integrations.credentials_ref (e.g. env:GITHUB_TOKEN) to the token. */
  secrets: SecretProvider;
  /** Builds the provider for a token. Defaults to GitHubProvider. Injected in tests. */
  createProvider?: (token: string) => TrackerProvider;
}

const Payload = z.object({
  ticketId: z.uuid(),
  /** Reproduction detail the ticket stage carried from the extraction; the issue body is composed from it. */
  detail: z.object({
    steps_to_reproduce: z.array(z.string().max(4000)).max(100).optional(),
    expected: z.string().max(20000).nullable().optional(),
    actual: z.string().max(20000).nullable().optional(),
    missing_info: z.array(z.string().max(4000)).max(100).optional(),
  }).optional(),
});

const ACTOR_REF = "outbox:github.create_issue";
/** How long a failed row waits before the reconcile job may pick it up (the outbox retries faster than this). */
const RECONCILE_DELAY_SECONDS = 300;
/** Codes that are worth retrying; everything else fails the outbox row for good. */
const TRANSIENT = new Set(["rate_limited", "server", "timeout", "network"]);

export function createGithubCreateIssueHandler(opts: GithubCreateIssueOptions): OutboxHandler {
  const createProvider = opts.createProvider ?? ((token: string) => new GitHubProvider({ token }));

  return async (input) => {
    const parsed = Payload.safeParse(input.payload);
    if (!parsed.success) throw new PermanentFailureError("payload must contain a ticketId", "invalid_payload");
    const { ticketId, detail } = parsed.data;
    const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(opts.pool, input.tenantId, fn);

    const markFailed = (code: string) => tx((c) => c.query(
      `UPDATE tracker_issues SET sync_status = 'failed', last_error = $2, last_synced_at = now(),
              sync_attempts = sync_attempts + 1, next_attempt_at = now() + make_interval(secs => $3)
        WHERE idempotency_key = $1`,
      [input.idempotencyKey, code, RECONCILE_DELAY_SECONDS],
    )).then(() => undefined);

    /** Classify and rethrow: the dispatcher retries transient errors and fails the row on permanent ones. */
    const fail = async (err: unknown): Promise<never> => {
      const code = err instanceof TrackerError ? err.code : "unknown";
      await markFailed(code);
      if (err instanceof TrackerError && !TRANSIENT.has(err.code)) {
        throw new PermanentFailureError("github request rejected", err.code);
      }
      throw err;
    };

    const state = await tx(async (c) => {
      const ticket = await loadTicket(c, ticketId);
      if (!ticket) return { kind: "no_ticket" as const };
      if (ticket.status === "quarantined") return { kind: "quarantined" as const };
      const integration = (await c.query<{ repo_ref: string | null; credentials_ref: string | null; label_map_json: unknown }>(
        "SELECT repo_ref, credentials_ref, label_map_json FROM integrations WHERE provider = 'github' AND status = 'active' LIMIT 1",
      )).rows[0];
      if (!integration?.repo_ref) return { kind: "no_integration" as const };
      // (2) a row that already reached GitHub: a retry (or a second delivery) must not create again.
      const existing = (await c.query<{ sync_status: string }>(
        "SELECT sync_status FROM tracker_issues WHERE idempotency_key = $1", [input.idempotencyKey],
      )).rows[0];
      if (existing && (existing.sync_status === "created" || existing.sync_status === "closed")) return { kind: "already" as const };
      // The link row normally exists from ticket creation; write it here for tickets released from quarantine.
      await c.query(
        `INSERT INTO tracker_issues (tenant_id, ticket_id, provider, repo_ref, sync_mode, sync_status, idempotency_key)
         VALUES (relay_current_tenant(), $1, 'github', $2, 'general', 'pending', $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [ticketId, integration.repo_ref, input.idempotencyKey],
      );
      const token = await resolveToken(opts.secrets, integration.credentials_ref);
      if (!token) return { kind: "no_token" as const };
      // An approved draft (#14) replaces the composed content; without one the body comes from the ticket.
      const approved = (await c.query<{ draft_json: unknown }>(
        "SELECT draft_json FROM issue_drafts WHERE tenant_id = relay_current_tenant() AND ticket_id = $1 AND status = 'approved' ORDER BY created_at DESC LIMIT 1",
        [ticketId],
      )).rows[0];
      const draft = approved ? GithubDraftSchema.safeParse(approved.draft_json) : null;
      return { kind: "ready" as const, ticket, integration, token, draft: draft?.success ? draft.data : null };
    });

    if (state.kind === "no_ticket") throw new PermanentFailureError("ticket not found", "ticket_not_found");
    if (state.kind === "quarantined") return { note: "skipped_quarantined" };
    if (state.kind === "no_integration") {
      await markFailed("integration_unavailable");
      throw new PermanentFailureError("github integration is not active", "integration_unavailable");
    }
    if (state.kind === "no_token") {
      await markFailed("missing_credentials");
      throw new PermanentFailureError("github credentials are missing", "missing_credentials");
    }
    if (state.kind === "already") return { note: "already_created" };

    const { ticket, integration, token } = state;
    const repo = integration.repo_ref!;
    const provider = createProvider(token);

    // (3) crash recovery: GitHub may already hold the issue even though our row still says pending.
    let found: FoundIssue | null;
    try {
      found = await provider.findIssueByTicket(repo, ticketId);
    } catch (err) {
      return fail(err);
    }
    if (found) {
      await tx((c) => recordIssueLinked(c, {
        ticketId, idempotencyKey: input.idempotencyKey, repo, issue: found!, closed: found!.state === "closed",
        eventType: "tracker.issue_created", actorRef: ACTOR_REF, via: "outbox",
      }));
      return { note: "linked_existing" };
    }

    const extractedDetail: ExtractedIssueDetail | undefined = detail && {
      steps_to_reproduce: detail.steps_to_reproduce ?? [],
      expected: detail.expected ?? null,
      actual: detail.actual ?? null,
      missing_info: detail.missing_info ?? [],
    };
    const labelMap = parseLabelMap(integration.label_map_json);
    const { title, body, labels } = state.draft
      ? { title: state.draft.title, body: draftIssueBody(state.draft, ticketId), labels: labelsFor(ticket, labelMap) }
      : composeIssue(ticket, labelMap, extractedDetail);

    let created;
    try {
      // No transaction is open during the network call.
      created = await provider.createIssue(repo, { title, body, labels });
    } catch (err) {
      return fail(err);
    }

    await tx((c) => recordIssueLinked(c, {
      ticketId, idempotencyKey: input.idempotencyKey, repo, issue: created,
      eventType: "tracker.issue_created", actorRef: ACTOR_REF, via: "outbox",
    }));
    return { note: "created" };
  };
}

/** Releases a staged `github.create_issue` row for this ticket so the dispatcher picks it up (#12 approval). */
export async function approveGithubSync(c: Client, tenantId: string, ticketId: string): Promise<boolean> {
  const key = githubIdempotencyKey(tenantId, ticketId, "general");
  const { rows } = await c.query(
    "UPDATE outbox SET status = 'pending', next_attempt_at = now() WHERE kind = 'github.create_issue' AND idempotency_key = $1 AND status = 'staged' RETURNING id",
    [key],
  );
  return (rows?.length ?? 0) > 0;
}

const UpdatePayload = z.object({ ticketId: z.uuid(), draftId: z.uuid() });
const UPDATE_ACTOR_REF = "outbox:github.update_issue";

/**
 * The `github.update_issue` outbox handler (Issue #14): applies an approved draft to the issue that
 * general sync already created, so approving never produces a second issue (§4.10.2). When the issue
 * does not exist yet, the staged `github.create_issue` row is released instead (self-heal: approval
 * won, GitHub lost) — and when there is nothing to update the row finishes with a note, no request.
 */
export function createGithubUpdateIssueHandler(opts: GithubCreateIssueOptions): OutboxHandler {
  const createProvider = opts.createProvider ?? ((token: string) => new GitHubProvider({ token }));

  return async (input) => {
    const parsed = UpdatePayload.safeParse(input.payload);
    if (!parsed.success) throw new PermanentFailureError("payload must contain a ticketId and draftId", "invalid_payload");
    const { ticketId, draftId } = parsed.data;
    const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(opts.pool, input.tenantId, fn);

    const state = await tx(async (c) => {
      const ticket = await loadTicket(c, ticketId);
      if (!ticket) return { kind: "no_ticket" as const };
      if (ticket.status === "quarantined") return { kind: "quarantined" as const };
      const draftRow = (await c.query<{ draft_json: unknown; status: string }>(
        "SELECT draft_json, status FROM issue_drafts WHERE id = $1", [draftId],
      )).rows[0];
      if (!draftRow) return { kind: "no_draft" as const };
      if (draftRow.status !== "approved") return { kind: "skip" as const, note: "skipped_not_approved" };
      const draft = GithubDraftSchema.safeParse(draftRow.draft_json);
      if (!draft.success) return { kind: "fail" as const, code: "invalid_draft_output", message: "stored draft failed schema validation" };
      const integration = (await c.query<{ repo_ref: string | null; credentials_ref: string | null }>(
        "SELECT repo_ref, credentials_ref FROM integrations WHERE provider = 'github' AND status = 'active' LIMIT 1",
      )).rows[0];
      if (!integration?.repo_ref) return { kind: "no_integration" as const };
      const key = githubIdempotencyKey(input.tenantId, ticketId, "general");
      const tracker = (await c.query<{ external_issue_number: number | null }>(
        "SELECT external_issue_number FROM tracker_issues WHERE idempotency_key = $1", [key],
      )).rows[0];
      if (!tracker?.external_issue_number) {
        // The issue is not on GitHub yet: hand the work back to the create row when it was staged.
        const released = await c.query(
          "UPDATE outbox SET status = 'pending', next_attempt_at = now() WHERE kind = 'github.create_issue' AND idempotency_key = $1 AND status = 'staged' RETURNING id",
          [key],
        );
        if ((released.rowCount ?? 0) > 0) return { kind: "release" as const };
        return { kind: "skip" as const, note: "issue_not_created" };
      }
      const token = await resolveToken(opts.secrets, integration.credentials_ref);
      if (!token) return { kind: "no_token" as const };
      return { kind: "ready" as const, repo: integration.repo_ref!, number: tracker.external_issue_number, draft: draft.data, token };
    });

    if (state.kind === "no_ticket") throw new PermanentFailureError("ticket not found", "ticket_not_found");
    if (state.kind === "quarantined") return { note: "skipped_quarantined" };
    if (state.kind === "no_draft") throw new PermanentFailureError("issue draft not found", "draft_not_found");
    if (state.kind === "skip") return { note: state.note };
    if (state.kind === "release") return { note: "released_create" };
    if (state.kind === "no_integration") {
      throw new PermanentFailureError("github integration is not active", "integration_unavailable");
    }
    if (state.kind === "no_token") throw new PermanentFailureError("github credentials are missing", "missing_credentials");
    if (state.kind === "fail") throw new PermanentFailureError(state.message, state.code);

    const { repo, number, draft, token } = state;
    const provider = createProvider(token);
    try {
      // No transaction is open during the network call.
      await provider.updateIssue(repo, number, { title: draft.title, body: draftIssueBody(draft, ticketId) });
    } catch (err) {
      const code = err instanceof TrackerError ? err.code : "unknown";
      if (err instanceof TrackerError && !TRANSIENT.has(err.code)) throw new PermanentFailureError("github request rejected", code);
      throw err;
    }

    await tx((c) => c.query(
      `INSERT INTO ticket_events (tenant_id, ticket_id, type, actor_type, actor_ref, payload, created_at)
       VALUES (relay_current_tenant(), $1, 'tracker.issue_updated', 'system', $2, $3, clock_timestamp())`,
      [ticketId, UPDATE_ACTOR_REF, JSON.stringify({ provider: "github", repo, number, draftId })],
    ));
    return { note: "updated" };
  };
}
