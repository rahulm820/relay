import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  Orchestrator, OutboxDispatcher, QueueProducer, Redis, createDefaultOutboxRegistry, createDefaultStageRegistry, ticketStage,
} from "@relay/core";
import { createMessage, createTenant, createTestDb, flushQueueKeys, waitFor, TEST_REDIS_URL, type TestDb } from "@relay/core/testing";
import { Secret } from "@relay/shared";
import { SwitchClient, createSwitchRoomHandler } from "./index.js";
import { MockSwitch } from "./testing/mock-switch.js";

const MARKER = "PERSONAL-DATA-MARKER";
let db: TestDb;
let redis: Redis;
let mock: MockSwitch;

before(async () => { db = await createTestDb(); redis = new Redis(TEST_REDIS_URL); mock = new MockSwitch(); await mock.start(); });
after(async () => { await redis.quit(); await mock.stop(); await db.dispose(); });
beforeEach(async () => { await flushQueueKeys(redis); });

describe("webhook-style ingest -> orchestrator -> ticket -> outbox -> dispatcher -> Switch", () => {
  it("ends with one room, one kickoff and the ticket linked, even when the message is ingested twice", async () => {
    const admin = new SwitchClient({ gatewayUrl: mock.gatewayUrl, email: mock.email, password: new Secret(mock.password) });
    await admin.registerAgent({ name: "relay-triager", description: "d", displayName: "T" });
    const key = (await admin.registerAgent({ name: "relay-notifier", description: "d", displayName: "N" })).apiKey;
    mock.knownUsers.add("pat.pm");

    const t = await createTenant(db.owner);
    await db.owner.query("INSERT INTO members (tenant_id, name, role, chat_handle) VALUES ($1,'Pat','pm','pat.pm')", [t.tenantId]);
    const messageId = await createMessage(db.owner, t, `checkout is broken ${MARKER}`);

    // The default extractor is the placeholder (#7 not merged), so the ticket arrives quarantined "Needs human triage".
    const stages = createDefaultStageRegistry();
    stages.register("ticket", ticketStage());
    const logs: unknown[] = [];
    const orchestrator = new Orchestrator({
      pool: db.worker, redis, stages, log: () => undefined,
      consumer: { blockMs: 30, maxAttempts: 3, backoffBaseMs: 5, backoffMaxMs: 20, minIdleMs: 500, reclaimIntervalMs: 50 },
    });
    const registry = createDefaultOutboxRegistry(() => undefined);
    registry.register("switch.create_room", createSwitchRoomHandler({
      pool: db.worker, missing: [], triagerAgent: "relay-triager", notifierAgent: "relay-notifier", log: (e) => logs.push(e),
      client: new SwitchClient({ gatewayUrl: mock.gatewayUrl, email: mock.email, password: new Secret(mock.password), notifier: { name: "relay-notifier", apiKey: key } }),
    }));
    const dispatcher = new OutboxDispatcher({ pool: db.worker, registry, pollIntervalMs: 15, backoffBaseMs: 20, log: () => undefined });
    await orchestrator.start();
    dispatcher.start();
    try {
      const producer = new QueueProducer(redis);
      const envelope = { stage: "ingest" as const, tenantId: t.tenantId, conversationId: t.conversationId, traceId: "e2e", payload: { messageId } };
      await producer.enqueue(envelope);
      await producer.enqueue(envelope); // the same message ingested again (redelivery)

      await waitFor(async () => (await db.owner.query("SELECT switch_room_ref FROM tickets WHERE source_message_id = $1", [messageId])).rows[0]?.switch_room_ref != null);
      await waitFor(() => mock.messages.length >= 1);
      await waitFor(async () => (await db.owner.query("SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND status = 'done'", [t.tenantId])).rows[0].n === 2);

      const ticket = (await db.owner.query("SELECT id, status, switch_room_ref FROM tickets WHERE source_message_id = $1", [messageId])).rows;
      assert.equal(ticket.length, 1);
      assert.equal(ticket[0].status, "quarantined");
      assert.equal(mock.rooms.length, 1, "exactly one room");
      assert.equal(mock.rooms[0]!.id, ticket[0].switch_room_ref);
      assert.deepEqual(mock.rooms[0]!.users, ["pat.pm"]);
      assert.equal(mock.messages.length, 1, "exactly one kickoff");
      assert.ok(mock.messages[0]!.content.includes("Owner: @pat.pm"));
      assert.ok(!JSON.stringify([mock.requests.map((r) => r.body), mock.messages, logs]).includes(MARKER));
      const outbox = (await db.owner.query("SELECT kind, status, last_error FROM outbox WHERE tenant_id = $1 ORDER BY kind", [t.tenantId])).rows;
      assert.equal(outbox.find((o) => o.kind === "switch.create_room").last_error, null, "the real handler ran, not the no-op");
      assert.equal(await redis.xlen("q.dlq"), 0);
    } finally {
      await dispatcher.close();
      await orchestrator.close();
    }
  });
});
