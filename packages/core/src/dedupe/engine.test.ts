import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickDuplicate, type DedupeCandidate } from "./engine.js";

const cand = (over: Partial<DedupeCandidate> = {}): DedupeCandidate => ({
  ticketId: "t1", category: "bug", productArea: "checkout", similarity: 0.95, affectedClientCount: 1, ...over,
});
const subject = { category: "bug" as const, productArea: "checkout", eligible: true };

describe("pickDuplicate", () => {
  it("matches a candidate at or above the threshold (boundary is inclusive)", () => {
    assert.equal(pickDuplicate(subject, [cand({ similarity: 0.9 })], 0.9)?.ticketId, "t1");
  });
  it("does not match just below the threshold", () => {
    assert.equal(pickDuplicate(subject, [cand({ similarity: 0.8999 })], 0.9), null);
  });
  it("never merges across product areas, however similar", () => {
    assert.equal(pickDuplicate({ ...subject, productArea: "billing" }, [cand({ similarity: 1 })], 0.9), null);
  });
  it("needs a product area on the new complaint", () => {
    assert.equal(pickDuplicate({ ...subject, productArea: null }, [cand({ productArea: null, similarity: 1 })], 0.9), null);
  });
  it("never merges across categories", () => {
    assert.equal(pickDuplicate({ ...subject, category: "ui" }, [cand({ category: "bug", similarity: 1 })], 0.9), null);
  });
  it("an ineligible subject (sensitive or low confidence) never matches", () => {
    assert.equal(pickDuplicate({ ...subject, eligible: false }, [cand({ similarity: 1 })], 0.9), null);
  });
  it("picks the most similar of several candidates", () => {
    const best = pickDuplicate(subject, [cand({ ticketId: "a", similarity: 0.92 }), cand({ ticketId: "b", similarity: 0.97 })], 0.9);
    assert.equal(best?.ticketId, "b");
  });
  it("ties go to the earlier candidate (the list is already in rank order)", () => {
    const best = pickDuplicate(subject, [cand({ ticketId: "a", similarity: 0.95 }), cand({ ticketId: "b", similarity: 0.95 })], 0.9);
    assert.equal(best?.ticketId, "a");
  });
});
