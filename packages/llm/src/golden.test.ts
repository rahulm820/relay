import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATEGORIES, type Category, type ExtractFn, type ExtractionResult } from "@relay/shared";
import { formatReport, loadGoldenSet, runGolden, type GoldenSet } from "./golden.js";

const extracted = (category: Category, over: Partial<ExtractionResult> = {}): ExtractionResult => ({
  kind: "extracted", language: "en", is_complaint: true, off_topic: false, contains_sensitive_data: false, sentiment: "neutral", confidence: 0.9, missing_info: [],
  issues: [{ title: "t", summary: "s", category, product_area: null, steps_to_reproduce: [], expected: null, actual: null, environment: {}, severity_signals: [], missing_info: [], confidence: 0.9 }],
  ...over,
});
const small: GoldenSet = {
  description: "test",
  cases: [
    { id: "a", text: "text a", expected: { isComplaint: true, offTopic: false, category: "bug" } },
    { id: "b", text: "text b", expected: { isComplaint: true, offTopic: false, category: "ui" } },
    { id: "c", text: "text c", expected: { isComplaint: true, offTopic: false, category: "billing" } },
    { id: "d", text: "text d", expected: { isComplaint: false, offTopic: true, category: null } },
  ],
  duplicatePairs: [{ a: "a", b: "b", duplicate: true }, { a: "a", b: "c", duplicate: false }, { a: "b", b: "c", duplicate: false }],
};

describe("the golden set itself", () => {
  const set = loadGoldenSet();
  it("has unique ids, valid categories, and covers every kind of message the platform must handle", () => {
    assert.equal(new Set(set.cases.map((c) => c.id)).size, set.cases.length, "ids are unique");
    for (const c of set.cases) {
      assert.ok(c.text.length > 10);
      assert.ok(c.expected.category === null || (CATEGORIES as readonly string[]).includes(c.expected.category), c.id);
      assert.equal(c.expected.category === null, !c.expected.isComplaint || c.expected.offTopic, `${c.id}: a category exactly when it should become a ticket`);
    }
    for (const cat of ["bug", "ui", "billing", "question", "feature"]) assert.ok(set.cases.filter((c) => c.expected.category === cat).length >= 3, `enough ${cat} cases`);
    assert.ok(set.cases.some((c) => c.expected.offTopic) && set.cases.some((c) => !c.expected.isComplaint && !c.expected.offTopic), "off-topic and small talk are covered");
  });
  it("references real cases in its duplicate pairs, with both kinds of pair", () => {
    const ids = new Set(set.cases.map((c) => c.id));
    for (const p of set.duplicatePairs) assert.ok(ids.has(p.a) && ids.has(p.b), `${p.a} / ${p.b}`);
    assert.ok(set.duplicatePairs.some((p) => p.duplicate) && set.duplicatePairs.some((p) => !p.duplicate));
  });
  it("is synthetic: no email addresses, phone numbers or card-like numbers", () => {
    for (const c of set.cases) assert.ok(!/@|\b\d{3}[ -]?\d{3,4}[ -]?\d{4}\b|\b\d{13,19}\b/.test(c.text), c.id);
  });
});

describe("runGolden metrics", () => {
  it("scores a perfect model at 100% and reports no misses", async () => {
    const answers: Record<string, ExtractionResult> = { "text a": extracted("bug"), "text b": extracted("ui"), "text c": extracted("billing"), "text d": extracted("other", { is_complaint: false, off_topic: true, issues: [] }) };
    const r = await runGolden(small, async (t) => answers[t]!);
    assert.equal(r.categoryAccuracy.rate, 1);
    assert.equal(r.complaintJudgement.rate, 1);
    assert.equal(r.offTopicJudgement.rate, 1);
    assert.deepEqual(r.misses, []);
    assert.deepEqual([r.answered, r.fallbacks], [4, 0]);
  });

  it("counts wrong categories and fallbacks as misses, per category, and explains each", async () => {
    const extract: ExtractFn = async (t) =>
      t === "text a" ? extracted("bug") : t === "text b" ? extracted("feature") : t === "text c" ? { kind: "fallback", reason: "timeout" } : extracted("other", { is_complaint: false, off_topic: true, issues: [] });
    const r = await runGolden(small, extract);
    assert.deepEqual([r.categoryAccuracy.correct, r.categoryAccuracy.total], [1, 3]);
    assert.equal(r.perCategory["bug"]!.rate, 1);
    assert.equal(r.perCategory["ui"]!.rate, 0);
    assert.deepEqual(r.misses, [{ id: "b", expected: "ui", got: "feature" }, { id: "c", expected: "billing", got: "fallback:timeout" }]);
    assert.equal(r.fallbacks, 1);
    assert.equal(r.complaintJudgement.total, 3, "judgement is measured over answered messages only");
  });

  it("reports the false-duplicate rate and recall only when a detector is supplied", async () => {
    const extract: ExtractFn = async () => extracted("bug");
    assert.equal((await runGolden(small, extract)).falseDuplicateRate, null);
    // A detector that merges everything: finds the true duplicate, but wrongly merges both non-duplicate pairs.
    const merged = await runGolden(small, extract, { detector: async () => true });
    assert.deepEqual([merged.falseDuplicateRate!.correct, merged.falseDuplicateRate!.total], [2, 2]);
    assert.equal(merged.duplicateRecall!.rate, 1);
    const never = await runGolden(small, extract, { detector: async () => false });
    assert.equal(never.falseDuplicateRate!.rate, 0);
    assert.equal(never.duplicateRecall!.rate, 0);
  });

  it("calls the extractor once per message, a few at a time", async () => {
    let active = 0, peak = 0, calls = 0;
    const extract: ExtractFn = async () => { calls++; active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return extracted("bug"); };
    await runGolden(small, extract, { concurrency: 2 });
    assert.equal(calls, small.cases.length);
    assert.ok(peak <= 2);
  });
});

describe("formatReport", () => {
  it("prints the headline metrics and says plainly when no embedding model is configured", async () => {
    const out = formatReport(await runGolden(small, async () => extracted("bug")));
    assert.match(out, /category accuracy:\s+33\.3% \(1\/3\)/);
    assert.match(out, /false-duplicate rate:\s+n\/a \(set LLM_EMBED_MODEL to measure it\)/);
    assert.match(out, /category misses:/);
  });
});
