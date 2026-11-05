import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TrackerError, type ExternalIssue, type FoundIssue, type NewIssue, type TrackerProvider } from "@relay/trackers";
import { EnvSecretProvider } from "@relay/shared";
import type { TicketForIssue } from "../github-sync/issue.js";
import { reconcileOnce, type ClaimedSync, type ReconcileLogEvent, type ReconcileStore, type SyncIntegration } from "./reconcile.js";

// ---- a fake GitHub that behaves like the real one where it matters: issues have bodies, search finds by body ----
class FakeGitHub {
  issues: { number: number; body: string; title: string; state: "open" | "closed"; deleted?: boolean }[] = [];
  calls = { create: 0, find: 0, status: 0 };
  /** Scripted failures, consumed one per call to the named method. */
  failNext: { method: "create" | "find" | "status"; error: TrackerError; stillCreate?: boolean }[] = [];
  next = 100;

  provider: TrackerProvider = {
    provider: "github",
    createIssue: async (repo: string, issue: NewIssue): Promise<ExternalIssue> => {
      this.calls.create++;
      const f = this.take("create");
      // `stillCreate` models a timeout AFTER GitHub accepted the request: the issue exists, the caller never heard.
      if (f && !f.stillCreate) throw f.error;
      const number = this.next++;
      this.issues.push({ number, body: issue.body, title: issue.title, state: "open" });
      if (f) throw f.error;
      return { id: String(number), number, url: `https://github.com/${repo}/issues/${number}` };
    },
    findIssueByTicket: async (repo: string, ticketId: string): Promise<FoundIssue | null> => {
      this.calls.find++;
      const f = this.take("find");
      if (f) throw f.error;
      const hit = this.issues.find((i) => !i.deleted && i.body.includes(ticketId));
      return hit ? { id: String(hit.number), number: hit.number, url: `https://github.com/${repo}/issues/${hit.number}`, state: hit.state } : null;
    },
    getStatus: async (_repo: string, number: number) => {
      this.calls.status++;
      const f = this.take("status");
      if (f) throw f.error;
      const i = this.issues.find((x) => x.number === number);
      if (!i || i.deleted) throw new TrackerError("not_found", "gone");
      return { state: i.state, labels: [] };
    },
    updateIssue: async () => { throw new Error("unused"); },
    addComment: async () => { throw new Error("unused"); },
    linkIssues: async () => { throw new Error("unused"); },
    onWebhook: () => { throw new Error("unused"); },
  };
  private take(method: "create" | "find" | "status") {
    const i = this.failNext.findIndex((f) => f.method === method);
    return i >= 0 ? this.failNext.splice(i, 1)[0] : undefined;
  }
}

// ---- an in-memory ReconcileStore with the same eligibility and lease rules as the SQL ----
interface Row extends ClaimedSync { lastSyncedAt: number; createdAt: number; nextAt: number | null; idemKey: string; lastError: string | null; url: string | null; }
class MemoryStore implements ReconcileStore {
  now = 1_000_000_000_000;
  rows: Row[] = [];
  tickets = new Map<string, TicketForIssue>();
  integrationValue: SyncIntegration | null = { repo: "acme/app", credentialsRef: "env:GH", labelMap: {} };
  events: { ticketId: string; type: string }[] = [];
  failTicketLookupFor: string | undefined;
  readonly graceMs = 300_000;
  readonly staleMs = 3_600_000;
  readonly budget = 3;

  addTicket(over: Partial<TicketForIssue> = {}): TicketForIssue {
    const id = over.id ?? `0a1b2c3d-0000-4000-8000-${String(this.tickets.size + 1).padStart(12, "0")}`;
    const t: TicketForIssue = { id, title: "Checkout fails", summary: "Card payments return 500", category: "bug", priority: "P2", priority_reason: null, status: "triaged", affected_client_count: 1, tracker_ref: null, tier: null, ...over };
    this.tickets.set(id, t);
    return t;
  }
  addRow(ticket: TicketForIssue, status: "pending" | "failed" | "created", over: Partial<Row> = {}): Row {
    const row: Row = {
      id: `row-${this.rows.length + 1}`, tenantId: "tenant-1", ticketId: ticket.id, repo: "acme/app", status, externalNumber: null, attempts: 0,
      lastSyncedAt: this.now - 3_600_000, createdAt: this.now - 3_600_000, nextAt: null, idemKey: `github:t:${ticket.id}:general`, lastError: null, url: null, ...over,
    };
    this.rows.push(row);
    return row;
  }
  advance(ms: number) { this.now += ms; }

  async candidates(limit: number) {
    return this.rows.filter((r) => (r.nextAt ?? -Infinity) <= this.now && (
      ((r.status === "pending" || r.status === "failed") && r.attempts < this.budget && r.lastSyncedAt <= this.now - this.graceMs) ||
      (r.status === "created" && r.lastSyncedAt <= this.now - this.staleMs))).slice(0, limit).map((r) => ({ id: r.id, tenantId: r.tenantId }));
  }
  async claim(c: { id: string }, leaseSeconds: number) {
    const r = this.rows.find((x) => x.id === c.id);
    if (!r || (r.nextAt ?? -Infinity) > this.now) return null;
    r.nextAt = this.now + leaseSeconds * 1000;
    if (r.status !== "created") r.attempts++;
    return { id: r.id, tenantId: r.tenantId, ticketId: r.ticketId, repo: r.repo, status: r.status, externalNumber: r.externalNumber, attempts: r.attempts };
  }
  async integration() { return this.integrationValue; }
  async ticket(_t: string, ticketId: string) {
    if (ticketId === this.failTicketLookupFor) throw new Error("database exploded");
    return this.tickets.get(ticketId) ?? null;
  }
  private row(c: ClaimedSync) { return this.rows.find((r) => r.id === c.id)!; }
  async linked(c: ClaimedSync, issue: ExternalIssue, closed: boolean, via: "repair" | "create") {
    const r = this.row(c);
    Object.assign(r, { status: closed ? "closed" : "created", externalNumber: issue.number, url: issue.url, attempts: 0, nextAt: null, lastError: null, lastSyncedAt: this.now });
    this.events.push({ ticketId: c.ticketId, type: via === "repair" ? "tracker.issue_repaired" : "tracker.issue_created" });
  }
  async closed(c: ClaimedSync) { Object.assign(this.row(c), { status: "closed", lastSyncedAt: this.now, nextAt: null }); }
  async refreshed(c: ClaimedSync) { Object.assign(this.row(c), { lastSyncedAt: this.now, nextAt: null }); }
  async failed(c: ClaimedSync, code: string, secs: number) { Object.assign(this.row(c), { status: "failed", lastError: code, lastSyncedAt: this.now, nextAt: this.now + secs * 1000 }); }
  async deferred(c: ClaimedSync, secs: number) { this.row(c).nextAt = this.now + secs * 1000; }
}

const TOKEN = "ghp_not_a_real_token_for_tests_0123456789";
function setup() {
  const gh = new FakeGitHub();
  const store = new MemoryStore();
  const logs: ReconcileLogEvent[] = [];
  const run = () => reconcileOnce({ store, secrets: new EnvSecretProvider({ GH: TOKEN }), createProvider: () => gh.provider, random: () => 0.5, log: (e) => logs.push(e) });
  return { gh, store, logs, run };
}
/** What the pipeline stage would have written to GitHub for this ticket (the body carries the ticket id). */
const bodyFor = (t: TicketForIssue) => `Card payments return 500\n\n---\n_Created from Relay ticket \`${t.id}\`._`;

describe("reconcile: drift is repaired without duplicates", () => {
  it("a failed row whose issue really exists on GitHub is repaired to created; nothing is created", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket();
    const row = store.addRow(t, "failed", { lastError: "timeout", attempts: 1 });
    gh.issues.push({ number: 42, body: bodyFor(t), title: t.title, state: "open" });

    const s = await run();

    assert.equal(s.repaired, 1);
    assert.equal(s.created, 0);
    assert.equal(gh.calls.create, 0, "must not create a second issue");
    assert.equal(gh.issues.length, 1);
    assert.deepEqual([row.status, row.externalNumber, row.attempts, row.lastError], ["created", 42, 0, null]);
    assert.deepEqual(store.events, [{ ticketId: t.id, type: "tracker.issue_repaired" }]);
  });

  it("repairs to closed when the found issue is already closed", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket();
    const row = store.addRow(t, "pending");
    gh.issues.push({ number: 7, body: bodyFor(t), title: t.title, state: "closed" });
    await run();
    assert.equal(row.status, "closed");
  });

  it("a pending row with no issue on GitHub gets exactly one created, and a second pass does nothing", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket();
    const row = store.addRow(t, "pending");

    const first = await run();
    assert.equal(first.created, 1);
    assert.equal(gh.issues.length, 1);
    assert.equal(row.status, "created");
    assert.equal(row.externalNumber, 100);
    assert.deepEqual(store.events, [{ ticketId: t.id, type: "tracker.issue_created" }]);

    const second = await run();
    assert.equal(second.examined, 0, "a created row is not due again until it goes stale");
    assert.equal(gh.calls.create, 1);
  });

  it("two workers running at the same time create one issue between them", async () => {
    const { gh, store } = setup();
    const t = store.addTicket();
    store.addRow(t, "pending");
    const pass = () => reconcileOnce({ store, secrets: new EnvSecretProvider({ GH: TOKEN }), createProvider: () => gh.provider, random: () => 0.5, log: () => undefined });
    const [a, b] = await Promise.all([pass(), pass()]);
    assert.equal(gh.issues.length, 1);
    assert.equal(a.created + b.created, 1);
    assert.equal(a.contended + b.contended, 1, "the loser saw the row already leased");
  });
});

describe("reconcile: failures, backoff and the unknown outcome of a timed-out create", () => {
  it("a create that timed out after GitHub accepted it is found and linked on the next pass, not duplicated", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket();
    const row = store.addRow(t, "pending");
    gh.failNext.push({ method: "create", error: new TrackerError("timeout", "slow"), stillCreate: true });

    const first = await run();
    assert.equal(first.failed, 1);
    assert.equal(row.status, "failed");
    assert.equal(row.lastError, "timeout");
    assert.equal(gh.issues.length, 1, "GitHub did accept the create");
    assert.ok(row.nextAt! - store.now >= 300_000, "an outcome-unknown failure waits at least the floor before looking again");

    assert.equal((await run()).examined, 0, "not due yet");
    store.advance(301_000);
    const second = await run();
    assert.equal(second.repaired, 1);
    assert.equal(gh.calls.create, 1, "never created again");
    assert.equal(gh.issues.length, 1);
    assert.equal(row.status, "created");
  });

  it("retry delays grow with the attempt number (jittered but bounded)", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket();
    const row = store.addRow(t, "pending");
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      gh.failNext.push({ method: "find", error: new TrackerError("validation", "rejected") });
      await run();
      delays.push((row.nextAt! - store.now) / 1000);
      store.now = row.nextAt! + 1; // jump to just after the retry becomes due; keeps lastSyncedAt <= now - grace below
      row.lastSyncedAt = store.now - store.graceMs - 1;
    }
    assert.deepEqual(row.attempts, 3);
    assert.ok(delays[1]! > delays[0]! && delays[2]! > delays[1]!, `delays should grow: ${delays}`);
    assert.ok(delays.every((d) => d <= 3600), "bounded by the max backoff");
  });

  it("stops retrying once the attempt budget is spent, leaving the code on the row", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket();
    const row = store.addRow(t, "pending");
    for (let i = 0; i < 6; i++) {
      gh.failNext.push({ method: "find", error: new TrackerError("auth", "bad token") });
      await run();
      store.now += 24 * 3_600_000;
    }
    assert.equal(row.attempts, 3, "claimed exactly budget times, then no longer a candidate");
    assert.equal(row.status, "failed");
    assert.equal(row.lastError, "auth");
    assert.equal(gh.calls.find, 3);
  });

  it("a rate limit ends the pass, honours the wait GitHub asked for, and leaves the rest of the batch alone", async () => {
    const { gh, store, logs, run } = setup();
    const rows = [store.addTicket(), store.addTicket(), store.addTicket()].map((t) => store.addRow(t, "pending"));
    gh.failNext.push({ method: "find", error: new TrackerError("rate_limited", "slow down", 900_000) });

    const s = await run();

    assert.equal(s.rateLimited, 1);
    assert.equal(gh.calls.find, 1, "the remaining rows were not sent to a rate-limited API");
    assert.equal(rows[0]!.lastError, "rate_limited");
    assert.ok(rows[0]!.nextAt! - store.now >= 900_000, "waits at least the Retry-After");
    assert.equal(s.examined, 1);
    assert.deepEqual(rows.slice(1).map((r) => r.attempts), [0, 0], "untouched rows burn no attempts");
    assert.ok(logs.some((l) => l.event === "reconcile_rate_limited"));
  });

  it("one row that blows up does not stop the others", async () => {
    const { store, run } = setup();
    const bad = store.addTicket();
    const good = store.addTicket();
    store.addRow(bad, "pending");
    const goodRow = store.addRow(good, "pending");
    store.failTicketLookupFor = bad.id;
    const s = await run();
    assert.equal(s.failed, 1);
    assert.equal(s.created, 1);
    assert.equal(goodRow.status, "created");
    assert.equal(store.rows[0]!.lastError, "unexpected_error");
  });
});

describe("reconcile: refreshing created rows", () => {
  it("a stale created row whose issue was closed becomes closed", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket();
    const row = store.addRow(t, "created", { externalNumber: 5 });
    gh.issues.push({ number: 5, body: bodyFor(t), title: t.title, state: "closed" });
    const s = await run();
    assert.equal(s.closed, 1);
    assert.equal(row.status, "closed");
  });

  it("a stale created row whose issue is still open is just refreshed", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket();
    const row = store.addRow(t, "created", { externalNumber: 5 });
    gh.issues.push({ number: 5, body: bodyFor(t), title: t.title, state: "open" });
    const s = await run();
    assert.equal(s.refreshed, 1);
    assert.equal(row.status, "created");
    assert.equal(row.lastSyncedAt, store.now);
  });

  it("a created row whose issue was deleted fails as issue_missing, then exactly one replacement is created", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket();
    const row = store.addRow(t, "created", { externalNumber: 5 });
    gh.issues.push({ number: 5, body: bodyFor(t), title: t.title, state: "open", deleted: true });

    await run();
    assert.equal(row.status, "failed");
    assert.equal(row.lastError, "issue_missing");

    store.advance(301_000);
    const s = await run();
    assert.equal(s.created, 1);
    assert.equal(gh.issues.filter((i) => !i.deleted).length, 1);
    assert.equal(row.status, "created");
    assert.notEqual(row.externalNumber, 5);
  });

  it("a transient GitHub error on a healthy created row is deferred, never turned into a failure", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket();
    const row = store.addRow(t, "created", { externalNumber: 5 });
    gh.failNext.push({ method: "status", error: new TrackerError("server", "5xx") });
    const s = await run();
    assert.equal(s.deferred, 1);
    assert.equal(row.status, "created");
    assert.equal(row.lastError, null);
  });
});

describe("reconcile: things it must not do", () => {
  it("never touches GitHub for a quarantined ticket", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket({ status: "quarantined" });
    const row = store.addRow(t, "pending");
    const s = await run();
    assert.equal(s.deferred, 1);
    assert.deepEqual([gh.calls.find, gh.calls.create], [0, 0]);
    assert.ok(row.nextAt! - store.now >= 3600_000);
  });

  it("missing credentials fail a pending row with a stable code and no GitHub call", async () => {
    const { gh, store, run } = setup();
    store.integrationValue = { repo: "acme/app", credentialsRef: "env:NOT_SET", labelMap: {} };
    const t = store.addTicket();
    const row = store.addRow(t, "pending");
    await run();
    assert.equal(row.lastError, "missing_credentials");
    assert.deepEqual([gh.calls.find, gh.calls.create], [0, 0]);
  });

  it("with no active integration a created row is deferred, not failed", async () => {
    const { store, run } = setup();
    store.integrationValue = null;
    const t = store.addTicket();
    const row = store.addRow(t, "created", { externalNumber: 5 });
    await run();
    assert.equal(row.status, "created");
  });

  it("logs ids and codes only: no ticket text and no token", async () => {
    const { gh, store, logs, run } = setup();
    const t = store.addTicket({ title: "SECRET-TITLE-TEXT", summary: "SECRET-SUMMARY" });
    store.addRow(t, "pending");
    gh.failNext.push({ method: "find", error: new TrackerError("server", `boom ${TOKEN}`) });
    await run();
    const text = JSON.stringify(logs);
    assert.ok(logs.length > 0);
    assert.ok(!text.includes("SECRET-TITLE-TEXT") && !text.includes("SECRET-SUMMARY") && !text.includes(TOKEN));
  });

  it("created issues carry the same body the pipeline stage would write, including the ticket id", async () => {
    const { gh, store, run } = setup();
    const t = store.addTicket();
    store.addRow(t, "pending");
    await run();
    assert.ok(gh.issues[0]!.body.includes(t.id), "the id is what makes a later repair possible");
    assert.ok(gh.issues[0]!.body.includes("Card payments return 500"));
  });
});
