import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { withTenant } from "@relay/db";
import { TrackerError, type ExternalIssue, type NewIssue, type TrackerProvider } from "@relay/trackers";
import { EnvSecretProvider, type ExtractionOutcome, type ExtractionResult } from "@relay/shared";
import { ticketStage, type StageContext } from "../index.js";
import { githubSyncStage } from "./stage.js";
import { createMessage, createTenant, createTestDb, type TestDb, type TestTenant } from "../testing/fixtures.js";

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.dispose(); });

/** Records every createIssue call. `fail` makes the next calls throw the given error. */
function fakeTracker(fail?: TrackerError) {
  const calls: { repo: string; issue: NewIssue }[] = [];
  let nextNumber = 100;
  const provider: TrackerProvider = {
    provider: "github",
    async createIssue(repo, issue): Promise<ExternalIssue> {
      calls.push({ repo, issue });
      if (fail) throw fail;
      const number = nextNumber++;
      return { id: String(number * 10), number, url: `https://github.com/${repo}/issues/${number}` };
    },
    updateIssue: async () => { throw new Error("unused"); },
    addComment: async () => { throw new Error("unused"); },
    linkIssues: async () => { throw new Error("unused"); },
    getStatus: async () => { throw new Error("unused"); },
    onWebhook: () => { throw new Error("unused"); },
  };
  return { provider, calls };
}

const issue = (over: Record<string, unknown> = {}) => ({
  title: "Checkout fails", summary: "Card payments return 500", category: "bug" as const, product_area: "checkout",
  steps_to_reproduce: ["open cart", "pay"], expected: "order placed", actual: "error 500", environment: {},
  severity_signals: ["payment_failure"], missing_info: [], confidence: 0.9, ...over,
});
const extraction = (over: Partial<ExtractionResult> = {}): ExtractionResult => ({
  kind: "extracted", language: "en", is_complaint: true, off_topic: false, issues: [issue()], contains_sensitive_data: false,
  sentiment: "frustrated", confidence: 0.9, missing_info: [], ...over,
});

async function integration(t: TestTenant, over: { repo?: string | null; status?: string; approval?: string; credentials?: string | null } = {}) {
  await db.owner.query("DELETE FROM integrations WHERE tenant_id = $1", [t.tenantId]);
  await db.owner.query(
    `INSERT INTO integrations (tenant_id, provider, credentials_ref, repo_ref, label_map_json, status, approval_policy)
     VALUES ($1, 'github', $2, $3, $4, $5, $6)`,
    [
      t.tenantId,
      over.credentials === undefined ? "env:TEST_GITHUB_TOKEN" : over.credentials,
      over.repo === undefined ? "acme/app" : over.repo,
      JSON.stringify({ category: { bug: "bug" }, priority: { P1: "priority:p1" } }),
      over.status ?? "active",
      over.approval ?? "auto",
    ],
  );
}

/** Runs the real ticket stage for one extraction and returns the ticket ids it created. */
async function createTickets(t: TestTenant, outcome: ExtractionOutcome): Promise<{ messageId: string; ticketIds: string[] }> {
  const messageId = await createMessage(db.owner, t);
  const ctx = stageCtx(t, messageId, { extract: outcome }, "ticket");
  const out = await ticketStage()(ctx);
  return { messageId, ticketIds: (out.result as { ticketIds: string[] }).ticketIds };
}

function stageCtx(t: TestTenant, messageId: string, results: Record<string, unknown>, stage: "ticket" | "github-sync"): StageContext {
  return {
    tenantId: t.tenantId, conversationId: t.conversationId, messageId, traceId: "trace-gh", stage, attempt: 1, results,
    db: (fn) => withTenant(db.worker, t.tenantId, fn),
    signal: new AbortController().signal,
  };
}

const secrets = new EnvSecretProvider({ TEST_GITHUB_TOKEN: "ghp_test_token_value_1234567890" });
const syncWith = (tracker: TrackerProvider) => githubSyncStage({ secrets, createProvider: () => tracker });
const rows = async (sql: string, params: unknown[]) => (await db.owner.query(sql, params)).rows;

describe("github-sync stage", () => {
  it("creates one issue per ticket, links it on the ticket, and writes tracker_issues and an event", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { messageId, ticketIds } = await createTickets(t, extraction());
    const tracker = fakeTracker();

    const out = await syncWith(tracker.provider)(stageCtx(t, messageId, { ticket: { ticketIds } }, "github-sync"));

    assert.equal(tracker.calls.length, 1);
    assert.equal(tracker.calls[0]?.repo, "acme/app");
    assert.match(tracker.calls[0]?.issue.body ?? "", /\*\*Priority:\*\* P1/);
    assert.match(tracker.calls[0]?.issue.body ?? "", /1\. open cart/);
    assert.deepEqual(tracker.calls[0]?.issue.labels, ["bug", "priority:p1"]);
    assert.equal((out.result as { outcome: string }).outcome, "synced");

    const [ticket] = await rows("SELECT tracker_ref FROM tickets WHERE id = $1", [ticketIds[0]]);
    assert.equal(ticket?.tracker_ref, "https://github.com/acme/app/issues/100");
    const [ti] = await rows("SELECT sync_status, external_issue_number, external_issue_url, sync_mode, idempotency_key, last_error FROM tracker_issues WHERE ticket_id = $1", [ticketIds[0]]);
    assert.equal(ti?.sync_status, "created");
    assert.equal(ti?.external_issue_number, 100);
    assert.equal(ti?.sync_mode, "general");
    assert.equal(ti?.idempotency_key, `github:${t.tenantId}:${ticketIds[0]}:general`);
    assert.equal(ti?.last_error, null);
    const events = await rows("SELECT type, actor_type, actor_ref FROM ticket_events WHERE ticket_id = $1 AND type = 'tracker.issue_created'", [ticketIds[0]]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actor_ref, "pipeline:github-sync");
  });

  it("a replay of the same stage never opens a second issue", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { messageId, ticketIds } = await createTickets(t, extraction());
    const tracker = fakeTracker();
    const run = () => syncWith(tracker.provider)(stageCtx(t, messageId, { ticket: { ticketIds } }, "github-sync"));

    await run();
    const second = await run();

    assert.equal(tracker.calls.length, 1);
    const outcomes = (second.result as { tickets: { status: string; reason?: string }[] }).tickets;
    assert.equal(outcomes[0]?.status, "skipped");
    assert.equal(outcomes[0]?.reason, "already_created");
  });

  it("a GitHub 403 marks the row failed with a code, leaves the ticket intact and does not throw", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { messageId, ticketIds } = await createTickets(t, extraction());
    const tracker = fakeTracker(new TrackerError("forbidden", "denied"));

    const out = await syncWith(tracker.provider)(stageCtx(t, messageId, { ticket: { ticketIds } }, "github-sync"));

    const [ticket] = await rows("SELECT status, tracker_ref FROM tickets WHERE id = $1", [ticketIds[0]]);
    assert.equal(ticket?.tracker_ref, null);
    assert.notEqual(ticket?.status, "closed");
    const [ti] = await rows("SELECT sync_status, last_error FROM tracker_issues WHERE ticket_id = $1", [ticketIds[0]]);
    assert.equal(ti?.sync_status, "failed");
    assert.equal(ti?.last_error, "forbidden");
    const tickets = (out.result as { tickets: { status: string; error?: string }[] }).tickets;
    assert.equal(tickets[0]?.status, "failed");
    assert.equal(tickets[0]?.error, "forbidden");
  });

  it("a 5xx from GitHub is recorded as failed (no retry storm inside the stage)", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { messageId, ticketIds } = await createTickets(t, extraction());
    const tracker = fakeTracker(new TrackerError("server", "503"));
    await syncWith(tracker.provider)(stageCtx(t, messageId, { ticket: { ticketIds } }, "github-sync"));
    assert.equal(tracker.calls.length, 1);
    const [ti] = await rows("SELECT sync_status, last_error FROM tracker_issues WHERE ticket_id = $1", [ticketIds[0]]);
    assert.equal(ti?.sync_status, "failed");
    assert.equal(ti?.last_error, "server");
  });

  it("with no active GitHub integration, or no repo selected, nothing is created", async () => {
    const t = await createTenant(db.owner);
    const { messageId, ticketIds } = await createTickets(t, extraction());
    const tracker = fakeTracker();
    const ctx = () => stageCtx(t, messageId, { ticket: { ticketIds } }, "github-sync");

    await integration(t, { status: "revoked" });
    assert.equal(((await syncWith(tracker.provider)(ctx())).result as { outcome: string }).outcome, "not_configured");
    await integration(t, { repo: null });
    assert.equal(((await syncWith(tracker.provider)(ctx())).result as { outcome: string }).outcome, "not_configured");
    assert.equal(tracker.calls.length, 0);
    assert.equal((await rows("SELECT 1 FROM tracker_issues WHERE ticket_id = $1", [ticketIds[0]])).length, 0);
  });

  it("a missing token fails the row with missing_credentials and makes no request", async () => {
    const t = await createTenant(db.owner);
    await integration(t, { credentials: "env:NOT_SET_ANYWHERE" });
    const { messageId, ticketIds } = await createTickets(t, extraction());
    const tracker = fakeTracker();
    await syncWith(tracker.provider)(stageCtx(t, messageId, { ticket: { ticketIds } }, "github-sync"));
    assert.equal(tracker.calls.length, 0);
    const [ti] = await rows("SELECT sync_status, last_error FROM tracker_issues WHERE ticket_id = $1", [ticketIds[0]]);
    assert.equal(ti?.sync_status, "failed");
    assert.equal(ti?.last_error, "missing_credentials");
  });

  it("quarantined tickets are skipped and get no tracker row", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { messageId, ticketIds } = await createTickets(t, extraction({ contains_sensitive_data: true }));
    const tracker = fakeTracker();
    const out = await syncWith(tracker.provider)(stageCtx(t, messageId, { ticket: { ticketIds } }, "github-sync"));
    assert.equal(tracker.calls.length, 0);
    const tickets = (out.result as { tickets: { status: string; reason?: string }[] }).tickets;
    assert.equal(tickets[0]?.reason, "quarantined");
    assert.equal((await rows("SELECT 1 FROM tracker_issues WHERE ticket_id = $1", [ticketIds[0]])).length, 0);
  });

  it("approval_policy = human stages nothing automatically", async () => {
    const t = await createTenant(db.owner);
    await integration(t, { approval: "human" });
    const { messageId, ticketIds } = await createTickets(t, extraction());
    const tracker = fakeTracker();
    const out = await syncWith(tracker.provider)(stageCtx(t, messageId, { ticket: { ticketIds } }, "github-sync"));
    assert.equal((out.result as { outcome: string }).outcome, "awaiting_approval");
    assert.equal(tracker.calls.length, 0);
  });

  it("creates an issue for each ticket of a multi-issue message, using that issue's steps", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { messageId, ticketIds } = await createTickets(t, extraction({
      issues: [issue({ title: "First bug" }), issue({ title: "Second bug", steps_to_reproduce: ["login"] })],
    }));
    const tracker = fakeTracker();
    await syncWith(tracker.provider)(stageCtx(t, messageId, { ticket: { ticketIds }, extract: extraction({
      issues: [issue({ title: "First bug" }), issue({ title: "Second bug", steps_to_reproduce: ["login"] })],
    }) }, "github-sync"));
    assert.deepEqual(tracker.calls.map((c) => c.issue.title), ["First bug", "Second bug"]);
    assert.match(tracker.calls[1]?.issue.body ?? "", /1\. login/);
  });
});
