import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError } from "@relay/shared";
import type { SyncHealthCounts } from "@relay/db";
import { SyncMetrics, evaluateAlerts, toSyncHealth } from "./health.js";
import { PeriodicJob } from "./loop.js";
import { emptySummary } from "./reconcile.js";
import { reconcileSettingsFromEnv } from "./settings.js";

const healthy: SyncHealthCounts = { outboxBacklog: 0, outboxOldestSeconds: 0, outboxFailed: 0, syncPending: 0, syncFailed: 0, syncCreated: 5, syncClosed: 1, syncFailedBeyondBudget: 0 };
const T = { backlogSeconds: 600 };

describe("evaluateAlerts", () => {
  it("is quiet when everything is healthy", () => assert.deepEqual(evaluateAlerts(healthy, T), []));

  it("alerts when the oldest github.* outbox row is older than the threshold, and only then", () => {
    assert.deepEqual(evaluateAlerts({ ...healthy, outboxOldestSeconds: 600 }, T), [], "exactly at the threshold is not yet an alert");
    assert.deepEqual(evaluateAlerts({ ...healthy, outboxOldestSeconds: 601 }, T), [{ code: "github_outbox_backlog_stale", value: 601 }]);
  });

  it("alerts when a ticket stays failed beyond its retry budget, and when outbox jobs failed for good", () => {
    const codes = evaluateAlerts({ ...healthy, syncFailedBeyondBudget: 2, outboxFailed: 1 }, T).map((a) => a.code);
    assert.deepEqual(codes.sort(), ["github_outbox_failed", "github_sync_failed_beyond_budget"]);
  });

  it("failed rows still inside their budget are not an alert on their own", () => {
    assert.deepEqual(evaluateAlerts({ ...healthy, syncFailed: 4, syncPending: 2 }, T), []);
  });
});

describe("SyncMetrics and toSyncHealth", () => {
  it("accumulates reconcile passes and reports degraded when an alert holds", () => {
    const m = new SyncMetrics();
    assert.deepEqual(m.snapshot(), { passes: 0, lastPassAt: null, lastPassFailed: false, totals: emptySummary() });
    m.record({ ...emptySummary(), repaired: 2, created: 1, rateLimited: 1 }, new Date("2026-11-05T10:00:00Z"));
    m.record({ ...emptySummary(), repaired: 1 }, new Date("2026-11-05T10:01:00Z"));
    const snap = m.snapshot();
    assert.equal(snap.passes, 2);
    assert.equal(snap.lastPassAt, "2026-11-05T10:01:00.000Z");
    assert.deepEqual([snap.totals.repaired, snap.totals.created, snap.totals.rateLimited], [3, 1, 1]);

    const ok = toSyncHealth(healthy, T, m);
    assert.equal(ok.status, "ok");
    assert.deepEqual(ok.trackerIssues, { pending: 0, failed: 0, created: 5, closed: 1, failedBeyondBudget: 0 });
    const bad = toSyncHealth({ ...healthy, outboxBacklog: 3, outboxOldestSeconds: 900 }, T, m);
    assert.equal(bad.status, "degraded");
    assert.deepEqual(bad.outbox, { githubBacklog: 3, oldestSeconds: 900, failed: 0 });
  });

  it("remembers that the last pass failed outright, until the next one succeeds", () => {
    const m = new SyncMetrics();
    m.recordFailure();
    assert.equal(m.snapshot().lastPassFailed, true);
    m.record(emptySummary());
    assert.equal(m.snapshot().lastPassFailed, false);
  });

  it("exposes counts only: nothing resembling ticket data is in the payload", () => {
    const text = JSON.stringify(toSyncHealth(healthy, T, new SyncMetrics()));
    assert.ok(!/title|summary|token|tenant/i.test(text));
  });
});

describe("reconcileSettingsFromEnv", () => {
  it("has demo-friendly defaults", () => {
    assert.deepEqual(reconcileSettingsFromEnv({}), { intervalSeconds: 60, graceSeconds: 300, staleSeconds: 3600, retryBudget: 8, backlogAlertSeconds: 600 });
  });

  it("reads overrides, including 0 to turn the job off", () => {
    const s = reconcileSettingsFromEnv({ RECONCILE_INTERVAL_SECONDS: "0", GITHUB_SYNC_RETRY_BUDGET: "3", RECONCILE_GRACE_SECONDS: " 30 " });
    assert.deepEqual([s.intervalSeconds, s.retryBudget, s.graceSeconds], [0, 3, 30]);
  });

  it("rejects bad values naming the variable and never the value", () => {
    assert.throws(() => reconcileSettingsFromEnv({ GITHUB_SYNC_RETRY_BUDGET: "0", RECONCILE_STALE_SECONDS: "abc-secret" }), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /GITHUB_SYNC_RETRY_BUDGET/);
      assert.match(e.message, /RECONCILE_STALE_SECONDS/);
      assert.ok(!e.message.includes("abc-secret"));
      return true;
    });
  });
});

describe("PeriodicJob", () => {
  it("runs immediately, repeats, survives a failing pass, and close() waits for the pass in flight", async () => {
    let runs = 0;
    const errors: unknown[] = [];
    let finishedInFlight = false;
    const job = new PeriodicJob(async () => {
      runs++;
      if (runs === 2) throw new Error("db down");
      if (runs === 4) { await new Promise((r) => setTimeout(r, 40)); finishedInFlight = true; }
    }, 10, (e) => errors.push(e));
    job.start();
    while (runs < 4) await new Promise((r) => setTimeout(r, 5));
    await job.close();
    assert.equal(errors.length, 1);
    assert.equal(finishedInFlight, true, "close waited for the pass that was running");
    const after = runs;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(runs, after, "no more passes after close");
  });
});
