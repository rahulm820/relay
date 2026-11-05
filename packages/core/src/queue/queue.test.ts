import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { QueueEnvelope, QueueStage } from "@relay/shared";
import { Redis } from "ioredis";
import {
  DLQ_STREAM, IdempotencyCache, PermanentFailureError, QueueConsumer, QueueProducer,
  listDeadLetters, queueStats, replayDeadLetter, streamKey,
  type ConsumerOptions, type QueueLogEvent,
} from "./index.js";

// Needs a real Redis: docker run -d --rm --name relay-redis-test -p 127.0.0.1:6380:6379 redis:7
const URL = process.env["TEST_REDIS_URL"] ?? "redis://127.0.0.1:6380";
const STAGE: QueueStage = "extract";

let redis: Redis;
let producer: QueueProducer;
let consumers: QueueConsumer[] = [];
let logs: QueueLogEvent[] = [];

const env = (n: number, conversationId = "conv-1", stage: QueueStage = STAGE): QueueEnvelope => ({
  stage, tenantId: "tenant-1", conversationId, traceId: `trace-${n}`, payload: { n },
});

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function startConsumer(opts: Partial<ConsumerOptions> & Pick<ConsumerOptions, "handler">): Promise<QueueConsumer> {
  const c = new QueueConsumer(redis, {
    stage: STAGE, blockMs: 30, maxAttempts: 3, backoffBaseMs: 5, backoffMaxMs: 20,
    minIdleMs: 500, reclaimIntervalMs: 20, log: (e) => logs.push(e), ...opts,
  });
  consumers.push(c);
  await c.start();
  return c;
}

async function cleanup(): Promise<void> {
  const keys = [...(await redis.keys("q:*")), ...(await redis.keys("idem:*")), DLQ_STREAM];
  if (keys.length) await redis.del(...keys);
}

beforeEach(async () => {
  redis = new Redis(URL);
  producer = new QueueProducer(redis);
  consumers = [];
  logs = [];
  await cleanup();
});

afterEach(async () => {
  await Promise.all(consumers.map((c) => c.close()));
  await cleanup();
  await redis.quit();
});

describe("queue", () => {
  it("enqueue -> consume -> ack leaves nothing pending", async () => {
    const seen: number[] = [];
    await startConsumer({ handler: async (e) => { seen.push(e.payload["n"] as number); } });
    await producer.enqueue(env(1));
    await waitFor(() => seen.length === 1);
    await waitFor(async () => (await queueStats(redis, STAGE)).length === 0);
    assert.deepEqual(await queueStats(redis, STAGE), { length: 0, pending: 0, deadLetters: 0 });
  });

  it("enqueue validates the envelope and adds nothing when invalid", async () => {
    await assert.rejects(producer.enqueue({ ...env(1), tenantId: "" }));
    assert.equal(await redis.xlen(streamKey(STAGE)), 0);
  });

  it("the same idempotency key is processed once", async () => {
    let calls = 0;
    const a = await producer.enqueue(env(1), { idempotencyKey: "tg:1:100" });
    const b = await producer.enqueue(env(1), { idempotencyKey: "tg:1:100" });
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(b.entryId, a.entryId);
    await producer.enqueue(env(2)); // no key: always enqueued
    await startConsumer({ handler: async () => { calls++; } });
    await waitFor(() => calls === 2);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls, 2);
  });

  it("IdempotencyCache: second claim is a no-op until released", async () => {
    const cache = new IdempotencyCache(redis);
    assert.equal(await cache.claim("k", 10), true);
    assert.equal(await cache.claim("k", 10), false);
    await cache.release("k");
    assert.equal(await cache.claim("k", 10), true);
    await cache.release("k");
  });

  it("a failing handler is retried and then succeeds", async () => {
    const attempts: number[] = [];
    await startConsumer({
      handler: async (_e, ctx) => { attempts.push(ctx.attempt); if (ctx.attempt < 3) throw new Error("flaky"); },
    });
    await producer.enqueue(env(1));
    await waitFor(async () => (await queueStats(redis, STAGE)).length === 0);
    assert.deepEqual(attempts, [1, 2, 3]);
    assert.equal(await redis.xlen(DLQ_STREAM), 0);
  });

  it("a poison message is dead-lettered after max attempts and does not block the queue", async () => {
    const good: number[] = [];
    await startConsumer({
      handler: async (e) => { if (e.payload["n"] === 1) throw new Error("boom"); good.push(e.payload["n"] as number); },
    });
    await producer.enqueue(env(1), { idempotencyKey: "poison" });
    await producer.enqueue(env(2));
    await waitFor(() => good.length === 1);
    assert.deepEqual(good, [2]);
    const [dl] = await listDeadLetters(redis);
    assert.ok(dl);
    assert.equal(dl.stage, STAGE);
    assert.equal(dl.attempts, 3);
    assert.equal(dl.errorCode, "handler_error");
    assert.equal(dl.errorMessage, "boom");
    assert.equal(dl.idempotencyKey, "poison");
    assert.equal(JSON.parse(dl.envelope).traceId, "trace-1");
    assert.ok(!Number.isNaN(Date.parse(dl.failedAt)));
    assert.deepEqual(await queueStats(redis, STAGE), { length: 0, pending: 0, deadLetters: 1 });
  });

  it("PermanentFailureError goes straight to the DLQ", async () => {
    let calls = 0;
    await startConsumer({ handler: async () => { calls++; throw new PermanentFailureError("nope", "bad_input"); } });
    await producer.enqueue(env(1));
    await waitFor(async () => (await redis.xlen(DLQ_STREAM)) === 1);
    const [dl] = await listDeadLetters(redis);
    assert.equal(calls, 1);
    assert.equal(dl?.errorCode, "bad_input");
    assert.equal(dl?.attempts, 1);
  });

  it("malformed entries are dead-lettered without crashing the loop", async () => {
    const good: number[] = [];
    await startConsumer({ handler: async (e) => { good.push(e.payload["n"] as number); } });
    await redis.xadd(streamKey(STAGE), "*", "data", "{not json");
    await redis.xadd(streamKey(STAGE), "*", "data", JSON.stringify({ stage: STAGE, tenantId: 5 }));
    await redis.xadd(streamKey(STAGE), "*", "data", JSON.stringify(env(9, "c", "notify"))); // wrong stream
    await producer.enqueue(env(2));
    await waitFor(() => good.length === 1);
    await waitFor(async () => (await redis.xlen(DLQ_STREAM)) === 3);
    const codes = (await listDeadLetters(redis)).map((d) => d.errorCode);
    assert.deepEqual(codes, ["malformed_entry", "invalid_envelope", "stage_mismatch"]);
    assert.equal((await queueStats(redis, STAGE)).pending, 0);
  });

  it("an entry read but never acked is reclaimed by another consumer after min-idle", async () => {
    await redis.xgroup("CREATE", streamKey(STAGE), "extract-workers", "0", "MKSTREAM");
    await producer.enqueue(env(1));
    // A "crashed" consumer: reads the entry and never acks.
    await redis.xreadgroup("GROUP", "extract-workers", "dead-consumer", "COUNT", 1, "STREAMS", streamKey(STAGE), ">");
    assert.equal((await queueStats(redis, STAGE)).pending, 1);
    const seen: number[] = [];
    await startConsumer({ minIdleMs: 100, handler: async (_e, ctx) => { seen.push(ctx.attempt); } });
    await waitFor(() => seen.length === 1);
    assert.deepEqual(seen, [2]); // the crashed delivery counts as attempt 1
    await waitFor(async () => (await queueStats(redis, STAGE)).pending === 0);
  });

  it("two consumers in one group never process the same entry", async () => {
    const processed = new Map<string, string>();
    const inFlight = new Set<string>();
    let overlap = false;
    const make = (name: string) => startConsumer({
      consumerName: name,
      handler: async (e, ctx) => {
        if (inFlight.has(ctx.entryId)) overlap = true;
        inFlight.add(ctx.entryId);
        await new Promise((r) => setTimeout(r, 5));
        processed.set(`${e.payload["n"]}`, `${name}`);
        inFlight.delete(ctx.entryId);
      },
    });
    await make("c-a");
    await make("c-b");
    for (let n = 0; n < 20; n++) await producer.enqueue(env(n, `conv-${n}`));
    await waitFor(() => processed.size === 20);
    await waitFor(async () => (await queueStats(redis, STAGE)).length === 0);
    assert.equal(overlap, false);
    assert.equal(processed.size, 20);
  });

  it("messages of one conversation are handled in order by a consumer", async () => {
    const order: number[] = [];
    await startConsumer({ handler: async (e) => { order.push(e.payload["n"] as number); } });
    for (let n = 0; n < 8; n++) await producer.enqueue(env(n));
    await waitFor(() => order.length === 8);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("a failing message holds back later ones of the same conversation until it succeeds", async () => {
    const order: string[] = [];
    await startConsumer({
      handler: async (e, ctx) => {
        if (e.payload["n"] === 1 && ctx.attempt < 2) throw new Error("once");
        order.push(`${e.payload["n"]}`);
      },
    });
    await producer.enqueue(env(1));
    await producer.enqueue(env(2));
    await waitFor(() => order.length === 2);
    assert.deepEqual(order, ["1", "2"]);
  });

  it("close() lets the in-flight handler finish and ack", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    let finished = false;
    const c = await startConsumer({ handler: async () => { started = true; await gate; finished = true; } });
    await producer.enqueue(env(1));
    await waitFor(() => started);
    let closed = false;
    const closing = c.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(closed, false, "close must wait for the in-flight handler");
    release();
    await closing;
    assert.equal(finished, true);
    assert.deepEqual(await queueStats(redis, STAGE), { length: 0, pending: 0, deadLetters: 0 });
  });

  it("replayDeadLetter re-enqueues the original envelope", async () => {
    let fail = true;
    const seen: number[] = [];
    await startConsumer({ handler: async (e) => { if (fail) throw new Error("x"); seen.push(e.payload["n"] as number); } });
    await producer.enqueue(env(7));
    await waitFor(async () => (await redis.xlen(DLQ_STREAM)) === 1);
    fail = false;
    const [dl] = await listDeadLetters(redis);
    await replayDeadLetter(redis, dl!.id);
    await waitFor(() => seen.length === 1);
    assert.deepEqual(seen, [7]);
    assert.equal(await redis.xlen(DLQ_STREAM), 0);
  });

  it("log lines never contain payloads", async () => {
    await startConsumer({ handler: async (e) => { if (e.payload["n"] === 1) throw new Error("fail"); } });
    await producer.enqueue({ ...env(1), payload: { n: 1, text: "PERSONAL-DATA-MARKER" } });
    await waitFor(async () => (await redis.xlen(DLQ_STREAM)) === 1);
    assert.ok(logs.length > 0);
    assert.ok(!JSON.stringify(logs).includes("PERSONAL-DATA-MARKER"));
  });

  it("rejects a minIdleMs shorter than the retry backoff budget", () => {
    assert.throws(() => new QueueConsumer(redis, { stage: STAGE, handler: async () => {}, maxAttempts: 5, backoffBaseMs: 100, minIdleMs: 200 }), /minIdleMs/);
  });
});
