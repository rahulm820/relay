import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ExtractionOutcomeSchema,
  ExtractionOutputSchema,
  ExtractionResultSchema,
  FallbackResultSchema,
  GithubDraftV1Schema,
  IllegalTransitionError,
  NormalizedMessageSchema,
  assertTransition,
  canTransition,
  githubIdempotencyKey,
  isFallback,
  type ExtractFn,
  type ExtractionOutcome,
} from "./index.js";

const issue = {
  title: "Checkout fails with 500 on card payment",
  summary: "Card payments return 500",
  category: "bug",
  product_area: "checkout",
  steps_to_reproduce: ["add item", "pay by card"],
  expected: "order placed",
  actual: "500 error",
  environment: { device: "iPhone 15", app_version: "4.2.1" },
  severity_signals: ["payment_failure", "blocking"],
  missing_info: ["app_version"],
  confidence: 0.86,
};
const output = {
  language: "en",
  is_complaint: true,
  off_topic: false,
  issues: [issue],
  contains_sensitive_data: false,
  sentiment: "frustrated",
  confidence: 0.86,
  missing_info: [],
};

describe("extraction schema", () => {
  it("accepts the architecture sample", () => {
    assert.ok(ExtractionOutputSchema.safeParse(output).success);
  });
  it("rejects bad category, out-of-range confidence and missing fields", () => {
    assert.ok(!ExtractionOutputSchema.safeParse({ ...output, issues: [{ ...issue, category: "nope" }] }).success);
    assert.ok(!ExtractionOutputSchema.safeParse({ ...output, confidence: 1.5 }).success);
    assert.ok(!ExtractionOutputSchema.safeParse({ ...output, is_complaint: undefined }).success);
  });
  it("model output without kind is not an ExtractionResult", () => {
    assert.ok(!ExtractionResultSchema.safeParse(output).success);
    assert.ok(ExtractionResultSchema.safeParse({ ...output, kind: "extracted" }).success);
  });
});

describe("outcome discrimination", () => {
  it("separates extracted from fallback", () => {
    const ok = ExtractionOutcomeSchema.parse({ ...output, kind: "extracted" });
    const fb = ExtractionOutcomeSchema.parse({ kind: "fallback", reason: "timeout" });
    assert.equal(isFallback(ok), false);
    assert.equal(isFallback(fb), true);
    assert.ok(!FallbackResultSchema.safeParse({ kind: "fallback", reason: "weird" }).success);
  });
  it("ExtractFn type admits both outcomes", async () => {
    const fn: ExtractFn = async () => ({ kind: "fallback", reason: "llm_error" });
    const r: ExtractionOutcome = await fn("hi", { tenantId: "t", conversationId: "c", traceId: "x" });
    assert.equal(r.kind, "fallback");
  });
});

describe("state machine", () => {
  it("allows legal and rejects illegal transitions", () => {
    assert.ok(canTransition("received", "triaged"));
    assert.ok(canTransition("resolved", "reopened"));
    assert.ok(!canTransition("resolved", "in_progress"));
    assert.throws(() => assertTransition("closed", "assigned"), IllegalTransitionError);
  });
});

describe("other contracts", () => {
  it("validates NormalizedMessage and draft", () => {
    assert.ok(
      NormalizedMessageSchema.safeParse({
        tenantId: "t", botId: "b", channel: "telegram", platformMessageId: "1", platformChatId: "2",
        senderRef: "s", text: "hi", receivedAt: "2026-11-04T09:00:00Z",
      }).success,
    );
    assert.ok(!GithubDraftV1Schema.safeParse({ version: "v2", title: "x", description: "", confidence: 1 }).success);
  });
  it("builds the idempotency key", () => {
    assert.equal(githubIdempotencyKey("t1", "k9", "general"), "github:t1:k9:general");
  });
});
