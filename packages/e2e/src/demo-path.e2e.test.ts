// End to end, black box: the REAL API and worker processes (built dist) against real Postgres and Redis, with every
// external system (Telegram, the LLM, GitHub, Switch) replaced by a local mock at the network boundary.
//
//   client writes to the bot -> Telegram webhook -> queue -> LLM classification -> ticket -> GitHub issue
//   -> Switch room -> acknowledgement to the client -> operator changes the status -> update to the client
//
// Tests wait for state (polling the database or a mock), never for a fixed time. "Did not happen" checks use a barrier:
// a later message from the same client is processed strictly after the earlier work (per-conversation ordering), so once
// it has been answered, anything the earlier message could still have caused has already happened.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Redis } from "@relay/core";
import { TEST_REDIS_URL, createTestDb, flushQueueKeys, waitFor as pollUntil, type TestDb } from "@relay/core/testing";
import { E2E_BOT_TOKEN, E2E_ENCRYPTION_KEY, E2E_GITHUB_TOKEN, E2E_LLM_KEY, startStack, type Stack } from "./harness/stack.js";
import { startMocks, type Mocks } from "./harness/mocks.js";
import { REPO, createWorkspace, e2eRedisUrl, postUpdate, signIn, telegramUpdate, type Workspace } from "./harness/workspace.js";

const EMAIL = "jane.doe@example.com";
const COMPLAINT = `Hi, my checkout fails with an error 500 when I tap Pay now. You can reach me at ${EMAIL}`;
const SECOND_COMPLAINT = "The checkout page also hangs when I tap Pay now on my phone";
const WAIT = 20_000;

let db: TestDb;
let mocks: Mocks;
let stack: Stack;
let redis: Redis;
let stopped = false;

before(async () => {
  db = await createTestDb();
  mocks = await startMocks();
  redis = new Redis(e2eRedisUrl(TEST_REDIS_URL));
  await flushQueueKeys(redis);
  stack = await startStack({ db, mocks, redisUrl: e2eRedisUrl(TEST_REDIS_URL) });
});
after(async () => {
  if (!stopped) await stack.stop();
  await mocks.stop();
  await flushQueueKeys(redis);
  await redis.quit();
  await db.dispose();
});
beforeEach(async () => {
  // Start every test from a quiet system, so work left over from the previous test (a late acknowledgement, a room still
  // being created) cannot land in this one and be mistaken for its own.
  await waitFor(async () => (await count("SELECT 1 FROM pipeline_runs WHERE status <> 'completed'", [])) === 0 && (await count("SELECT 1 FROM outbox WHERE status NOT IN ('done', 'failed')", [])) === 0, WAIT);
  mocks.reset();
});

/** waitFor that, on timeout, says what it was waiting for and shows the tail of the processes' logs (ids and codes only). */
async function waitFor(cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  try { await pollUntil(cond, ms); } catch (err) {
    throw new Error(`${(err as Error).message}: ${cond.toString().slice(0, 140)}\n--- last log lines ---\n${stack.logs().slice(-12).join("\n")}`);
  }
}

const one = async (sql: string, params: unknown[]) => (await db.owner.query(sql, params)).rows[0];
const count = async (sql: string, params: unknown[]) => (await db.owner.query(sql, params)).rowCount ?? 0;
const ticketsOf = async (w: Workspace) => (await db.owner.query("SELECT * FROM tickets WHERE tenant_id = $1 ORDER BY created_at", [w.tenantId])).rows;
const shortRef = (id: string) => `REL-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
const outboxDone = async (w: Workspace) => (await count("SELECT 1 FROM outbox WHERE tenant_id = $1 AND status <> 'done'", [w.tenantId])) === 0;
/** True once at least one row of this kind exists and every row of it is done. (Unlike outboxDone it cannot be true before the row is even queued.) */
const kindDone = async (w: Workspace, kind: string) =>
  (await count("SELECT 1 FROM outbox WHERE tenant_id = $1 AND kind = $2", [w.tenantId, kind])) > 0 && (await count("SELECT 1 FROM outbox WHERE tenant_id = $1 AND kind = $2 AND status <> 'done'", [w.tenantId, kind])) === 0;
/** Waits until a complaint has been fully handled: ticket, GitHub issue, Switch room and acknowledgement. */
async function settled(w: Workspace, tickets: number): Promise<void> {
  await waitFor(async () => (await ticketsOf(w)).length === tickets && (await outboxDone(w)) && mocks.github.issues.length >= tickets && mocks.telegram.texts.length >= tickets, WAIT);
}

describe("the demo story", () => {
  it("complaint in -> classified -> ticket -> GitHub issue -> Switch room -> ack -> status update back to the client", async () => {
    const w = await createWorkspace(db);

    // 1. The client writes to the bot; Telegram calls our webhook.
    const res = await postUpdate(stack.apiUrl, w, telegramUpdate(w, COMPLAINT));
    assert.equal(res.status, 200);
    await settled(w, 1);
    await waitFor(() => mocks.switchGateway.messages.length >= 1, WAIT);

    // 2. Classification: the real extractor ran against the (mock) model and validated its answer.
    const [ticket] = await ticketsOf(w);
    assert.equal(ticket.category, "bug");
    assert.equal(ticket.priority, "P1", "a payment failure is urgent");
    assert.ok(ticket.priority_reason);
    assert.notEqual(ticket.status, "quarantined", "a confident extraction is not held for a human");
    assert.equal(mocks.gemini.requests.length, 1);
    assert.equal(mocks.gemini.requests[0]!.model, "gemini-e2e-fast");
    assert.ok(mocks.gemini.requests[0]!.authed);
    const run = await one("SELECT model, prompt_version, confidence FROM llm_runs WHERE tenant_id = $1", [w.tenantId]);
    assert.deepEqual([run.model, run.prompt_version], ["gemini-e2e-fast", "extract.v1"]);

    // 3. The GitHub issue: exactly one, in the configured repo, carrying the ticket and its labels.
    assert.equal(mocks.github.createRequests.length, 1, "exactly one create request reached GitHub");
    assert.equal(mocks.github.issues.length, 1);
    const issue = mocks.github.issues[0]!;
    assert.equal(issue.repo, REPO);
    assert.ok(issue.body.includes(ticket.id), "the issue body carries the ticket id");
    assert.ok(issue.labels.includes("bug") && issue.labels.includes("priority:p1"), `labels: ${issue.labels}`);
    assert.ok(mocks.github.requests.every((r) => r.authed), "every GitHub call carried a token");
    const link = await one("SELECT sync_status, external_issue_number, external_issue_url FROM tracker_issues WHERE ticket_id = $1", [ticket.id]);
    assert.deepEqual([link.sync_status, link.external_issue_number], ["created", 1]);
    assert.equal(ticket.tracker_ref, `https://github.com/${REPO}/issues/1`);
    assert.equal(link.external_issue_url, ticket.tracker_ref);

    // 4. The Switch room: one room for the ticket, one kickoff message.
    assert.equal(mocks.switchGateway.rooms.length, 1);
    assert.ok(mocks.switchGateway.rooms[0]!.description.includes(ticket.id));
    assert.equal(mocks.switchGateway.messages.length, 1);
    assert.ok(mocks.switchGateway.messages[0]!.content.includes(ticket.id));
    const withRoom = await one("SELECT switch_room_ref FROM tickets WHERE id = $1", [ticket.id]);
    assert.equal(withRoom.switch_room_ref, mocks.switchGateway.rooms[0]!.id);

    // 5. The client is acknowledged, once, in their own chat.
    assert.equal(mocks.telegram.texts.length, 1);
    assert.equal(mocks.telegram.texts[0], `Thanks, we've received your report and logged it as ${shortRef(ticket.id)}. A team member will follow up here.`);
    assert.equal(String(mocks.telegram.requests[0]!.body.chat_id), w.chatId);
    assert.ok(mocks.telegram.requests[0]!.path.startsWith(`/bot${E2E_BOT_TOKEN}/`));

    // 6. An operator signs in and moves the ticket. Only the milestone is announced to the client.
    const op = await signIn(stack.apiUrl, w);
    const listed = (await (await op.get("/api/tickets")).json()) as { items: { id: string; trackerRef: string | null; switchRoomRef: string | null }[] };
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]!.trackerRef, ticket.tracker_ref, "the admin API shows the GitHub link");
    assert.equal(listed.items[0]!.switchRoomRef, mocks.switchGateway.rooms[0]!.id, "and the Switch room");

    const move = async (to: string, from: string) => {
      const r = await op.post(`/api/tickets/${ticket.id}/transition`, { to, from });
      assert.equal(r.status, 200, `${from} -> ${to}`);
    };
    await move("triaged", ticket.status);
    await move("assigned", "triaged");
    await move("in_progress", "assigned");
    await waitFor(() => mocks.telegram.texts.length >= 2, WAIT);
    assert.equal(mocks.telegram.texts[1], `Update on ${shortRef(ticket.id)}: we're now working on it.`);
    await waitFor(() => outboxDone(w), WAIT);
    assert.equal(await count("SELECT 1 FROM outbox WHERE tenant_id = $1 AND kind = 'client.send'", [w.tenantId]), 2, "the silent transitions queued nothing");
    assert.equal(mocks.telegram.texts.length, 2);

    // 7. The timeline tells the whole story.
    const detail = (await (await op.get(`/api/tickets/${ticket.id}`)).json()) as { events: { type: string }[] };
    const types = detail.events.map((e) => e.type);
    for (const t of ["created", "tracker.issue_created", "status_changed", "client_notified"]) assert.ok(types.includes(t), `timeline has ${t}: ${types}`);
    assert.equal(types.filter((t) => t === "status_changed").length, 3);

    // 8. Nothing sensitive travelled: the model, GitHub, Telegram and Switch never saw the client's email.
    const everywhere = JSON.stringify([mocks.gemini.requests, mocks.github.requests, mocks.telegram.requests, mocks.switchGateway.requests]);
    assert.ok(!everywhere.includes(EMAIL), "the client's email was redacted before it left the platform");
    const stored = await one("SELECT text_redacted, text_encrypted FROM messages WHERE tenant_id = $1 AND direction = 'in'", [w.tenantId]);
    assert.ok(!stored.text_redacted.includes(EMAIL));
    assert.ok(stored.text_encrypted, "the original is kept, encrypted");
    assert.equal(await redis.xlen("q.dlq"), 0, "nothing was dead-lettered");
  });
});

describe("duplicates and ordering", () => {
  it("the same update delivered three times at once, and again later, still means one ticket, one issue, one room, one ack", async () => {
    const w = await createWorkspace(db);
    const update = telegramUpdate(w, COMPLAINT);
    const results = await Promise.all([1, 2, 3].map(() => postUpdate(stack.apiUrl, w, update)));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200], "Telegram retries are always acknowledged");
    await settled(w, 1);
    assert.equal((await postUpdate(stack.apiUrl, w, update)).status, 200, "a late retry is acknowledged too");

    // Barrier: a second, different complaint from the same client is handled after everything above.
    assert.equal((await postUpdate(stack.apiUrl, w, telegramUpdate(w, SECOND_COMPLAINT, 2))).status, 200);
    await settled(w, 2);
    await waitFor(() => mocks.switchGateway.rooms.length >= 2, WAIT);

    const tickets = await ticketsOf(w);
    assert.equal(tickets.length, 2, "one ticket per distinct message");
    assert.equal(await count("SELECT 1 FROM messages WHERE tenant_id = $1 AND direction = 'in'", [w.tenantId]), 2);
    assert.equal(mocks.github.issues.length, 2);
    for (const t of tickets) assert.equal(mocks.github.issues.filter((i) => i.body.includes(t.id)).length, 1, "exactly one GitHub issue per ticket");
    assert.equal(mocks.github.createRequests.length, 2, "GitHub was asked to create exactly two issues");
    assert.equal(mocks.switchGateway.rooms.length, 2);
    assert.equal(mocks.telegram.texts.length, 2, "one acknowledgement per message");
    assert.equal(await redis.xlen("q.dlq"), 0);
  });

  it("an update with the wrong secret is refused and creates nothing", async () => {
    const w = await createWorkspace(db);
    const res = await postUpdate(stack.apiUrl, w, telegramUpdate(w, COMPLAINT), "not-the-secret");
    assert.ok([401, 403].includes(res.status), `status ${res.status}`);
    // Barrier: a genuine message afterwards is the only one that exists.
    await postUpdate(stack.apiUrl, w, telegramUpdate(w, SECOND_COMPLAINT, 2));
    await settled(w, 1);
    assert.equal(await count("SELECT 1 FROM messages WHERE tenant_id = $1 AND direction = 'in'", [w.tenantId]), 1);
    assert.ok(!mocks.gemini.requests.some((r) => r.userPrompt.includes("Pay now. You can reach")), "the refused message never reached the model");
  });
});

describe("when things go wrong", () => {
  it("an LLM outage still creates a ticket and a room and tells the client, but sends nothing to GitHub", async () => {
    const w = await createWorkspace(db);
    mocks.gemini.fail(500);
    await postUpdate(stack.apiUrl, w, telegramUpdate(w, COMPLAINT));
    await waitFor(async () => (await ticketsOf(w)).length === 1 && (await outboxDone(w)) && mocks.telegram.texts.length >= 1 && mocks.switchGateway.rooms.length >= 1, WAIT);

    const [ticket] = await ticketsOf(w);
    assert.equal(ticket.status, "quarantined", "held for a human: 'Needs human triage'");
    assert.equal(ticket.priority, "P3");
    assert.equal(mocks.github.createRequests.length, 0, "a quarantined ticket is never sent to GitHub");
    assert.equal(await count("SELECT 1 FROM tracker_issues WHERE tenant_id = $1", [w.tenantId]), 0);
    assert.match(mocks.telegram.texts[0]!, /^Thanks, we've received your report/);
    assert.equal(mocks.switchGateway.rooms.length, 1, "the team still gets a room to triage it in");

    const op = await signIn(stack.apiUrl, w);
    const released = await op.post(`/api/tickets/${ticket.id}/transition`, { to: "triaged", from: "quarantined", reason: "read it, looks real" });
    assert.equal(released.status, 200, "an operator can release it");
  });

  it("a Telegram hiccup delays the acknowledgement but never duplicates or loses it", async () => {
    const w = await createWorkspace(db);
    mocks.telegram.replies = [mocks.telegram.fail(500, "Internal Server Error")];
    await postUpdate(stack.apiUrl, w, telegramUpdate(w, COMPLAINT));
    await waitFor(async () => (await kindDone(w, "client.send")) && (await ticketsOf(w)).length === 1, WAIT);

    const sends = mocks.telegram.requests.filter((r) => r.path.endsWith("/sendMessage"));
    assert.equal(sends.length, 2, "one failed attempt, one retry");
    const row = await one("SELECT status, attempts FROM outbox WHERE tenant_id = $1 AND kind = 'client.send'", [w.tenantId]);
    assert.deepEqual([row.status, row.attempts], ["done", 2]);
    assert.equal(await count("SELECT 1 FROM messages WHERE tenant_id = $1 AND direction = 'out'", [w.tenantId]), 1, "the client is recorded as told once");
  });

  it("an off-topic message gets a polite refusal and creates nothing", async () => {
    const w = await createWorkspace(db);
    // The ticket stage replies with a refusal for `is_complaint: true, off_topic: true`. (It checks is_complaint first, so
    // `is_complaint: false, off_topic: true` -- what the extraction prompt literally asks for -- gets no reply at all.)
    mocks.gemini.responder = () => ({ language: "en", is_complaint: true, off_topic: true, issues: [], contains_sensitive_data: false, sentiment: "neutral", confidence: 0.95, missing_info: [] });
    await postUpdate(stack.apiUrl, w, telegramUpdate(w, "What is the weather like in Paris?"));
    await waitFor(() => mocks.telegram.texts.length >= 1, WAIT);
    assert.match(mocks.telegram.texts[0]!, /this chat is only for reporting problems/);
    await waitFor(() => outboxDone(w), WAIT);
    assert.equal((await ticketsOf(w)).length, 0);
    assert.equal(mocks.github.createRequests.length, 0);
    assert.equal(mocks.switchGateway.rooms.length, 0);
  });
});

describe("the platform as a whole", () => {
  it("made no call to anything outside the machine, and its logs hold no client text and no secrets", () => {
    assert.deepEqual(stack.blockedHosts(), [], "the offline guard never had to refuse a request");
    const logs = stack.logs().join("\n");
    assert.ok(logs.length > 0, "the processes logged something");
    for (const secret of [EMAIL, "Pay now", E2E_BOT_TOKEN, E2E_GITHUB_TOKEN, E2E_LLM_KEY, E2E_ENCRYPTION_KEY, "e2e-only-password-1"]) {
      assert.ok(!logs.includes(secret), `a log line contains ${secret.slice(0, 6)}…`);
    }
  });

  it("both processes shut down cleanly on SIGTERM", async () => {
    stopped = true;
    assert.deepEqual(await stack.stop(), { api: 0, worker: 0 });
  });
});
