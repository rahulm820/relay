import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { PIPELINE_STAGES, type ExtractFn, type PipelineStage, type QueueStage } from "@relay/shared";
import { Redis } from "ioredis";
import { DLQ_STREAM, PermanentFailureError, QueueProducer, listDeadLetters, streamKey, type QueueLogEvent } from "../queue/index.js";
import {
  createMessage, createTenant, createTestDb, flushQueueKeys, waitFor, TEST_REDIS_URL, type TestDb, type TestTenant,
} from "../testing/fixtures.js";
import { Orchestrator, createDefaultStageRegistry, type OrchestratorLogEvent, type StageRegistry } from "./index.js";

let db: TestDb;
let redis: Redis;
let producer: QueueProducer;
let orchestrators: Orchestrator[] = [];
let logs: (OrchestratorLogEvent | QueueLogEvent)[] = [];

const stubExtract: ExtractFn = async () => ({
  kind: "extracted", language: "en", is_complaint: true, off_topic: false, issues: [],
  contains_sensitive_data: false, sentiment: "neutral", confidence: 0.9, missing_info: [],
});

before(async () => {
  db = await createTestDb();
  redis = new Redis(TEST_REDIS_URL);
  producer = new QueueProducer(redis);
});

after(async () => {
  await redis.quit();
  await db.dispose();
});

beforeEach(async () => {
  orchestrators = [];
  logs = [];
  await flushQueueKeys(redis);
});

afterEach(async () => {
  await Promise.all(orchestrators.map((o) => o.close()));
  await flushQueueKeys(redis);
});

async function start(stages: StageRegistry, stageTimeoutMs = 2000): Promise<Orchestrator> {
  const o = new Orchestrator({
    pool: db.worker, redis, stages, stageTimeoutMs, log: (e) => logs.push(e),
    consumer: { blockMs: 30, maxAttempts: 3, backoffBaseMs: 5, backoffMaxMs: 20, minIdleMs: 500, reclaimIntervalMs: 50 },
  });
  orchestrators.push(o);
  await o.start();
  return o;
}

/** Wraps every stage so tests can see what ran and in which order. */
function recording(registry: StageRegistry): { calls: PipelineStage[] } {
  const calls: PipelineStage[] = [];
  for (const stage of PIPELINE_STAGES) {
    const inner = registry.get(stage)!;
    registry.register(stage, async (ctx) => { calls.push(stage); return inner(ctx); });
  }
  return { calls };
}

const ingest = (t: TestTenant, messageId: string, stage: QueueStage = "ingest") =>
  producer.enqueue({ stage, tenantId: t.tenantId, conversationId: t.conversationId, traceId: `trace-${messageId.slice(0, 8)}`, payload: { messageId } });

const run = async (messageId: string) =>
  (await db.owner.query("SELECT status, current_stage, stage_results, stop_reason FROM pipeline_runs WHERE message_id = $1", [messageId])).rows[0];
const completed = (messageId: string) => async () => (await run(messageId))?.status === "completed";
const dlqCodes = async () => (await listDeadLetters(redis)).map((d) => d.errorCode);

describe("pipeline", () => {
  it("a message flows through every stage in order and ends in the expected state", async () => {
    const registry = createDefaultStageRegistry({ extract: stubExtract });
    const { calls } = recording(registry);
    await start(registry);
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    await ingest(t, messageId);
    await waitFor(completed(messageId));
    assert.deepEqual(calls, [...PIPELINE_STAGES]);
    const r = await run(messageId);
    assert.deepEqual(Object.keys(r.stage_results).sort(), [...PIPELINE_STAGES].sort()); // jsonb does not keep key order
    assert.equal(r.stage_results.extract.kind, "extracted");
    assert.equal(r.current_stage, "notify");
    assert.equal(await redis.xlen(DLQ_STREAM), 0);
    for (const stage of ["ingest", ...PIPELINE_STAGES] as QueueStage[]) await waitFor(async () => (await redis.xlen(streamKey(stage))) === 0);
  });

  it("the default extractor placeholder yields a typed fallback and the run still completes", async () => {
    await start(createDefaultStageRegistry());
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    await ingest(t, messageId);
    await waitFor(completed(messageId));
    assert.equal((await run(messageId)).stage_results.extract.kind, "fallback");
  });

  it("re-delivering the envelope creates no duplicates and re-runs no stage", async () => {
    const registry = createDefaultStageRegistry({ extract: stubExtract });
    const { calls } = recording(registry);
    await start(registry);
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    await ingest(t, messageId);
    await waitFor(completed(messageId));
    await ingest(t, messageId);
    await ingest(t, messageId, "notify");
    await waitFor(() => logs.filter((l) => "event" in l && l.event === "stage_skipped").length >= 2);
    assert.deepEqual(calls, [...PIPELINE_STAGES]);
    const n = await db.owner.query("SELECT count(*)::int AS n FROM pipeline_runs WHERE message_id = $1", [messageId]);
    assert.equal(n.rows[0].n, 1);
  });

  it("resumes after a crash without recomputing stored stages", async () => {
    const registry = createDefaultStageRegistry({ extract: stubExtract });
    const { calls } = recording(registry);
    await start(registry);
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    // State a crashed worker left behind: extract and dedupe done, run still open.
    await db.owner.query(
      `INSERT INTO pipeline_runs (tenant_id, message_id, conversation_id, trace_id, stage_results, current_stage)
       VALUES ($1,$2,$3,'t', '{"extract":{"kind":"extracted"},"dedupe":{"noop":true}}', 'dedupe')`,
      [t.tenantId, messageId, t.conversationId],
    );
    await ingest(t, messageId, "dedupe"); // redelivery of the last finished stage
    await waitFor(completed(messageId));
    assert.deepEqual(calls, ["priority", "ticket", "github-sync", "switch", "notify"]);
  });

  it("a failing stage is retried and then succeeds", async () => {
    const registry = createDefaultStageRegistry({ extract: stubExtract });
    const attempts: number[] = [];
    registry.register("ticket", async (ctx) => {
      attempts.push(ctx.attempt);
      if (ctx.attempt < 3) throw new Error("transient");
      return { result: { ok: true } };
    });
    await start(registry);
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    await ingest(t, messageId);
    await waitFor(completed(messageId));
    assert.deepEqual(attempts, [1, 2, 3]);
    assert.equal(await redis.xlen(DLQ_STREAM), 0);
  });

  it("a permanent failure ends in the DLQ and later stages do not run", async () => {
    const registry = createDefaultStageRegistry({ extract: stubExtract });
    const { calls } = recording(registry);
    registry.register("priority", async () => { throw new PermanentFailureError("bad input", "bad_input"); });
    await start(registry);
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    await ingest(t, messageId);
    await waitFor(async () => (await redis.xlen(DLQ_STREAM)) === 1);
    const [dl] = await listDeadLetters(redis);
    assert.equal(dl?.stage, "priority");
    assert.equal(dl?.errorCode, "bad_input");
    assert.equal((await run(messageId)).status, "running");
    assert.ok(!calls.includes("ticket"));
  });

  it("a stage can stop the pipeline", async () => {
    const registry = createDefaultStageRegistry({ extract: stubExtract });
    registry.register("dedupe", async () => ({ result: { duplicateOf: "x" }, stop: "duplicate" }));
    const { calls } = recording(registry);
    await start(registry);
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    await ingest(t, messageId);
    await waitFor(completed(messageId));
    assert.deepEqual(calls, ["extract", "dedupe"]);
    assert.equal((await run(messageId)).stop_reason, "duplicate");
  });

  it("a stage that hangs is aborted at the timeout and retried", async () => {
    const registry = createDefaultStageRegistry({ extract: stubExtract });
    const aborted: boolean[] = [];
    registry.register("switch", async (ctx) => {
      if (ctx.attempt === 1) {
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => { aborted.push(true); resolve(); }));
        return { result: {} }; // abandoned: the timeout already won
      }
      return { result: { ok: true } };
    });
    await start(registry, 60);
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    await ingest(t, messageId);
    await waitFor(completed(messageId));
    assert.deepEqual(aborted, [true]);
  });

  it("dead-letters a missing message and a message of another tenant", async () => {
    await start(createDefaultStageRegistry({ extract: stubExtract }));
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    const messageOfA = await createMessage(db.owner, a);
    await ingest(b, messageOfA); // tenant B's job pointing at tenant A's message
    await ingest(a, randomUUID());
    await waitFor(async () => (await redis.xlen(DLQ_STREAM)) === 2);
    assert.deepEqual(await dlqCodes(), ["message_not_found", "message_not_found"]);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM pipeline_runs WHERE tenant_id = ANY($1)", [[a.tenantId, b.tenantId]])).rows[0].n, 0);
  });

  it("dead-letters a payload without a messageId and a message without redacted text", async () => {
    await start(createDefaultStageRegistry({ extract: stubExtract }));
    const t = await createTenant(db.owner);
    await producer.enqueue({ stage: "ingest", tenantId: t.tenantId, conversationId: "c", traceId: "x", payload: { nope: 1 } });
    const messageId = await createMessage(db.owner, t, null);
    await ingest(t, messageId);
    await waitFor(async () => (await redis.xlen(DLQ_STREAM)) === 2);
    assert.deepEqual((await dlqCodes()).sort(), ["invalid_payload", "no_redacted_text"]);
  });

  it("stages see only their own tenant's rows and the worker is not a superuser", async () => {
    const a = await createTenant(db.owner);
    const b = await createTenant(db.owner);
    for (const t of [a, b]) {
      await db.owner.query("INSERT INTO tickets (tenant_id, title, category, priority) VALUES ($1,'t','bug','P3')", [t.tenantId]);
    }
    const seen: { n: number; user: string; rolsuper: boolean }[] = [];
    const registry = createDefaultStageRegistry({ extract: stubExtract });
    registry.register("ticket", async (ctx) => {
      seen.push(await ctx.db(async (c) => {
        const n = (await c.query("SELECT count(*)::int AS n FROM tickets")).rows[0].n;
        const who = (await c.query("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s")).rows[0];
        return { n, user: who.u, rolsuper: who.s };
      }));
      return { result: {} };
    });
    await start(registry);
    const messageId = await createMessage(db.owner, a);
    await ingest(a, messageId);
    await waitFor(completed(messageId));
    assert.deepEqual(seen, [{ n: 1, user: "relay_worker", rolsuper: false }]);
  });

  it("close() lets the in-flight stage finish and store its result", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    const registry = createDefaultStageRegistry({ extract: stubExtract });
    registry.register("dedupe", async () => { started = true; await gate; return { result: { done: true } }; });
    const o = await start(registry);
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t);
    await ingest(t, messageId);
    await waitFor(() => started);
    let closed = false;
    const closing = o.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(closed, false);
    release();
    await closing;
    assert.deepEqual((await run(messageId)).stage_results.dedupe, { done: true });
  });

  it("logs never contain message text", async () => {
    await start(createDefaultStageRegistry({ extract: stubExtract }));
    const t = await createTenant(db.owner);
    const messageId = await createMessage(db.owner, t, "PERSONAL-DATA-MARKER card 4111");
    await ingest(t, messageId);
    await waitFor(completed(messageId));
    assert.ok(logs.length > 0);
    assert.ok(!JSON.stringify(logs).includes("PERSONAL-DATA-MARKER"));
  });
});
