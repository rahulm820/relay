import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIssueBody, labelsFor, parseLabelMap } from "./index.js";

const base = { ticketId: "t-1", title: "Checkout fails", summary: "Payment step errors out.", category: "bug", priority: "P2", priorityReason: "blocking", clientTier: "enterprise", affectedClientCount: 3 };

test("body starts with the summary and carries priority, category and customer impact", () => {
  const body = buildIssueBody(base);
  assert.match(body, /^Payment step errors out\./);
  assert.match(body, /\*\*Priority:\*\* P2 \(blocking\)/);
  assert.match(body, /\*\*Category:\*\* bug/);
  assert.match(body, /enterprise tier, 3 affected clients/);
  assert.match(body, /Relay ticket `t-1`/);
});

test("reproduction steps are numbered and expected/actual are included when present", () => {
  const body = buildIssueBody({ ...base, stepsToReproduce: ["open cart", "pay"], expected: "order placed", actual: "error 500" });
  assert.match(body, /1\. open cart\n2\. pay/);
  assert.match(body, /### Expected\norder placed/);
  assert.match(body, /### Actual\nerror 500/);
});

test("sections with no content are omitted", () => {
  const body = buildIssueBody({ ...base, clientTier: null, affectedClientCount: 1 });
  assert.doesNotMatch(body, /Steps to reproduce|Expected|Actual|Missing information/);
  assert.match(body, /1 affected client\b/);
});

test("labels map category and priority, deduplicated, skipping unmapped values", () => {
  const map = parseLabelMap({ category: { bug: "bug" }, priority: { P1: "priority:p1", P2: "bug" } });
  assert.deepEqual(labelsFor({ category: "bug", priority: "P2" }, map), ["bug"]);
  assert.deepEqual(labelsFor({ category: "ui", priority: "P1" }, map), ["priority:p1"]);
  assert.deepEqual(parseLabelMap(null), {});
});
