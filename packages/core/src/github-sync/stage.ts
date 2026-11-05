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
import { GitHubProvider, TrackerError, buildIssueBody, labelsFor, parseLabelMap, type TrackerProvider } from "@relay/trackers";
import { ExtractionOutcomeSchema, type SecretProvider } from "@relay/shared";
import type { Client } from "@relay/db";
import type { StageContext, StageHandler } from "../orchestrator/index.js";

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

interface TicketRow {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: string;
  priority_reason: string | null;
  status: string;
  affected_client_count: number;
  tracker_ref: string | null;
  tier: string | null;
}

export type TicketSyncOutcome =
  | { ticketId: string; status: "created"; url: string; number: number }
  | { ticketId: string; status: "failed"; error: string }
  | { ticketId: string; status: "skipped"; reason: string };

const ACTOR = { type: "system", ref: "pipeline:github-sync" } as const;

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

async function resolveToken(secrets: SecretProvider, ref: string | null): Promise<string | undefined> {
  if (!ref) return undefined;
  try {
    return (await secrets.get(ref))?.reveal();
  } catch {
    return undefined; // unsupported scheme or unreadable ref: treated as missing credentials
  }
}

interface SyncInput {
  ticketId: string;
  repo: string;
  labelMap: ReturnType<typeof parseLabelMap>;
  token: string | undefined;
  issue: { steps_to_reproduce: string[]; expected: string | null; actual: string | null; missing_info: string[] } | undefined;
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
  if (before.status === "created") return { ticketId: input.ticketId, status: "skipped", reason: "already_created" };
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

  const body = buildIssueBody({
    ticketId: ticket.id,
    title: ticket.title,
    summary: ticket.summary,
    category: ticket.category,
    priority: ticket.priority,
    priorityReason: ticket.priority_reason,
    clientTier: ticket.tier,
    affectedClientCount: ticket.affected_client_count,
    stepsToReproduce: input.issue?.steps_to_reproduce,
    expected: input.issue?.expected ?? null,
    actual: input.issue?.actual ?? null,
    missingInfo: input.issue?.missing_info,
  });
  const labels = labelsFor(ticket, input.labelMap);

  // No transaction is open during the network call.
  let created;
  try {
    created = await input.createProvider(input.token).createIssue(input.repo, { title: ticket.title, body, labels });
  } catch (err) {
    return fail(err instanceof TrackerError ? err.code : "unknown");
  }

  await ctx.db(async (c) => {
    await c.query(
      `UPDATE tracker_issues SET sync_status = 'created', external_issue_id = $2, external_issue_number = $3,
         external_issue_url = $4, last_synced_at = now(), last_error = NULL
       WHERE idempotency_key = $1`,
      [idempotencyKey, created.id, created.number, created.url],
    );
    await c.query("UPDATE tickets SET tracker_ref = $2 WHERE id = $1", [input.ticketId, created.url]);
    await c.query(
      `INSERT INTO ticket_events (tenant_id, ticket_id, type, actor_type, actor_ref, payload, created_at)
       VALUES (relay_current_tenant(), $1, 'tracker.issue_created', $2, $3, $4, clock_timestamp())`,
      [input.ticketId, ACTOR.type, ACTOR.ref, JSON.stringify({ provider: "github", repo: input.repo, number: created.number, url: created.url })],
    );
  });

  return { ticketId: input.ticketId, status: "created", url: created.url, number: created.number };
}

async function loadTicket(c: Client, ticketId: string): Promise<TicketRow | null> {
  const { rows } = await c.query<TicketRow>(
    `SELECT t.id, t.title, t.summary, t.category, t.priority, t.priority_reason, t.status,
            t.affected_client_count, t.tracker_ref, cl.tier
       FROM tickets t LEFT JOIN clients cl ON cl.id = t.client_id
      WHERE t.id = $1`,
    [ticketId],
  );
  return rows[0] ?? null;
}
