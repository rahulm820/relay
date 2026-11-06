// Integration: the real `github.create_issue` outbox handler (#12), the real dispatcher, and the real reconcile job
// (#20), against real Postgres and the real GitHubProvider talking HTTP to the mock GitHub. In process (not black box)
// so the clock can be moved: "time travel" rewrites the timestamps a wait would have advanced, so nothing sleeps.
//
// The question every scenario answers: after GitHub misbehaves, does the ticket end up with exactly ONE issue?
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  OutboxDispatcher, createDefaultOutboxRegistry, createGithubCreateIssueHandler, createPgReconcileStore, enqueueTicketOutbox, reconcileOnce,
} from "@relay/core";
import { createTenant, createTestDb, waitFor, type TestDb, type TestTenant } from "@relay/core/testing";
import { withTenant } from "@relay/db";
import { EnvSecretProvider, githubIdempotencyKey } from "@relay/shared";
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
const handler = () => createGithubCreateIssueHandler({ pool: db.worker, secrets, createProvider: provider });
// The configuration the worker runs with by default (see reconcileSettingsFromEnv).
const store = () => createPgReconcileStore({ pool: db.worker, graceSeconds: 300, staleSeconds: 3600, retryBudget: 8 });
const reconcile = () => reconcileOnce({ store: store(), secrets, createProvider: provider, random: () => 0.5, log: () => undefined });

/** A triaged ticket whose ticket stage has run: the GitHub link row is pending and a `github.create_issue` job is queued. */
async function newTicket(): Promise<{ t: TestTenant; ticketId: string }> {
  const t = await createTenant(db.owner);
  await db.owner.query(
    `INSERT INTO integrations (tenant_id, provider, credentials_ref, repo_ref, label_map_json, status, approval_policy)
     VALUES ($1,'github','env:GH',$2,'{"category":{"bug":"bug"}}','active','auto')`, [t.tenantId, REPO]);
  const ticketId = randomUUID();
  await db.owner.query(
    "INSERT INTO tickets (id, tenant_id, conversation_id, title, summary, category, priority, status) VALUES ($1,$2,$3,'Checkout fails','Card payments return 500','bug','P1','triaged')",
    [ticketId, t.tenantId, t.conversationId]);
  await withTenant(db.worker, t.tenantId, (c) => enqueueTicketOutbox(c, t.tenantId, ticketId, "int"));
  return { t, ticketId };
}

/** One delivery of the ticket's job to the handler, as the dispatcher would make it. Returns the error code if it threw. */
async function deliver(t: TestTenant, ticketId: string, attempt = 1): Promise<{ note?: string; error?: string }> {
  try {
    const r = await handler()({
      outboxId: randomUUID(), tenantId: t.tenantId, kind: "github.create_issue", idempotencyKey: githubIdempotencyKey(t.tenantId, ticketId, "general"),
      payload: { ticketId }, attempt, traceId: "int",
    });
    return { note: (r as { note?: string } | undefined)?.note };
  } catch (err) {
    return { error: (err as { code?: string }).code ?? (err as Error).name };
  }
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

describe("GitHub is down when the ticket's job runs", () => {
  it("the handler records the failure; once GitHub is back, reconcile creates exactly one issue and then leaves it alone", async () => {
    const { t, ticketId } = await newTicket();
    gh.fail("create", { status: 503 });
    assert.equal((await deliver(t, ticketId)).error, "server", "transient: the dispatcher will retry it");
    const failed = await row(ticketId);
    assert.deepEqual([failed.sync_status, failed.last_error, failed.sync_attempts], ["failed", "server", 1]);
    assert.equal(gh.issues.length, 0);

    assert.ok(!(await candidateIds()).includes(await syncId(ticketId)), "inside its wait: the outbox's own retries get the first go");
    await timeTravel(ticketId); // the wait has passed

    const first = await reconcile();
    assert.equal(first.created, 1);
    assert.equal(issuesFor(ticketId).length, 1, "exactly one issue");
    const r = await row(ticketId);
    assert.deepEqual([r.sync_status, r.external_issue_number, r.sync_attempts, r.last_error, r.next_attempt_at], ["created", 1, 0, null, null]);
    assert.equal((await db.owner.query("SELECT tracker_ref FROM tickets WHERE id = $1", [ticketId])).rows[0].tracker_ref, `https://github.com/${REPO}/issues/1`);
    assert.deepEqual((await eventsOf(ticketId)).map((e) => [e.type, e.actor_ref]), [["tracker.issue_created", "job:github-reconcile"]]);

    assert.equal((await reconcile()).examined, 0, "a healthy created row is not touched until it goes stale");
    // The outbox job is still queued: when the dispatcher finally runs it, it must find the work already done.
    assert.deepEqual(await deliver(t, ticketId, 2), { note: "already_created" });
    assert.equal(gh.createRequests.length, 2, "the first attempt (refused with a 503) and reconcile's: two requests, one issue");
    assert.equal(gh.issues.length, 1);
  });
});

describe("GitHub accepted the create but the answer never arrived", () => {
  it("the dispatcher's retry does not open a second issue while GitHub's search cannot see the first yet", {
    // FINDING (not fixed in this PR): the handler retries within about a second, and its pre-create search can miss an
    // issue that was created moments ago because GitHub's search index lags. Expect this to fail until the handler holds
    // ambiguous failures (timeout, network, 5xx on a create) back for a few minutes, for example by rethrowing the error
    // with `retryAfterMs` set (the dispatcher honours it). Delete the `todo` once that is done.
    todo: "retry after an accepted-but-unanswered create can duplicate while the search index lags (see the comment above)",
  }, async () => {
    const { t, ticketId } = await newTicket();
    gh.hideNewFromSearch = true;
    gh.fail("create", { acceptThenDrop: true });

    const registry = createDefaultOutboxRegistry(() => undefined);
    registry.register("github.create_issue", handler());
    const dispatcher = new OutboxDispatcher({ pool: db.worker, registry, pollIntervalMs: 15, backoffBaseMs: 20, backoffMaxMs: 40, random: () => 0.5, log: () => undefined });
    dispatcher.start();
    try {
      await waitFor(async () => (await db.owner.query("SELECT 1 FROM outbox WHERE tenant_id = $1 AND kind = 'github.create_issue' AND status IN ('done','failed')", [t.tenantId])).rowCount === 1, 15_000);
    } finally { await dispatcher.close(); }

    assert.equal(issuesFor(ticketId).length, 1, `GitHub holds ${issuesFor(ticketId).length} issues for one ticket`);
  });

  it("reconcile's own dropped create makes the row wait at least five minutes before it looks again, then repairs without a second create", async () => {
    const { t, ticketId } = await newTicket();
    gh.fail("create", { status: 503 });
    await deliver(t, ticketId);
    await timeTravel(ticketId);
    gh.hideNewFromSearch = true;
    gh.fail("create", { acceptThenDrop: true });

    const s = await reconcile();
    assert.equal(s.failed, 1);
    const r = await row(ticketId);
    assert.deepEqual([r.sync_status, r.last_error, r.sync_attempts], ["failed", "network", 2]);
    assert.ok(r.wait >= 290, `waits ${r.wait}s: long enough for the search index to catch up`);
    assert.equal(gh.issues.length, 1, "GitHub did create it");

    gh.revealSearch();
    await timeTravel(ticketId); // the wait is over
    assert.equal((await reconcile()).repaired, 1);
    assert.equal(issuesFor(ticketId).length, 1);
    assert.equal(gh.createRequests.length, 2, "the handler's refused attempt and reconcile's: never a third");
  });
});

describe("GitHub rate limits us", () => {
  it("stops the pass, waits at least as long as GitHub asked, and leaves the other rows untouched", async () => {
    const a = await newTicket();
    const b = await newTicket();
    for (const x of [a, b]) { gh.fail("create", { status: 503 }); await deliver(x.t, x.ticketId); await timeTravel(x.ticketId); }
    gh.fail("search", { status: 403, headers: { "retry-after": "900", "x-ratelimit-remaining": "0" } });

    const s = await reconcile();

    assert.equal(s.rateLimited, 1);
    assert.equal(s.examined, 1, "the second row was never sent to a rate-limited API");
    // Two searches came from the handler deliveries above (each looks before it creates); reconcile sent exactly one more,
    // which was refused, and then stopped.
    assert.equal(gh.requests.filter((r) => r.path === "/search/issues").length, 3, "reconcile did not go on to search for the second row");
    const rows = [await row(a.ticketId), await row(b.ticketId)];
    const limited = rows.find((r) => r.last_error === "rate_limited")!;
    assert.ok(limited.wait >= 890, `waits ${limited.wait}s, at least GitHub's 900s`);
    assert.equal(limited.sync_attempts, 2, "the handler's failed attempt plus the one reconcile tried");
    assert.equal(rows.find((r) => r !== limited)!.sync_attempts, 1, "the untouched row burnt no reconcile attempt");
  });
});

describe("the issue changes on GitHub after it was created", () => {
  it("a closed issue is noticed; a deleted one is recreated exactly once", async () => {
    const closed = await newTicket();
    const deleted = await newTicket();
    for (const x of [closed, deleted]) assert.equal((await deliver(x.t, x.ticketId)).note, "created");
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

  it("a second delivery of the job never opens a second issue once one exists, whether it is open or closed", async () => {
    const { t, ticketId } = await newTicket();
    assert.equal((await deliver(t, ticketId)).note, "created");
    assert.equal((await deliver(t, ticketId, 2)).note, "already_created");
    assert.equal(gh.createRequests.length, 1);
    await db.owner.query("UPDATE tracker_issues SET sync_status = 'closed' WHERE ticket_id = $1", [ticketId]);
    assert.equal((await deliver(t, ticketId, 3)).note, "already_created");
    assert.equal(gh.createRequests.length, 1);
  });
});
