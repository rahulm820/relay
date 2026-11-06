import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { withTenant } from "@relay/db";
import { TrackerError, type ExternalIssue, type FoundIssue, type NewIssue, type TrackerProvider } from "@relay/trackers";
import { EnvSecretProvider, githubIdempotencyKey, type ExtractionOutcome, type ExtractionResult } from "@relay/shared";
import {
  OutboxDispatcher, approveGithubSync, createDefaultOutboxRegistry, createGithubCreateIssueHandler,
  ticketStage, transitionTicket, type StageContext,
} from "../index.js";
import { githubSyncStage } from "./stage.js";
import { createMessage, createTenant, createTestDb, type TestDb, type TestTenant } from "../testing/fixtures.js";

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.dispose(); });

/** Records every createIssue call (including failed attempts). `failWith` makes calls throw; `foundAs` answers findIssueByTicket. */
function fakeTracker() {
  const calls: { repo: string; issue: NewIssue }[] = [];
  let nextNumber = 100;
  let fail: TrackerError | null = null;
  let found: FoundIssue | null = null;
  let finds = 0;
  const provider: TrackerProvider = {
    provider: "github",
    async createIssue(repo, issue): Promise<ExternalIssue> {
      calls.push({ repo, issue });
      if (fail) throw fail;
      const number = nextNumber++;
      return { id: String(number * 10), number, url: `https://github.com/${repo}/issues/${number}` };
    },
    findIssueByTicket: async () => { finds++; return found; },
    updateIssue: async () => { throw new Error("unused"); },
    addComment: async () => { throw new Error("unused"); },
    linkIssues: async () => { throw new Error("unused"); },
    getStatus: async () => { throw new Error("unused"); },
    onWebhook: () => { throw new Error("unused") },
  };
  return {
    provider, calls,
    get finds() { return finds; },
    failWith: (e: TrackerError | null) => { fail = e; },
    foundAs: (f: FoundIssue | null) => { found = f; },
  };
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
  const out = await ticketStage()(stageCtx(t, messageId, { extract: outcome }, "ticket"));
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
const rows = async (sql: string, params: unknown[]) => (await db.owner.query(sql, params)).rows;
const outboxRow = async (key: string) => (await rows("SELECT status, last_error FROM outbox WHERE idempotency_key = $1", [key]))[0];
const trackerRow = async (ticketId: string) =>
  (await rows("SELECT sync_status, repo_ref, external_issue_number, external_issue_url, sync_mode, idempotency_key, last_error FROM tracker_issues WHERE ticket_id = $1", [ticketId]))[0];

/** A dispatcher whose github.create_issue rows go to the real handler; everything else stays a no-op. */
function dispatcherWith(provider: TrackerProvider) {
  return new OutboxDispatcher({
    pool: db.worker,
    registry: createDefaultOutboxRegistry(() => {}).register(
      "github.create_issue",
      createGithubCreateIssueHandler({ pool: db.worker, secrets, createProvider: () => provider }),
    ),
    // Retry immediately: a test's second pass must see the row the first pass put back to pending.
    backoffBaseMs: 1, backoffMaxMs: 1,
    log: () => {},
  });
}
const handlerWith = (provider: TrackerProvider) =>
  createGithubCreateIssueHandler({ pool: db.worker, secrets, createProvider: () => provider });
const keyOf = (t: TestTenant, ticketId: string) => githubIdempotencyKey(t.tenantId, ticketId, "general");
const handlerInput = (t: TestTenant, ticketId: string, payload: Record<string, unknown>) => ({
  outboxId: "00000000-0000-4000-8000-000000000099", tenantId: t.tenantId, kind: "github.create_issue" as const,
  idempotencyKey: keyOf(t, ticketId), payload, attempt: 1, traceId: "trace-gh",
});

describe("github.create_issue outbox handler", () => {
  it("ticket creation writes the link and the job together; the handler then creates exactly one issue", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());

    // Same transaction as the ticket: pending link row and pending outbox row, keyed alike.
    const ti = await trackerRow(ticketId!);
    assert.equal(ti.sync_status, "pending");
    assert.equal(ti.repo_ref, "acme/app");
    assert.equal(ti.idempotency_key, keyOf(t, ticketId!));
    const ob = await outboxRow(keyOf(t, ticketId!));
    assert.equal(ob.status, "pending");

    const tracker = fakeTracker();
    await dispatcherWith(tracker.provider).runOnce();

    assert.equal(tracker.calls.length, 1);
    assert.equal(tracker.calls[0]?.repo, "acme/app");
    assert.match(tracker.calls[0]?.issue.body ?? "", /\*\*Priority:\*\* P1/);
    assert.match(tracker.calls[0]?.issue.body ?? "", /1\. open cart/);
    assert.match(tracker.calls[0]?.issue.body ?? "", /### Expected\norder placed/);
    assert.deepEqual(tracker.calls[0]?.issue.labels, ["bug", "priority:p1"]);

    const after1 = await trackerRow(ticketId!);
    assert.equal(after1.sync_status, "created");
    assert.equal(after1.external_issue_number, 100);
    assert.equal(after1.external_issue_url, "https://github.com/acme/app/issues/100");
    assert.equal(after1.last_error, null);
    const [ticket] = await rows("SELECT tracker_ref FROM tickets WHERE id = $1", [ticketId]);
    assert.equal(ticket.tracker_ref, "https://github.com/acme/app/issues/100");
    const events = await rows("SELECT actor_ref, payload FROM ticket_events WHERE ticket_id = $1 AND type = 'tracker.issue_created'", [ticketId]);
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_ref, "outbox:github.create_issue");
    assert.equal((await outboxRow(keyOf(t, ticketId!))).status, "done");
    assert.equal((await outboxRow(keyOf(t, ticketId!))).last_error, "created");

    // A second delivery of the same job never creates again.
    await handlerWith(tracker.provider)(handlerInput(t, ticketId!, { ticketId }));
    assert.equal(tracker.calls.length, 1);
  });

  it("links an issue GitHub already has (crash recovery) instead of creating a second one", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    const tracker = fakeTracker();
    tracker.foundAs({ id: "900", number: 7, url: "https://github.com/acme/app/issues/7", state: "open" });

    const note = await handlerWith(tracker.provider)(handlerInput(t, ticketId!, { ticketId }));

    assert.deepEqual(note, { note: "linked_existing" });
    assert.equal(tracker.calls.length, 0, "createIssue is never called when the issue exists");
    const ti = await trackerRow(ticketId!);
    assert.equal(ti.sync_status, "created");
    assert.equal(ti.external_issue_number, 7);
    // Finish the row the way the dispatcher would, so it cannot leak into a later test.
    await db.owner.query("UPDATE outbox SET status = 'done' WHERE idempotency_key = $1", [keyOf(t, ticketId!)]);
  });

  it("a GitHub 403 fails the outbox row and marks the link failed without touching the ticket", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    const tracker = fakeTracker();
    tracker.failWith(new TrackerError("forbidden", "denied"));

    await dispatcherWith(tracker.provider).runOnce();

    const ob = await outboxRow(keyOf(t, ticketId!));
    assert.equal(ob.status, "failed");
    const ti = await trackerRow(ticketId!);
    assert.equal(ti.sync_status, "failed");
    assert.equal(ti.last_error, "forbidden");
    const [ticket] = await rows("SELECT status, tracker_ref FROM tickets WHERE id = $1", [ticketId]);
    assert.equal(ticket.tracker_ref, null);
    assert.notEqual(ticket.status, "closed");
  });

  it("a 5xx retries through the outbox and ends created once GitHub recovers", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    const tracker = fakeTracker();
    tracker.failWith(new TrackerError("server", "503"));

    await dispatcherWith(tracker.provider).runOnce();
    assert.equal((await outboxRow(keyOf(t, ticketId!))).status, "pending", "a transient failure retries");
    assert.equal((await trackerRow(ticketId!)).sync_status, "failed");

    tracker.failWith(null);
    await dispatcherWith(tracker.provider).runOnce();

    assert.equal(tracker.calls.length, 2, "one failed attempt and one success");
    assert.equal((await trackerRow(ticketId!)).sync_status, "created");
    assert.equal((await outboxRow(keyOf(t, ticketId!))).status, "done");
  });

  it("missing credentials fail the row with missing_credentials and make no request", async () => {
    const t = await createTenant(db.owner);
    await integration(t, { credentials: "env:NOT_SET_ANYWHERE" });
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    const tracker = fakeTracker();

    await dispatcherWith(tracker.provider).runOnce();

    assert.equal(tracker.calls.length, 0);
    assert.equal(tracker.finds, 0);
    const ti = await trackerRow(ticketId!);
    assert.equal(ti.sync_status, "failed");
    assert.equal(ti.last_error, "missing_credentials");
    assert.equal((await outboxRow(keyOf(t, ticketId!))).status, "failed");
  });

  it("with GitHub disconnected the ticket is created normally and no link or job is written", async () => {
    const t = await createTenant(db.owner);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    assert.equal(await trackerRow(ticketId!), undefined);
    assert.equal(await outboxRow(keyOf(t, ticketId!)), undefined);
    const kinds = (await rows("SELECT kind FROM outbox WHERE payload->>'ticketId' = $1", [ticketId])).map((r) => r.kind);
    assert.deepEqual(kinds, ["switch.create_room"]);
  });

  it("approval_policy = human stages the row; approval releases it and only then is the issue created", async () => {
    const t = await createTenant(db.owner);
    await integration(t, { approval: "human" });
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    const tracker = fakeTracker();

    // Staged rows are never due: the dispatcher leaves them alone.
    await dispatcherWith(tracker.provider).runOnce();
    assert.equal(tracker.calls.length, 0);
    assert.equal((await outboxRow(keyOf(t, ticketId!))).status, "staged");
    assert.equal((await trackerRow(ticketId!)).sync_status, "pending");

    const state = await githubSyncStage()(stageCtx(t, "00000000-0000-4000-8000-000000000001", { ticket: { ticketIds: [ticketId!] } }, "github-sync"));
    assert.deepEqual((state.result as { tickets: { state: string }[] }).tickets[0], { ticketId: ticketId!, state: "awaiting_approval" });

    let approved = false;
    await withTenant(db.worker, t.tenantId, async (c) => { approved = await approveGithubSync(c, t.tenantId, ticketId!); });
    assert.equal(approved, true);
    assert.equal((await outboxRow(keyOf(t, ticketId!))).status, "pending");

    await dispatcherWith(tracker.provider).runOnce();
    assert.equal(tracker.calls.length, 1);
    assert.equal((await trackerRow(ticketId!)).sync_status, "created");

    // Approving again finds nothing staged.
    await withTenant(db.worker, t.tenantId, async (c) => { approved = await approveGithubSync(c, t.tenantId, ticketId!); });
    assert.equal(approved, false);
  });

  it("a quarantined ticket is skipped: no issue, link left pending", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    await db.owner.query("UPDATE tickets SET status = 'quarantined' WHERE id = $1", [ticketId]);
    const tracker = fakeTracker();

    await dispatcherWith(tracker.provider).runOnce();

    assert.equal(tracker.calls.length, 0);
    assert.equal((await trackerRow(ticketId!)).sync_status, "pending");
    assert.equal((await outboxRow(keyOf(t, ticketId!))).status, "done");
    assert.equal((await outboxRow(keyOf(t, ticketId!))).last_error, "skipped_quarantined");
  });

  it("a ticket released from quarantine gets its rows then, and syncs once", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction({ contains_sensitive_data: true }));
    assert.equal(await trackerRow(ticketId!), undefined, "a sensitive ticket writes nothing until released");

    await withTenant(db.worker, t.tenantId, (c) => transitionTicket(c, {
      ticketId: ticketId!, to: "triaged", actor: { type: "human", ref: "test" }, reason: "reviewed",
    }));
    assert.equal((await trackerRow(ticketId!)).sync_status, "pending");

    const tracker = fakeTracker();
    await dispatcherWith(tracker.provider).runOnce();
    assert.equal(tracker.calls.length, 1);
    assert.equal((await trackerRow(ticketId!)).sync_status, "created");
  });

  it("creates an issue for each ticket of a multi-issue message, using that issue's steps", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const outcome = extraction({
      issues: [issue({ title: "First bug" }), issue({ title: "Second bug", steps_to_reproduce: ["login"] })],
    });
    const { ticketIds } = await createTickets(t, outcome);
    const tracker = fakeTracker();

    await dispatcherWith(tracker.provider).runOnce();

    assert.equal(tracker.calls.length, 2);
    assert.deepEqual(tracker.calls.map((c) => c.issue.title), ["First bug", "Second bug"]);
    assert.match(tracker.calls[1]?.issue.body ?? "", /1\. login/);
    assert.equal((await rows("SELECT count(*)::int AS n FROM tracker_issues WHERE tenant_id = $1 AND sync_status = 'created'", [t.tenantId]))[0].n, 2);
  });
});

describe("github-sync stage reports sync state", () => {
  it("maps every situation to a state and never writes", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const report = async (ticketIds: string[], messageId = "00000000-0000-4000-8000-000000000002") => {
      const out = await githubSyncStage()(stageCtx(t, messageId, { ticket: { ticketIds } }, "github-sync"));
      return (out.result as { tickets: { state: string }[] }).tickets.map((x) => x.state);
    };

    const empty = await githubSyncStage()(stageCtx(t, "00000000-0000-4000-8000-000000000003", { ticket: { ticketIds: [] } }, "github-sync"));
    assert.equal((empty.result as { outcome: string }).outcome, "no_tickets");

    // Queued: link and job written, issue not created yet.
    const { ticketIds: [queued] } = await createTickets(t, extraction());
    assert.deepEqual(await report([queued!]), ["queued"]);

    // Created: the handler ran.
    const tracker = fakeTracker();
    await dispatcherWith(tracker.provider).runOnce();
    assert.deepEqual(await report([queued!]), ["created"]);

    // Not configured: a tenant with no integration writes nothing.
    const bare = await createTenant(db.owner);
    const bareTickets = await createTickets(bare, extraction());
    const bareOut = await githubSyncStage()(
      stageCtx(bare, bareTickets.messageId, { ticket: { ticketIds: bareTickets.ticketIds } }, "github-sync"));
    assert.deepEqual((bareOut.result as { tickets: { state: string }[] }).tickets.map((x) => x.state), ["not_configured"]);

    // Quarantined with no rows.
    const { ticketIds: [held] } = await createTickets(t, extraction({ contains_sensitive_data: true }));
    assert.deepEqual(await report([held!]), ["quarantined"]);

    // Failed: the last attempt did not reach GitHub.
    const { ticketIds: [failed] } = await createTickets(t, extraction({ issues: [issue({ title: "Second checkout bug" })] }));
    const failing = fakeTracker();
    failing.failWith(new TrackerError("forbidden", "denied"));
    await dispatcherWith(failing.provider).runOnce();
    assert.deepEqual(await report([failed!]), ["failed"]);
  });
});
