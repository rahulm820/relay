// Integration: the real github-sync stage and the real reconcile job, against real Postgres and the real GitHubProvider
// talking HTTP to the mock GitHub. In process (not black box) so the clock can be moved: "time travel" rewrites the
// timestamps a wait would have advanced, so nothing here sleeps.
//
// The question every scenario answers: after GitHub misbehaves, does the ticket end up with exactly ONE issue?
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { createPgReconcileStore, githubSyncStage, reconcileOnce, type StageContext } from "@relay/core";
import { createTenant, createTestDb, type TestDb, type TestTenant } from "@relay/core/testing";
import { withTenant } from "@relay/db";
import { EnvSecretProvider } from "@relay/shared";
import { GitHubProvider } from "@relay/trackers";
import { MockGitHub } from "@relay/trackers/testing";

const REPO = "acme/storefront";
let db: TestDb;
let gh: MockGitHub;

before(async () => { db = await createTestDb(); gh = new MockGitHub(); await gh.start(); });
after(async () => { await gh.stop(); await db.dispose(); });
beforeEach(() => gh.reset());

const secrets = new EnvSecretProvider({ GH: "fake-token" });
const provider = () => new GitHubProvider({ token: "fake-token", baseUrl: gh.url, timeoutMs: 3000 });
// The configuration the worker runs with by default (see reconcileSettingsFromEnv).
const store = () => createPgReconcileStore({ pool: db.worker, graceSeconds: 300, staleSeconds: 3600, retryBudget: 8 });
const reconcile = () => reconcileOnce({ store: store(), secrets, createProvider: provider, random: () => 0.5, log: () => undefined });

async function newTicket(): Promise<{ t: TestTenant; ticketId: string }> {
  const t = await createTenant(db.owner);
  await db.owner.query(
    `INSERT INTO integrations (tenant_id, provider, credentials_ref, repo_ref, label_map_json, status, approval_policy)
     VALUES ($1,'github','env:GH',$2,'{"category":{"bug":"bug"}}','active','auto')`, [t.tenantId, REPO]);
  const ticketId = randomUUID();
  await db.owner.query(
    "INSERT INTO tickets (id, tenant_id, conversation_id, title, summary, category, priority, status) VALUES ($1,$2,$3,'Checkout fails','Card payments return 500','bug','P1','triaged')",
    [ticketId, t.tenantId, t.conversationId]);
  return { t, ticketId };
}

/** The pipeline's github-sync stage, as the worker would run it for this ticket. */
async function runStage(t: TestTenant, ticketId: string): Promise<void> {
  const ctx: StageContext = {
    tenantId: t.tenantId, conversationId: t.conversationId, messageId: randomUUID(), traceId: "int", stage: "github-sync", attempt: 1,
    results: { ticket: { ticketIds: [ticketId] } }, db: (fn) => withTenant(db.worker, t.tenantId, fn), signal: new AbortController().signal,
  };
  await githubSyncStage({ secrets, createProvider: provider })(ctx);
}

const row = async (ticketId: string) =>
  (await db.owner.query("SELECT sync_status, sync_attempts, last_error, external_issue_number, next_attempt_at, extract(epoch FROM (next_attempt_at - now()))::float8 AS wait FROM tracker_issues WHERE ticket_id = $1", [ticketId])).rows[0];
const eventsOf = async (ticketId: string, like = "tracker.%") =>
  (await db.owner.query("SELECT type, actor_ref FROM ticket_events WHERE ticket_id = $1 AND type LIKE $2 ORDER BY created_at", [ticketId, like])).rows;
const candidateIds = async () => (await store().candidates(500)).map((c) => c.id);
const syncId = async (ticketId: string) => (await db.owner.query("SELECT id FROM tracker_issues WHERE ticket_id = $1", [ticketId])).rows[0].id as string;
/** Moves a row's clock back so a wait that would take minutes or hours has already elapsed. */
const timeTravel = (ticketId: string, o: { lastSyncedAgo?: string; clearBackoff?: boolean } = {}) =>
  db.owner.query(
    "UPDATE tracker_issues SET last_synced_at = now() - $2::interval, next_attempt_at = CASE WHEN $3 THEN NULL ELSE next_attempt_at END WHERE ticket_id = $1",
    [ticketId, o.lastSyncedAgo ?? "1 hour", o.clearBackoff ?? true]);
const issuesFor = (ticketId: string) => gh.issues.filter((i) => i.body.includes(ticketId));

describe("GitHub is down when the ticket is created", () => {
  it("the stage records the failure; once GitHub is back, reconcile creates exactly one issue and then leaves it alone", async () => {
    const { t, ticketId } = await newTicket();
    gh.fail("create", { status: 503 });
    await runStage(t, ticketId);
    assert.deepEqual([(await row(ticketId)).sync_status, (await row(ticketId)).last_error], ["failed", "server"]);
    assert.equal(gh.issues.length, 0);

    assert.ok(!(await candidateIds()).includes(await syncId(ticketId)), "inside the grace period: the pipeline may still be working on it");
    await timeTravel(ticketId); // five minutes of grace have passed

    const first = await reconcile();
    assert.equal(first.created, 1);
    assert.equal(issuesFor(ticketId).length, 1, "exactly one issue");
    const r = await row(ticketId);
    assert.deepEqual([r.sync_status, r.external_issue_number, r.sync_attempts, r.last_error, r.next_attempt_at], ["created", 1, 0, null, null]);
    assert.equal((await db.owner.query("SELECT tracker_ref FROM tickets WHERE id = $1", [ticketId])).rows[0].tracker_ref, `https://github.com/${REPO}/issues/1`);
    const events = await eventsOf(ticketId);
    assert.deepEqual(events.map((e) => [e.type, e.actor_ref]), [["tracker.issue_created", "job:github-reconcile"]]);

    const second = await reconcile();
    assert.equal(second.examined, 0, "a healthy created row is not touched until it goes stale");
    assert.equal(gh.createRequests.length, 2, "the stage's attempt (refused with a 503) and reconcile's: two requests, one issue");
    assert.equal(gh.issues.length, 1);
  });
});

describe("GitHub accepted the create but the answer never arrived", () => {
  it("is not retried while GitHub's search cannot see the issue yet, and is repaired (not duplicated) once it can", async () => {
    const { t, ticketId } = await newTicket();
    gh.hideNewFromSearch = true; // the index lags behind the issue just created
    gh.fail("create", { acceptThenDrop: true });
    await runStage(t, ticketId);
    assert.equal((await row(ticketId)).last_error, "network", "the stage saw only a dropped connection");
    assert.equal(gh.issues.length, 1, "...but GitHub did create the issue");

    // Reconcile running right away must not look: a search now would find nothing and create a second issue.
    assert.ok(!(await candidateIds()).includes(await syncId(ticketId)));
    assert.equal((await reconcile()).examined, 0);
    assert.equal(gh.issues.length, 1, "no duplicate while the index lags");

    gh.revealSearch(); // the index catches up
    await timeTravel(ticketId); // and the grace period is over
    const s = await reconcile();
    assert.equal(s.repaired, 1, "found by search and linked");
    assert.equal(s.created, 0);
    assert.equal(gh.createRequests.length, 1, "GitHub was only ever asked to create once");
    assert.equal(issuesFor(ticketId).length, 1);
    const r = await row(ticketId);
    assert.deepEqual([r.sync_status, r.external_issue_number], ["created", 1]);
    assert.deepEqual((await eventsOf(ticketId)).map((e) => e.type), ["tracker.issue_repaired"]);
  });

  it("the same drop during reconcile's own create makes the row wait at least five minutes before it looks again", async () => {
    const { t, ticketId } = await newTicket();
    gh.fail("create", { status: 503 });
    await runStage(t, ticketId);
    await timeTravel(ticketId);
    gh.hideNewFromSearch = true;
    gh.fail("create", { acceptThenDrop: true });

    const s = await reconcile();
    assert.equal(s.failed, 1);
    const r = await row(ticketId);
    assert.deepEqual([r.sync_status, r.last_error, r.sync_attempts], ["failed", "network", 1]);
    assert.ok(r.wait >= 290, `waits ${r.wait}s: long enough for the search index to catch up`);
    assert.equal(gh.issues.length, 1);

    gh.revealSearch();
    await timeTravel(ticketId); // the wait is over
    assert.equal((await reconcile()).repaired, 1);
    assert.equal(issuesFor(ticketId).length, 1);
    assert.equal(gh.createRequests.length, 2, "the stage's attempt and reconcile's, never a third");
  });
});

describe("GitHub rate limits us", () => {
  it("stops the pass, waits at least as long as GitHub asked, and leaves the other rows untouched", async () => {
    const a = await newTicket();
    const b = await newTicket();
    for (const x of [a, b]) { gh.fail("create", { status: 503 }); await runStage(x.t, x.ticketId); await timeTravel(x.ticketId); }
    gh.fail("search", { status: 403, headers: { "retry-after": "900", "x-ratelimit-remaining": "0" } });

    const s = await reconcile();

    assert.equal(s.rateLimited, 1);
    assert.equal(s.examined, 1, "the second row was never sent to a rate-limited API");
    assert.equal(gh.requests.filter((r) => r.path === "/search/issues").length, 1);
    const rows = [await row(a.ticketId), await row(b.ticketId)];
    const limited = rows.find((r) => r.last_error === "rate_limited")!;
    assert.ok(limited.wait >= 890, `waits ${limited.wait}s, at least GitHub's 900s`);
    assert.equal(limited.sync_attempts, 1, "the row that was tried counts one reconcile attempt");
    assert.equal(rows.find((r) => r !== limited)!.sync_attempts, 0, "the untouched row burnt no reconcile attempt (the stage's own failure is not counted)");
  });
});

describe("the issue changes on GitHub after it was created", () => {
  it("a closed issue is noticed; a deleted one is recreated exactly once", async () => {
    const closed = await newTicket();
    const deleted = await newTicket();
    for (const x of [closed, deleted]) await runStage(x.t, x.ticketId);
    assert.equal(gh.issues.length, 2);
    for (const x of [closed, deleted]) await timeTravel(x.ticketId, { lastSyncedAgo: "2 hours" }); // stale: due for a re-check

    gh.issues.find((i) => i.body.includes(closed.ticketId))!.state = "closed";
    gh.issues.splice(gh.issues.findIndex((i) => i.body.includes(deleted.ticketId)), 1);

    const first = await reconcile();
    assert.equal(first.closed, 1);
    assert.equal((await row(closed.ticketId)).sync_status, "closed");
    assert.deepEqual([(await row(deleted.ticketId)).sync_status, (await row(deleted.ticketId)).last_error], ["failed", "issue_missing"]);

    await timeTravel(deleted.ticketId); // the recreate is due
    const second = await reconcile();
    assert.equal(second.created, 1);
    assert.equal(issuesFor(deleted.ticketId).length, 1, "exactly one replacement");
    assert.equal(issuesFor(closed.ticketId).length, 1, "the closed issue was not recreated");
    assert.equal((await row(deleted.ticketId)).sync_status, "created");
  });

  it("a replay of the pipeline stage never opens a second issue once one exists, whether open or closed", async () => {
    const { t, ticketId } = await newTicket();
    await runStage(t, ticketId);
    await runStage(t, ticketId);
    assert.equal(gh.createRequests.length, 1);
    await db.owner.query("UPDATE tracker_issues SET sync_status = 'closed' WHERE ticket_id = $1", [ticketId]);
    await runStage(t, ticketId);
    assert.equal(gh.createRequests.length, 1);
  });
});
