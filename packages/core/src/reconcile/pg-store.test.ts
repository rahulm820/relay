// Postgres-backed tests for the reconcile store, its SQL selection rules, the lease, tenant isolation and the sync
// health function. Needs the throwaway Postgres (see testing/fixtures.ts). The decision logic itself is covered
// without a database in reconcile.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { getSyncHealthCounts, withTenant } from "@relay/db";
import { TrackerError, type ExternalIssue, type FoundIssue, type TrackerProvider } from "@relay/trackers";
import { EnvSecretProvider } from "@relay/shared";
import { createMember, createTenant, createTestDb, type TestDb, type TestTenant } from "../testing/fixtures.js";
import { createPgReconcileStore } from "./pg-store.js";
import { reconcileOnce } from "./reconcile.js";

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.dispose(); });

const OPTS = { graceSeconds: 300, staleSeconds: 3600, retryBudget: 3 };
const store = () => createPgReconcileStore({ pool: db.worker, ...OPTS });
const secrets = new EnvSecretProvider({ TEST_GITHUB_TOKEN: "ghp_test_token_value_1234567890" });

async function arrange(t: TestTenant, o: { status?: string; ticketStatus?: string; ageMin?: number; attempts?: number; nextInMin?: number | null; syncedMin?: number | null; number?: number | null } = {}) {
  const hasIntegration = (await db.owner.query("SELECT 1 FROM integrations WHERE tenant_id = $1", [t.tenantId])).rowCount;
  if (!hasIntegration) {
    await db.owner.query(
      `INSERT INTO integrations (tenant_id, provider, credentials_ref, repo_ref, label_map_json, status, approval_policy)
       VALUES ($1, 'github', 'env:TEST_GITHUB_TOKEN', 'acme/app', '{"category":{"bug":"bug"}}', 'active', 'auto')`, [t.tenantId]);
  }
  const ticketId = randomUUID();
  await db.owner.query(
    "INSERT INTO tickets (id, tenant_id, conversation_id, title, summary, category, priority, status) VALUES ($1,$2,$3,'Checkout fails','Card payments return 500','bug','P2',$4)",
    [ticketId, t.tenantId, t.conversationId, o.ticketStatus ?? "triaged"]);
  const age = o.ageMin ?? 60;
  const { rows } = await db.owner.query(
    `INSERT INTO tracker_issues (tenant_id, ticket_id, provider, repo_ref, sync_status, idempotency_key, sync_attempts, next_attempt_at,
                                 last_synced_at, created_at, external_issue_number)
     VALUES ($1,$2,'github','acme/app',$3,$4,$5,
             CASE WHEN $6::float8 IS NULL THEN NULL ELSE now() + $6::float8 * interval '1 minute' END,
             CASE WHEN $7::float8 IS NULL THEN NULL ELSE now() - $7::float8 * interval '1 minute' END,
             now() - $8::float8 * interval '1 minute', $9)
     RETURNING id`,
    [t.tenantId, ticketId, o.status ?? "failed", `github:${t.tenantId}:${ticketId}:general`, o.attempts ?? 0, o.nextInMin ?? null, o.syncedMin === undefined ? age : o.syncedMin, age, o.number ?? null]);
  return { ticketId, syncId: rows[0].id as string };
}
const syncRow = async (id: string) => (await db.owner.query("SELECT sync_status, sync_attempts, last_error, external_issue_number, external_issue_url, next_attempt_at, repo_ref FROM tracker_issues WHERE id = $1", [id])).rows[0];
const candidateIds = async () => (await store().candidates(500)).map((c) => c.id);

describe("candidate selection (relay_reconcile_candidates)", () => {
  it("returns pending/failed rows past the grace period and inside the budget", async () => {
    const t = await createTenant(db.owner);
    const due = await arrange(t, { status: "failed", ageMin: 10 });
    const pending = await arrange(t, { status: "pending", ageMin: 10 });
    const ids = await candidateIds();
    assert.ok(ids.includes(due.syncId) && ids.includes(pending.syncId));
  });

  it("skips rows the pipeline stage may still be working on (inside the grace period)", async () => {
    const t = await createTenant(db.owner);
    const fresh = await arrange(t, { status: "pending", ageMin: 1 });
    assert.ok(!(await candidateIds()).includes(fresh.syncId));
  });

  it("skips rows waiting out a backoff or lease, and rows past their retry budget", async () => {
    const t = await createTenant(db.owner);
    const waiting = await arrange(t, { status: "failed", nextInMin: 30 });
    const spent = await arrange(t, { status: "failed", attempts: 3 });
    const ok = await arrange(t, { status: "failed", attempts: 2 });
    const ids = await candidateIds();
    assert.ok(!ids.includes(waiting.syncId));
    assert.ok(!ids.includes(spent.syncId));
    assert.ok(ids.includes(ok.syncId));
  });

  it("includes created rows only once they are stale, and never closed rows", async () => {
    const t = await createTenant(db.owner);
    const stale = await arrange(t, { status: "created", syncedMin: 120, number: 5 });
    const recent = await arrange(t, { status: "created", syncedMin: 5, number: 6 });
    const closed = await arrange(t, { status: "closed", syncedMin: 600, number: 7 });
    const ids = await candidateIds();
    assert.ok(ids.includes(stale.syncId));
    assert.ok(!ids.includes(recent.syncId));
    assert.ok(!ids.includes(closed.syncId));
  });

  it("is executable by the worker login but not by the API login", async () => {
    await assert.rejects(db.api.query("SELECT * FROM relay_reconcile_candidates(10, 300, 3600, 3)"), /permission denied/);
    await assert.rejects(db.api.query("SELECT * FROM relay_sync_health_all(3)"), /permission denied/);
  });
});

describe("claim lease", () => {
  it("only one of several concurrent claimers wins a row, and a created refresh costs no attempt", async () => {
    const t = await createTenant(db.owner);
    const { syncId } = await arrange(t, { status: "failed", attempts: 1 });
    const cand = { id: syncId, tenantId: t.tenantId };
    const results = await Promise.all(Array.from({ length: 6 }, () => store().claim(cand, 120)));
    assert.equal(results.filter(Boolean).length, 1);
    const r = await syncRow(syncId);
    assert.equal(r.sync_attempts, 2);
    assert.ok(new Date(r.next_attempt_at).getTime() > Date.now() + 100_000, "leased into the future");
    assert.equal(await store().claim(cand, 120), null, "still leased");

    const created = await arrange(t, { status: "created", syncedMin: 120, number: 9 });
    await store().claim({ id: created.syncId, tenantId: t.tenantId }, 120);
    assert.equal((await syncRow(created.syncId)).sync_attempts, 0);
  });

  it("a lease that expires (worker crashed) makes the row claimable again", async () => {
    const t = await createTenant(db.owner);
    const { syncId } = await arrange(t, { status: "pending" });
    const cand = { id: syncId, tenantId: t.tenantId };
    assert.ok(await store().claim(cand, 120));
    await db.owner.query("UPDATE tracker_issues SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [syncId]);
    assert.ok(await store().claim(cand, 120));
  });
});

/** A fake GitHub that records calls; `existing` is what search would find. */
function fakeGitHub(existing: (ticketId: string) => FoundIssue | null, fail?: TrackerError) {
  const created: string[] = [];
  const provider: TrackerProvider = {
    provider: "github",
    createIssue: async (repo, issue): Promise<ExternalIssue> => {
      if (fail) throw fail;
      created.push(issue.body);
      return { id: "900", number: 900, url: `https://github.com/${repo}/issues/900` };
    },
    findIssueByTicket: async (_r, ticketId) => existing(ticketId),
    getStatus: async () => ({ state: "open", labels: [] }),
    updateIssue: async () => { throw new Error("unused"); }, addComment: async () => { throw new Error("unused"); },
    linkIssues: async () => { throw new Error("unused"); }, onWebhook: () => { throw new Error("unused"); },
  };
  return { provider, created };
}
/** The tests share one database: close every other tenant's rows (closed rows are never candidates) so a pass only sees ours. */
const isolate = (...tenants: TestTenant[]) => db.owner.query("UPDATE tracker_issues SET sync_status = 'closed' WHERE NOT (tenant_id = ANY($1::uuid[]))", [tenants.map((t) => t.tenantId)]);
const run = (provider: TrackerProvider) => reconcileOnce({ store: store(), secrets, createProvider: () => provider, random: () => 0.5, log: () => undefined });

describe("reconcile end to end against Postgres", () => {
  it("repairs a failed row to created when the issue exists on GitHub, links the ticket, writes one event, creates nothing", async () => {
    const t = await createTenant(db.owner);
    const { ticketId, syncId } = await arrange(t, { status: "failed", attempts: 1 });
    await isolate(t);
    const gh = fakeGitHub((id) => (id === ticketId ? { id: "77", number: 42, url: "https://github.com/acme/app/issues/42", state: "open" } : null));

    await run(gh.provider);

    assert.equal(gh.created.length, 0);
    const r = await syncRow(syncId);
    assert.deepEqual([r.sync_status, r.external_issue_number, r.sync_attempts, r.last_error, r.next_attempt_at], ["created", 42, 0, null, null]);
    assert.equal((await db.owner.query("SELECT tracker_ref FROM tickets WHERE id = $1", [ticketId])).rows[0].tracker_ref, "https://github.com/acme/app/issues/42");
    const ev = (await db.owner.query("SELECT type, actor_ref, payload FROM ticket_events WHERE ticket_id = $1 AND type LIKE 'tracker.%'", [ticketId])).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, "tracker.issue_repaired");
    assert.equal(ev[0].actor_ref, "job:github-reconcile");
  });

  it("creates exactly one issue when none exists, carrying the ticket id, and is idempotent on the next pass", async () => {
    const t = await createTenant(db.owner);
    const { ticketId, syncId } = await arrange(t, { status: "pending" });
    await isolate(t);
    const gh = fakeGitHub(() => null);

    await run(gh.provider);
    await run(gh.provider);

    assert.equal(gh.created.length, 1);
    assert.ok(gh.created[0]!.includes(ticketId));
    assert.equal((await syncRow(syncId)).sync_status, "created");
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id = $1 AND type = 'tracker.issue_created'", [ticketId])).rows[0].n, 1);
  });

  it("two workers passing at once create one issue", async () => {
    const t = await createTenant(db.owner);
    await arrange(t, { status: "pending" });
    await isolate(t);
    const gh = fakeGitHub(() => null);
    await Promise.all([run(gh.provider), run(gh.provider)]);
    assert.equal(gh.created.length, 1);
  });

  it("a failure records the code, backs the row off and counts an attempt", async () => {
    const t = await createTenant(db.owner);
    const { syncId } = await arrange(t, { status: "pending" });
    await isolate(t);
    await run(fakeGitHub(() => null, new TrackerError("server", "5xx")).provider);
    const r = await syncRow(syncId);
    assert.deepEqual([r.sync_status, r.last_error, r.sync_attempts], ["failed", "server", 1]);
    assert.ok(new Date(r.next_attempt_at).getTime() > Date.now() + 200_000, "outcome-unknown failures wait before looking again");
  });

  it("never touches a quarantined ticket and never leaks across tenants", async () => {
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const q = await arrange(a, { status: "pending", ticketStatus: "quarantined" });
    const other = await arrange(b, { status: "pending" });
    await isolate(a, b);
    const gh = fakeGitHub(() => null);
    await run(gh.provider);
    assert.equal((await syncRow(q.syncId)).sync_status, "pending");
    assert.equal(gh.created.length, 1, "only tenant b's ticket was created");
    // The tenant-scoped store cannot even see the other tenant's row.
    const seen = await withTenant(db.worker, a.tenantId, (c) => c.query("SELECT id FROM tracker_issues WHERE id = $1", [other.syncId]));
    assert.equal(seen.rowCount, 0);
  });
});

describe("sync health counts (relay_sync_health_all)", () => {
  it("counts github.* outbox backlog age and failures, tracker rows by status, and rows failed beyond budget", async () => {
    const t = await createTenant(db.owner);
    const before = await getSyncHealthCounts(db.worker, 3);
    await arrange(t, { status: "failed", attempts: 3 });
    await arrange(t, { status: "failed", attempts: 1 });
    await arrange(t, { status: "pending" });
    await arrange(t, { status: "created", number: 1, syncedMin: 5 });
    await db.owner.query("INSERT INTO outbox (tenant_id, kind, idempotency_key, status, created_at) VALUES ($1,'github.create_issue',$2,'pending', now() - interval '20 minutes')", [t.tenantId, randomUUID()]);
    await db.owner.query("INSERT INTO outbox (tenant_id, kind, idempotency_key, status) VALUES ($1,'github.create_issue',$2,'failed')", [t.tenantId, randomUUID()]);
    await db.owner.query("INSERT INTO outbox (tenant_id, kind, idempotency_key, status, created_at) VALUES ($1,'client.send',$2,'pending', now() - interval '99 minutes')", [t.tenantId, randomUUID()]);

    const after = await getSyncHealthCounts(db.worker, 3);

    assert.equal(after.syncFailed - before.syncFailed, 2);
    assert.equal(after.syncFailedBeyondBudget - before.syncFailedBeyondBudget, 1);
    assert.equal(after.syncPending - before.syncPending, 1);
    assert.equal(after.syncCreated - before.syncCreated, 1);
    assert.equal(after.outboxBacklog - before.outboxBacklog, 1, "client.send rows are not github backlog");
    assert.equal(after.outboxFailed - before.outboxFailed, 1);
    assert.ok(after.outboxOldestSeconds >= 20 * 60 - 5, `oldest backlog ${after.outboxOldestSeconds}s`);
  });

  it("members of other tenants are irrelevant: the function returns counts only", async () => {
    const t = await createTenant(db.owner);
    await createMember(db.owner, t.tenantId);
    const counts = await getSyncHealthCounts(db.worker, 3);
    assert.deepEqual(Object.keys(counts).sort(), ["outboxBacklog", "outboxFailed", "outboxOldestSeconds", "syncClosed", "syncCreated", "syncFailed", "syncFailedBeyondBudget", "syncPending"]);
  });
});
