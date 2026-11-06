import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { withTenant } from "@relay/db";
import type { OutboxKind } from "@relay/shared";
import { PermanentFailureError } from "../queue/index.js";
import { createTenant, createTestDb, waitFor, type TestDb } from "../testing/fixtures.js";
import {
  NOOP_NOTE, OutboxDispatcher, OutboxRegistry, createDefaultOutboxRegistry, enqueueOutbox,
  type OutboxHandler, type OutboxLogEvent,
} from "./index.js";

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.dispose(); });

// random: () => 1 pins the jitter to the top of its range, so delays are exactly base * 2^(attempt-1).
const FAST = { pollIntervalMs: 15, backoffBaseMs: 40, backoffMaxMs: 400, leaseSeconds: 60, random: () => 1 - Number.EPSILON };

async function addRow(tenantId: string, kind: OutboxKind = "github.create_issue", key = randomUUID()): Promise<{ id: string; key: string }> {
  const r = await withTenant(db.worker, tenantId, (c) => enqueueOutbox(c, { kind, tenantId, idempotencyKey: key, traceId: "trace-1", payload: { ticketId: "k1" } }));
  return { id: r.id, key };
}
const row = async (id: string) =>
  (await db.owner.query("SELECT status, attempts, last_error, locked_by, payload, extract(epoch FROM (next_attempt_at - clock_timestamp()))::float8 AS delay FROM outbox WHERE id = $1", [id])).rows[0];
const registryWith = (handler: OutboxHandler) => new OutboxRegistry().register("github.create_issue", handler);
const dispatcher = (registry: OutboxRegistry, extra: Partial<ConstructorParameters<typeof OutboxDispatcher>[0]> = {}, logs: OutboxLogEvent[] = []) =>
  new OutboxDispatcher({ pool: db.worker, registry, ...FAST, maxAttempts: 3, log: (e) => logs.push(e), ...extra });

describe("enqueueOutbox", () => {
  it("is idempotent and stores the trace id in the payload", async () => {
    const t = await createTenant(db.owner);
    const key = randomUUID();
    const a = await addRow(t.tenantId, "client.send", key);
    const b = await addRow(t.tenantId, "client.send", key);
    assert.equal(b.id, a.id);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM outbox WHERE idempotency_key = $1", [key])).rows[0].n, 1);
    assert.equal((await row(a.id)).payload.traceId, "trace-1");
  });

  it("cannot write a row for another tenant", async () => {
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    await assert.rejects(
      withTenant(db.worker, a.tenantId, (c) => enqueueOutbox(c, { kind: "client.send", tenantId: b.tenantId, idempotencyKey: randomUUID(), traceId: "t", payload: {} })),
      /row-level security/,
    );
  });
});

describe("OutboxDispatcher", () => {
  it("delivers a row once, passing the idempotency key, payload and attempt", async () => {
    const t = await createTenant(db.owner);
    const { id, key } = await addRow(t.tenantId);
    const seen: { key: string; attempt: number; traceId?: string; ticketId: unknown }[] = [];
    await dispatcher(registryWith(async (i) => { seen.push({ key: i.idempotencyKey, attempt: i.attempt, traceId: i.traceId, ticketId: i.payload["ticketId"] }); })).runOnce();
    assert.deepEqual(seen, [{ key, attempt: 1, traceId: "trace-1", ticketId: "k1" }]);
    const r = await row(id);
    assert.equal(r.status, "done");
    assert.equal(r.attempts, 1);
    assert.equal(r.locked_by, null);
  });

  it("three racing dispatchers handle each row exactly once and never concurrently", async () => {
    const t = await createTenant(db.owner);
    const ids = await Promise.all(Array.from({ length: 12 }, () => addRow(t.tenantId).then((r) => r.id)));
    const counts = new Map<string, number>();
    const inFlight = new Set<string>();
    let overlap = false;
    const handler: OutboxHandler = async (i) => {
      if (inFlight.has(i.outboxId)) overlap = true;
      inFlight.add(i.outboxId);
      await new Promise((r) => setTimeout(r, 10));
      counts.set(i.outboxId, (counts.get(i.outboxId) ?? 0) + 1);
      inFlight.delete(i.outboxId);
    };
    const ds = [1, 2, 3].map(() => dispatcher(registryWith(handler), { batchSize: 12 }));
    await Promise.all(ds.map((d) => d.runOnce()));
    assert.equal(overlap, false);
    assert.deepEqual([...counts.values()].sort(), ids.map(() => 1));
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM outbox WHERE id = ANY($1) AND status = 'done'", [ids])).rows[0].n, 12);
  });

  it("retries with increasing delays and stops after the attempt budget", async () => {
    const t = await createTenant(db.owner);
    const { id } = await addRow(t.tenantId);
    let calls = 0;
    // Wide delays (150 ms, then 300 ms) so the comparison below cannot be disturbed by query latency.
    const d = dispatcher(registryWith(async () => { calls++; throw new Error("boom"); }), { backoffBaseMs: 150, backoffMaxMs: 1000 });
    await d.runOnce();
    const first = await row(id);
    assert.equal(first.status, "pending");
    assert.equal(first.attempts, 1);
    assert.equal(first.last_error, "boom");
    assert.equal(await d.runOnce(), 0, "not due yet: backoff must hold the row back");
    await waitFor(async () => (await d.runOnce()) === 1);
    const second = await row(id);
    assert.equal(second.attempts, 2);
    assert.equal(second.status, "pending");
    assert.ok(second.delay > first.delay + 0.08, `delay should grow: ${first.delay} -> ${second.delay}`);
    await waitFor(async () => (await d.runOnce()) === 1);
    const last = await row(id);
    assert.equal(last.status, "failed");
    assert.equal(last.attempts, 3);
    assert.equal(calls, 3);
    assert.equal(await d.runOnce(), 0, "a failed row is never picked up again");
  });

  it("jitters the retry delay inside [step/2, step] when no random source is injected", async () => {
    const t = await createTenant(db.owner);
    const ids = await Promise.all(Array.from({ length: 6 }, () => addRow(t.tenantId)));
    // Real Math.random: a 10 s step must land the next attempt between ~5 s and ~10 s away.
    await dispatcher(registryWith(async () => { throw new Error("boom"); }), { backoffBaseMs: 10_000, backoffMaxMs: 60_000, random: Math.random, batchSize: 6 }).runOnce();
    for (const { id } of ids) {
      const r = await row(id);
      assert.equal(r.status, "pending");
      assert.ok(r.delay > 4.5 && r.delay <= 10.1, `delay ${r.delay} outside the jitter window`);
    }
  });

  it("holds a rate-limited row back at least as long as the remote asked", async () => {
    const t = await createTenant(db.owner);
    const { id } = await addRow(t.tenantId);
    // Backoff alone would be ~40 ms; the error asks for 30 s.
    await dispatcher(registryWith(async () => { throw Object.assign(new Error("rate limited"), { code: "rate_limited", retryAfterMs: 30_000 }); })).runOnce();
    const r = await row(id);
    assert.equal(r.status, "pending");
    assert.ok(r.delay > 28 && r.delay <= 30.5, `delay ${r.delay} should honour the 30 s hint`);
  });

  it("a permanent failure fails the row immediately", async () => {
    const t = await createTenant(db.owner);
    const { id } = await addRow(t.tenantId);
    await dispatcher(registryWith(async () => { throw new PermanentFailureError("nope", "bad"); })).runOnce();
    const r = await row(id);
    assert.equal(r.status, "failed");
    assert.equal(r.attempts, 1);
  });

  it("recovers a row stuck in processing after a crash, but leaves a fresh lease alone", async () => {
    const t = await createTenant(db.owner);
    const stale = (await addRow(t.tenantId)).id;
    const fresh = (await addRow(t.tenantId)).id;
    await db.owner.query("UPDATE outbox SET status='processing', attempts=1, locked_at = now() - interval '10 minutes', locked_by = $2 WHERE id = $1", [stale, randomUUID()]);
    await db.owner.query("UPDATE outbox SET status='processing', attempts=1, locked_at = now(), locked_by = $2 WHERE id = $1", [fresh, randomUUID()]);
    const attempts: number[] = [];
    await dispatcher(registryWith(async (i) => { attempts.push(i.attempt); })).runOnce();
    assert.deepEqual(attempts, [2]);
    assert.equal((await row(stale)).status, "done");
    assert.equal((await row(fresh)).status, "processing");
  });

  it("a row that keeps crashing its dispatcher is failed without running the handler", async () => {
    const t = await createTenant(db.owner);
    const { id } = await addRow(t.tenantId);
    await db.owner.query("UPDATE outbox SET status='processing', attempts=3, locked_at = now() - interval '10 minutes', locked_by = $2 WHERE id = $1", [id, randomUUID()]);
    let calls = 0;
    await dispatcher(registryWith(async () => { calls++; })).runOnce();
    assert.equal(calls, 0);
    const r = await row(id);
    assert.equal(r.status, "failed");
    assert.equal(r.last_error, "max_attempts_exceeded");
  });

  it("a dispatcher that lost its lease cannot overwrite the new owner's result", async () => {
    const t = await createTenant(db.owner);
    const { id } = await addRow(t.tenantId);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = dispatcher(registryWith(async () => { await gate; }), { leaseSeconds: 1 });
    const slowRun = slow.runOnce();
    await waitFor(async () => (await row(id)).status === "processing");
    await db.owner.query("UPDATE outbox SET locked_at = now() - interval '5 minutes' WHERE id = $1", [id]);
    await dispatcher(registryWith(async () => {})).runOnce(); // takes over and finishes
    assert.equal((await row(id)).status, "done");
    const winner = (await row(id)).attempts;
    release();
    await slowRun;
    const r = await row(id);
    assert.equal(r.status, "done");
    assert.equal(r.attempts, winner);
  });

  it("the default skeleton handlers complete the row with a visible note and a log line", async () => {
    const t = await createTenant(db.owner);
    const ids = await Promise.all((["github.create_issue", "switch.create_room", "client.send"] as OutboxKind[]).map((k) => addRow(t.tenantId, k).then((r) => r.id)));
    const logs: object[] = [];
    await dispatcher(createDefaultOutboxRegistry((e) => logs.push(e))).runOnce();
    for (const id of ids) {
      const r = await row(id);
      assert.equal(r.status, "done");
      assert.equal(r.last_error, NOOP_NOTE);
    }
    assert.equal(logs.filter((l) => (l as { event: string }).event === "outbox_noop").length, 3);
  });

  it("fails a row whose kind has no handler registered", async () => {
    const t = await createTenant(db.owner);
    const { id } = await addRow(t.tenantId, "client.send");
    await dispatcher(registryWith(async () => {})).runOnce();
    assert.equal((await row(id)).last_error, "no_handler_registered");
  });

  it("serves several tenants, as the non-superuser worker role", async () => {
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const rows = [(await addRow(a.tenantId)).id, (await addRow(b.tenantId)).id];
    const tenants: string[] = [];
    const logs: OutboxLogEvent[] = [];
    await dispatcher(registryWith(async (i) => { tenants.push(i.tenantId); }), {}, logs).runOnce();
    assert.deepEqual(tenants.sort(), [a.tenantId, b.tenantId].sort());
    for (const id of rows) assert.equal((await row(id)).status, "done");
    assert.equal((await db.worker.query("SELECT current_user AS u")).rows[0].u, "relay_worker");
    assert.ok(!JSON.stringify(logs).includes("ticketId"));
  });

  it("start() polls on its own and close() waits for the handler in flight", async () => {
    const t = await createTenant(db.owner);
    const { id } = await addRow(t.tenantId);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    const d = dispatcher(registryWith(async () => { started = true; await gate; }));
    d.start();
    await waitFor(() => started);
    let closed = false;
    const closing = d.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal((await row(id)).status, "done");
  });
});
