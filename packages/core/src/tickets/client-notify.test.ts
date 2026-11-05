import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TICKET_STATUSES } from "@relay/shared";
import { ClientSendPayloadSchema, NOTIFYING_STATUSES, clientSendKey, statusNotifies } from "./index.js";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const M = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";

describe("which statuses notify the client", () => {
  it("exactly needs_info, in_progress, resolved and reopened", () => {
    assert.deepEqual(TICKET_STATUSES.filter(statusNotifies).sort(), ["in_progress", "needs_info", "reopened", "resolved"]);
    assert.deepEqual([...NOTIFYING_STATUSES].sort(), ["in_progress", "needs_info", "reopened", "resolved"]);
  });
  it("quarantined and the internal statuses stay silent", () => {
    for (const s of ["received", "triaged", "assigned", "in_review", "escalated", "quarantined", "closed"] as const) assert.equal(statusNotifies(s), false, s);
  });
});

describe("client.send keys and payloads", () => {
  it("follow the documented conventions", () => {
    assert.equal(clientSendKey("t1", { kind: "ack", messageId: M, sensitive: false }), `client:t1:${M}:ack`);
    assert.equal(clientSendKey("t1", { kind: "refusal", messageId: M }), `client:t1:${M}:refusal`);
    assert.equal(clientSendKey("t1", { kind: "status", ticketId: T, status: "resolved", eventId: E }), `client:t1:${T}:status:resolved:${E}`);
  });
  it("two occurrences of the same status differ by event id", () => {
    const a = clientSendKey("t", { kind: "status", ticketId: T, status: "resolved", eventId: E });
    const b = clientSendKey("t", { kind: "status", ticketId: T, status: "resolved", eventId: M });
    assert.notEqual(a, b);
  });
  it("payloads hold ids and enums only and reject free text and unknown kinds", () => {
    const ok = ClientSendPayloadSchema.parse({ kind: "status", ticketId: T, status: "resolved", eventId: E, text: "client words" });
    assert.deepEqual(Object.keys(ok).sort(), ["eventId", "kind", "status", "ticketId"]);
    assert.ok(!ClientSendPayloadSchema.safeParse({ kind: "text", body: "x" }).success);
    assert.ok(!ClientSendPayloadSchema.safeParse({ kind: "status", ticketId: "nope", status: "resolved", eventId: E }).success);
    assert.ok(!ClientSendPayloadSchema.safeParse({ kind: "status", ticketId: T, status: "bogus", eventId: E }).success);
  });
});
