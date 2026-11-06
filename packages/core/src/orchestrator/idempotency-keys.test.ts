// The idempotency keys are what make replays safe, so their shape and uniqueness are tested on their own, without a
// database: the same input always gives the same key (a replay is recognised), and different inputs never collide.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PIPELINE_STAGES, QUEUE_STAGES, SYNC_MODES, githubIdempotencyKey } from "@relay/shared";
import { clientSendKey } from "../tickets/client-notify.js";
import { derivedJobKey, nextStage } from "./stages.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const E1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const E2 = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const allDistinct = (keys: string[]) => assert.equal(new Set(keys).size, keys.length, `collision among ${keys.join(", ")}`);

describe("GitHub idempotency key", () => {
  it("is stable for the same tenant, ticket and mode, and distinct for any difference", () => {
    assert.equal(githubIdempotencyKey(T1, M1, "general"), githubIdempotencyKey(T1, M1, "general"));
    assert.equal(githubIdempotencyKey(T1, M1, "general"), `github:${T1}:${M1}:general`);
    allDistinct([
      githubIdempotencyKey(T1, M1, "general"), githubIdempotencyKey(T2, M1, "general"),
      githubIdempotencyKey(T1, M2, "general"), githubIdempotencyKey(T1, M1, "code_aware"),
    ]);
  });

  it("separates tenants: the same ticket id in two tenants never shares a key", () => {
    for (const mode of SYNC_MODES) assert.notEqual(githubIdempotencyKey(T1, M1, mode), githubIdempotencyKey(T2, M1, mode));
  });
});

describe("queue job keys", () => {
  it("derive deterministically from the message and the stage, one per stage", () => {
    const keys = QUEUE_STAGES.map((s) => derivedJobKey(M1, s));
    allDistinct(keys);
    assert.deepEqual(keys, QUEUE_STAGES.map((s) => derivedJobKey(M1, s)));
    assert.equal(derivedJobKey(M1, "ticket"), `${M1}:ticket`);
  });

  it("differ between messages for the same stage", () => {
    assert.notEqual(derivedJobKey(M1, "extract"), derivedJobKey(M2, "extract"));
  });

  it("nextStage walks ingest -> every pipeline stage in order -> nothing", () => {
    const walked: string[] = [];
    for (let s = nextStage("ingest"); s; s = nextStage(s)) walked.push(s);
    assert.deepEqual(walked, [...PIPELINE_STAGES]);
    assert.equal(nextStage(PIPELINE_STAGES[PIPELINE_STAGES.length - 1]!), undefined);
  });
});

describe("client.send keys", () => {
  it("an ack or refusal is once per inbound message and kind, per tenant", () => {
    assert.equal(clientSendKey(T1, { kind: "ack", messageId: M1, sensitive: false }), clientSendKey(T1, { kind: "ack", messageId: M1, sensitive: true }), "the safety line does not make a second ack");
    allDistinct([
      clientSendKey(T1, { kind: "ack", messageId: M1, sensitive: false }), clientSendKey(T1, { kind: "refusal", messageId: M1 }),
      clientSendKey(T1, { kind: "ack", messageId: M2, sensitive: false }), clientSendKey(T2, { kind: "ack", messageId: M1, sensitive: false }),
    ]);
  });

  it("a status update is keyed by the status_changed event, so each occurrence is its own key and one occurrence is never doubled", () => {
    const base = { kind: "status" as const, ticketId: M1, status: "resolved" as const };
    assert.equal(clientSendKey(T1, { ...base, eventId: E1 }), clientSendKey(T1, { ...base, eventId: E1 }));
    assert.notEqual(clientSendKey(T1, { ...base, eventId: E1 }), clientSendKey(T1, { ...base, eventId: E2 }), "reopen then resolve again notifies again");
    assert.notEqual(clientSendKey(T1, { ...base, eventId: E1 }), clientSendKey(T1, { ...base, status: "in_progress", eventId: E1 }));
  });
});
