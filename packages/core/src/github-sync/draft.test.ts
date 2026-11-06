import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { withTenant } from "@relay/db";
import type { RepoContext, RepoContextProvider } from "@relay/trackers";
import { EnvSecretProvider, type ExtractionOutcome, type ExtractionResult } from "@relay/shared";
import {
  OutboxDispatcher, createDefaultOutboxRegistry, ticketStage, type StageContext,
} from "../index.js";
import { createGithubDraftHandler, DRAFT_PROMPT_VERSION, type DraftLlm, type DraftLlmRun } from "./draft.js";
import { createMessage, createTenant, createTestDb, type TestDb, type TestTenant } from "../testing/fixtures.js";

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.dispose(); });

const issue = (over: Record<string, unknown> = {}) => ({
  title: "Checkout fails", summary: "Card payments return 500", category: "bug" as const, product_area: "checkout",
  steps_to_reproduce: ["open cart", "pay"], expected: "order placed", actual: "error 500", environment: {},
  severity_signals: ["payment_failure"], missing_info: [], confidence: 0.9, ...over,
});
const extraction = (over: Partial<ExtractionResult> = {}): ExtractionResult => ({
  kind: "extracted", language: "en", is_complaint: true, off_topic: false, issues: [issue()], contains_sensitive_data: false,
  sentiment: "frustrated", confidence: 0.9, missing_info: [], ...over,
});

async function integration(t: TestTenant, over: { codeAware?: boolean; credentials?: string | null } = {}) {
  await db.owner.query("DELETE FROM integrations WHERE tenant_id = $1", [t.tenantId]);
  await db.owner.query(
    `INSERT INTO integrations (tenant_id, provider, credentials_ref, repo_ref, label_map_json, status, approval_policy, code_aware_enabled)
     VALUES ($1, 'github', $2, 'acme/app', $3, 'active', 'auto', $4)`,
    [
      t.tenantId,
      over.credentials === undefined ? "env:TEST_GITHUB_TOKEN" : over.credentials,
      JSON.stringify({ category: { bug: "bug" }, priority: { P1: "priority:p1" } }),
      over.codeAware ?? true,
    ],
  );
}

async function createTickets(t: TestTenant, outcome: ExtractionOutcome): Promise<{ messageId: string; ticketIds: string[] }> {
  const messageId = await createMessage(db.owner, t);
  const out = await ticketStage()(stageCtx(t, messageId, { extract: outcome }, "ticket"));
  return { messageId, ticketIds: (out.result as { ticketIds: string[] }).ticketIds };
}

function stageCtx(t: TestTenant, messageId: string, results: Record<string, unknown>, stage: "ticket"): StageContext {
  return {
    tenantId: t.tenantId, conversationId: t.conversationId, messageId, traceId: "trace-draft", stage, attempt: 1, results,
    db: (fn) => withTenant(db.worker, t.tenantId, fn),
    signal: new AbortController().signal,
  };
}

const secrets = new EnvSecretProvider({ TEST_GITHUB_TOKEN: "ghp_test_token_value_1234567890" });
const rows = async (sql: string, params: unknown[]) => (await db.owner.query(sql, params)).rows;
const draftKey = (t: TestTenant, ticketId: string) => `draft:${t.tenantId}:${ticketId}`;
const draftRow = async (key: string) => (await rows("SELECT status, last_error FROM outbox WHERE idempotency_key = $1", [key]))[0];
const draftRowsOf = async (ticketId: string) =>
  rows("SELECT repo_ref, provider, draft_json, evidence_refs, confidence, llm_run_id, status FROM issue_drafts WHERE ticket_id = $1", [ticketId]);
const kindsOf = async (ticketId: string) => (await rows("SELECT kind FROM outbox WHERE payload->>'ticketId' = $1 ORDER BY kind", [ticketId])).map((r) => r.kind);

/** The retrieved repository the fake context reader answers with. */
const CONTEXT: RepoContext = {
  files: [{ path: "src/checkout.ts", content: "export const pay = () => { throw new Error('500'); };" }],
  docs: [{ path: "README.md", content: "# Acme app" }],
  issues: [
    { number: 3, title: "Payment form is slow", state: "open", url: "https://github.com/acme/app/issues/3" },
    { number: 9, title: "Checkout fails with 500 on card payment", state: "open", url: "https://github.com/acme/app/issues/9" },
  ],
  commits: [{ sha: "abcdef123456", message: "harden checkout", date: "2026-11-01T00:00:00Z" }],
};

function fakeRepo(context: RepoContext = CONTEXT) {
  let calls = 0;
  const provider: RepoContextProvider = { retrieveContext: async () => { calls++; return context; } };
  return { provider, get calls() { return calls; } };
}

/** Strong-tier stand-in: returns `reply()` as JSON and records every request. */
function fakeLlm(reply: () => unknown) {
  const calls: { system: string; user: string }[] = [];
  const runs: DraftLlmRun[] = [];
  let fail: Error | null = null;
  const provider: DraftLlm = {
    async complete(req) {
      calls.push({ system: req.system, user: req.user });
      if (fail) throw fail;
      return { text: JSON.stringify(reply()), costUsd: 0.012 };
    },
  };
  const llm = {
    provider,
    model: "strong-model",
    promptVersion: DRAFT_PROMPT_VERSION,
    recordRun: async (run: DraftLlmRun) => { runs.push(run); return "00000000-0000-4000-8000-0000000000aa"; },
  };
  return { llm, calls, runs, failWith: (e: Error | null) => { fail = e; } };
}

const draftReply = (over: Record<string, unknown> = {}) => ({
  version: "github.draft.v1",
  title: "Checkout fails with 500 on card payment",
  description: "Card payments return 500 in `src/checkout.ts`.",
  suspected_area: "checkout",
  suspected_files: ["src/checkout.ts", "src/invented.ts"],
  reproduction: ["open cart", "pay with card"],
  expected: "order placed",
  actual: "error 500",
  acceptance_criteria: ["card payment succeeds"],
  confidence: 0.82,
  ...over,
});

/** Dispatches github.draft rows through the real handler; every other kind stays a no-op. */
function dispatcherWith(opts: { llm?: ReturnType<typeof fakeLlm>["llm"]; repo?: RepoContextProvider }) {
  return new OutboxDispatcher({
    pool: db.worker,
    registry: createDefaultOutboxRegistry(() => {}).register(
      "github.draft",
      createGithubDraftHandler({
        pool: db.worker, secrets,
        createProvider: () => opts.repo ?? fakeRepo().provider,
        ...(opts.llm ? { llm: opts.llm } : {}),
      }),
    ),
    // Retry immediately: a second pass must see the row the first pass put back to pending.
    backoffBaseMs: 1, backoffMaxMs: 1,
    log: () => {},
  });
}
const deliver = (t: TestTenant, ticketId: string, payload: Record<string, unknown> = { ticketId }) =>
  createGithubDraftHandler({
    pool: db.worker, secrets,
    createProvider: () => fakeRepo().provider,
    llm: fakeLlm(() => draftReply()).llm,
  })({
    outboxId: "00000000-0000-4000-8000-000000000099", tenantId: t.tenantId, kind: "github.draft" as const,
    idempotencyKey: draftKey(t, ticketId), payload, attempt: 1, traceId: "trace-draft",
  });

describe("github.draft outbox handler", () => {
  it("a code-aware bug ticket gets a pending draft grounded in the retrieved context", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());

    // Enqueued with the ticket: read-only drafting is always pending, never staged.
    const queued = await draftRow(draftKey(t, ticketId!));
    assert.equal(queued.status, "pending");

    // No repository issue matches this draft's title, so nothing to link against.
    const repo = fakeRepo({ ...CONTEXT, issues: [CONTEXT.issues[0]!] });
    const { llm, calls, runs } = fakeLlm(() => draftReply());
    await dispatcherWith({ llm, repo: repo.provider }).runOnce();

    assert.equal(repo.calls, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.system, /grounded ONLY in the repository context/);
    assert.match(calls[0]!.user, /<repo_context_untrusted>/);
    assert.match(calls[0]!.user, /Title: Checkout fails/);

    const [draft] = await draftRowsOf(ticketId!);
    assert.ok(draft, "one draft row");
    assert.equal(draft.status, "pending");
    assert.equal(draft.repo_ref, "acme/app");
    assert.equal(draft.provider, "github");
    const body = draft.draft_json;
    assert.equal(body.version, "github.draft.v1");
    // The invented path was filtered out; only context paths survive.
    assert.deepEqual(body.suspected_files, ["src/checkout.ts"]);
    assert.equal(body.proposed_action, "create");
    assert.equal(body.likely_duplicate, null);
    assert.equal(body.confidence, 0.82);
    assert.deepEqual(draft.evidence_refs, ["src/checkout.ts"]);
    assert.equal(draft.confidence, "0.820");
    assert.ok(draft.llm_run_id, "the run id links the draft to its llm_runs row");

    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.promptVersion, DRAFT_PROMPT_VERSION);
    assert.equal(runs[0]!.ticketId, ticketId);
    assert.match(runs[0]!.inputHash, /^[0-9a-f]{64}$/);
    assert.equal(runs[0]!.outputJson === null ? null : (runs[0]!.outputJson as { title?: string }).title, "Checkout fails with 500 on card payment");
    assert.equal(runs[0]!.costUsd, 0.012);

    assert.equal((await draftRow(draftKey(t, ticketId!))).status, "done");
    assert.equal((await draftRow(draftKey(t, ticketId!))).last_error, "draft_created");
    // Drafting never creates the issue: the general-sync link stays untouched (#14 approves).
    const [link] = await rows("SELECT sync_status FROM tracker_issues WHERE ticket_id = $1", [ticketId]);
    assert.equal(link.sync_status, "pending");
  });

  it("a second delivery of the same job keeps exactly one draft", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());

    const { llm } = fakeLlm(() => draftReply());
    await dispatcherWith({ llm }).runOnce();
    const note = await deliver(t, ticketId!);

    assert.deepEqual(note, { note: "already_drafted" });
    assert.equal((await draftRowsOf(ticketId!)).length, 1);
    await db.owner.query("UPDATE outbox SET status = 'done' WHERE idempotency_key = $1", [draftKey(t, ticketId!)]);
  });

  it("a likely repository duplicate flags the draft to link/comment instead of creating", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    const { llm } = fakeLlm(() => draftReply());

    await dispatcherWith({ llm }).runOnce();

    const [draft] = await draftRowsOf(ticketId!);
    assert.equal(draft.draft_json.proposed_action, "link_or_comment");
    assert.deepEqual(draft.draft_json.likely_duplicate, {
      number: 9, title: "Checkout fails with 500 on card payment", url: "https://github.com/acme/app/issues/9",
    });
    assert.ok(draft.evidence_refs.includes("issue:#9"));
  });

  it("the context reader sees the ticket title as its search query", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    const seen: string[] = [];
    const repo: RepoContextProvider = { retrieveContext: async (_repo, query) => { seen.push(query); return CONTEXT; } };
    const { llm } = fakeLlm(() => draftReply());

    await dispatcherWith({ llm, repo }).runOnce();

    assert.deepEqual(seen, ["Checkout fails"]);
  });

  it("a non-code complaint never gets a draft row", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction({ issues: [issue({ title: "How do I export?", category: "question", severity_signals: [] })] }));

    assert.equal(await draftRow(draftKey(t, ticketId!)), undefined);
    assert.deepEqual(await kindsOf(ticketId!), ["github.create_issue", "switch.create_room"]);
  });

  it("code-aware disabled writes no draft row", async () => {
    const t = await createTenant(db.owner);
    await integration(t, { codeAware: false });
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());

    assert.equal(await draftRow(draftKey(t, ticketId!)), undefined);
    assert.deepEqual(await kindsOf(ticketId!), ["github.create_issue", "switch.create_room"]);
  });

  it("without an LLM the row fails with llm_not_configured and stores nothing", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    const repo = fakeRepo();

    await dispatcherWith({ repo: repo.provider }).runOnce();

    assert.equal(repo.calls, 0, "no retrieval before the model is known to exist");
    assert.equal((await draftRow(draftKey(t, ticketId!))).status, "failed");
    assert.equal((await draftRow(draftKey(t, ticketId!))).last_error, "llm not configured");
    assert.equal((await draftRowsOf(ticketId!)).length, 0);
  });

  it("missing credentials fail the row with missing_credentials", async () => {
    const t = await createTenant(db.owner);
    await integration(t, { credentials: "env:NOT_SET_ANYWHERE" });
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());

    await dispatcherWith({ llm: fakeLlm(() => draftReply()).llm }).runOnce();

    assert.equal((await draftRow(draftKey(t, ticketId!))).status, "failed");
    assert.equal((await draftRow(draftKey(t, ticketId!))).last_error, "github credentials are missing");
    assert.equal((await draftRowsOf(ticketId!)).length, 0);
  });

  it("a quarantined ticket is skipped and stores nothing", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    await db.owner.query("UPDATE tickets SET status = 'quarantined' WHERE id = $1", [ticketId]);
    const repo = fakeRepo();

    await dispatcherWith({ llm: fakeLlm(() => draftReply()).llm, repo: repo.provider }).runOnce();

    assert.equal(repo.calls, 0);
    assert.equal((await draftRow(draftKey(t, ticketId!))).status, "done");
    assert.equal((await draftRow(draftKey(t, ticketId!))).last_error, "skipped_quarantined");
    assert.equal((await draftRowsOf(ticketId!)).length, 0);
  });

  it("output that never matches the schema fails the row after one retry", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    const { llm, calls } = fakeLlm(() => ({ version: "github.draft.v1", title: "nope" }));

    await dispatcherWith({ llm }).runOnce();

    assert.equal(calls.length, 2, "one attempt plus one retry");
    assert.equal((await draftRow(draftKey(t, ticketId!))).status, "failed");
    assert.equal((await draftRow(draftKey(t, ticketId!))).last_error, "draft output failed schema validation twice");
    assert.equal((await draftRowsOf(ticketId!)).length, 0);
  });

  it("a failing model request records a null llm_run and retries the row", async () => {
    const t = await createTenant(db.owner);
    await integration(t);
    const { ticketIds: [ticketId] } = await createTickets(t, extraction());
    const { llm, runs } = fakeLlm(() => draftReply());
    llm.provider.complete = async () => { throw new Error("provider down"); };

    await dispatcherWith({ llm }).runOnce();

    assert.equal((await draftRow(draftKey(t, ticketId!))).status, "pending", "transient failures retry");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.outputJson, null);
    assert.equal((await draftRowsOf(ticketId!)).length, 0);

    llm.provider.complete = async () => ({ text: JSON.stringify(draftReply()), costUsd: 0.01 });
    await dispatcherWith({ llm }).runOnce();
    assert.equal((await draftRow(draftKey(t, ticketId!))).status, "done");
    assert.equal((await draftRowsOf(ticketId!)).length, 1);
  });
});
