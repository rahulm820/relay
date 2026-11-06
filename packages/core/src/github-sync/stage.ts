// The `github-sync` pipeline stage (Issue #9, architecture §4.10.1). Creates one GitHub issue per new
// ticket when the tenant has an active GitHub integration with a repo selected.
//
// This version calls GitHub directly from the pipeline. Issue #12 moves the call onto the outbox.
// Until then the `github.create_issue` outbox row written by the ticket stage stays a no-op, so the
// issue is created exactly once, by this stage.
//
// Guarantees:
//  - Idempotent: a tracker_issues row is claimed per ticket with idempotency key
//    `github:{tenant}:{ticket}:general` (UNIQUE). A ticket already in `created` is skipped.
//  - A GitHub failure never fails the pipeline or touches the ticket: the row becomes `failed` with a
//    stable error code, and the stage returns normally.
//  - No database transaction is open while the HTTP call runs.
import { z } from "zod";
import { GitHubProvider, TrackerError, parseLabelMap, type TrackerProvider } from "@relay/trackers";
import { ExtractionOutcomeSchema, type SecretProvider } from "@relay/shared";
import type { StageContext, StageHandler } from "../orchestrator/index.js";
import { composeIssue, loadTicket, recordIssueLinked, resolveToken, type ExtractedIssueDetail } from "./issue.js";

export interface GithubSyncOptions {
  /** Resolves integrations.credentials_ref (e.g. env:GITHUB_TOKEN) to the token. */
  secrets: SecretProvider;
  /** Builds the provider for a token. Defaults to GitHubProvider. Injected in tests. */
  createProvider?: (token: string) => TrackerProvider;
}

const TicketStageResult = z.object({ ticketIds: z.array(z.uuid()) });

interface IntegrationRow {
  repo_ref: string | null;
  credentials_ref: string | null;
  label_map_json: unknown;
  approval_policy: "auto" | "human";
}

export type TicketSyncOutcome =
  | { ticketId: string; status: "created"; url: string; number: number }
  | { ticketId: string; status: "failed"; error: string }
  | { ticketId: string; status: "skipped"; reason: string };

const ACTOR_REF = "pipeline:github-sync";

export function githubSyncStage(opts: GithubSyncOptions): StageHandler {
  const createProvider = opts.createProvider ?? ((token: string) => new GitHubProvider({ token }));

  return async (ctx) => {
    const parsed = TicketStageResult.safeParse(ctx.results["ticket"]);
    const ticketIds = parsed.success ? parsed.data.ticketIds : [];
    if (ticketIds.length === 0) return { result: { outcome: "no_tickets", tickets: [] } };

    const integration = await ctx.db(async (c) => {
      const { rows } = await c.query<IntegrationRow>(
        "SELECT repo_ref, credentials_ref, label_map_json, approval_policy FROM integrations WHERE provider = 'github' AND status = 'active' LIMIT 1",
      );
      return rows[0] ?? null;
    });
    if (!integration || !integration.repo_ref) return { result: { outcome: "not_configured", tickets: [] } };
    if (integration.approval_policy === "human") return { result: { outcome: "awaiting_approval", tickets: [] } };

    const repo = integration.repo_ref;
    const labelMap = parseLabelMap(integration.label_map_json);
    const extraction = ExtractionOutcomeSchema.safeParse(ctx.results["extract"]);
    // Ticket i was created from issue i. Only trust that mapping when the counts agree.
    const issues = extraction.success && extraction.data.kind === "extracted" && extraction.data.issues.length === ticketIds.length
      ? extraction.data.issues
      : undefined;

    const token = await resolveToken(opts.secrets, integration.credentials_ref);
    const outcomes: TicketSyncOutcome[] = [];

    for (const [index, ticketId] of ticketIds.entries()) {
      outcomes.push(await syncOne(ctx, {
        ticketId, repo, labelMap, token,
        issue: issues?.[index],
        createProvider,
      }));
    }

    return { result: { outcome: "synced", repo, tickets: outcomes } };
  };
}

interface SyncInput {
  ticketId: string;
  repo: string;
  labelMap: ReturnType<typeof parseLabelMap>;
  token: string | undefined;
  issue: ExtractedIssueDetail | undefined;
  createProvider: (token: string) => TrackerProvider;
}

async function syncOne(ctx: StageContext, input: SyncInput): Promise<TicketSyncOutcome> {
  const idempotencyKey = `github:${ctx.tenantId}:${input.ticketId}:general`;

  // Checks first, so skipped tickets never get a tracker_issues row.
  const before = await ctx.db(async (c) => ({
    ticket: await loadTicket(c, input.ticketId),
    status: (await c.query<{ sync_status: string }>("SELECT sync_status FROM tracker_issues WHERE idempotency_key = $1", [idempotencyKey])).rows[0]?.sync_status,
  }));
  if (!before.ticket) return { ticketId: input.ticketId, status: "skipped", reason: "ticket_not_found" };
  // `closed` means the issue exists on GitHub and was closed there (set by reconcile or the webhook); never open another.
  if (before.status === "created" || before.status === "closed") return { ticketId: input.ticketId, status: "skipped", reason: "already_created" };
  if (before.ticket.status === "quarantined") return { ticketId: input.ticketId, status: "skipped", reason: "quarantined" };

  // Claim the row. ON CONFLICT keeps the existing row, so a concurrent run cannot create a second one.
  await ctx.db((c) => c.query(
    `INSERT INTO tracker_issues (tenant_id, ticket_id, provider, repo_ref, sync_mode, sync_status, idempotency_key)
     VALUES (relay_current_tenant(), $1, 'github', $2, 'general', 'pending', $3)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [input.ticketId, input.repo, idempotencyKey],
  ));

  const ticket = before.ticket;
  const fail = async (code: string): Promise<TicketSyncOutcome> => {
    await ctx.db((c) => c.query("UPDATE tracker_issues SET sync_status = 'failed', last_error = $2, last_synced_at = now() WHERE idempotency_key = $1", [idempotencyKey, code]));
    return { ticketId: input.ticketId, status: "failed", error: code };
  };

  if (!input.token) return fail("missing_credentials");

  const { title, body, labels } = composeIssue(ticket, input.labelMap, input.issue);

  // No transaction is open during the network call.
  let created;
  try {
    created = await input.createProvider(input.token).createIssue(input.repo, { title, body, labels });
  } catch (err) {
    return fail(err instanceof TrackerError ? err.code : "unknown");
  }

  await ctx.db((c) => recordIssueLinked(c, {
    ticketId: input.ticketId, idempotencyKey, repo: input.repo, issue: created, eventType: "tracker.issue_created", actorRef: ACTOR_REF,
  }));

  return { ticketId: input.ticketId, status: "created", url: created.url, number: created.number };
}
