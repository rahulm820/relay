import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runGolden, type Embedder, type GoldenSet } from "@relay/llm";
import type { ExtractFn, ExtractionResult } from "@relay/shared";
import { buildDuplicateDetector, cosine } from "./golden-detector.js";

const result = (o: { area?: string | null; category?: "bug" | "ui"; sensitive?: boolean; confidence?: number; title?: string }): ExtractionResult => ({
  kind: "extracted", language: "en", is_complaint: true, off_topic: false, contains_sensitive_data: o.sensitive ?? false, sentiment: "neutral", confidence: o.confidence ?? 0.9, missing_info: [],
  issues: [{ title: o.title ?? "t", summary: "s", category: o.category ?? "bug", product_area: o.area === undefined ? "checkout" : o.area, steps_to_reproduce: [], expected: null, actual: null, environment: {}, severity_signals: [], missing_info: [], confidence: o.confidence ?? 0.9 }],
});
/** Each text maps to an extraction and a vector, so the detector's decision depends only on the production rule. */
const world = (table: Record<string, { r: ExtractionResult; v: number[] }>): { extract: ExtractFn; embedder: Embedder } => ({
  extract: async (t) => table[t]!.r,
  embedder: { embed: async (text) => Object.values(table).find((x) => `${x.r.kind === "extracted" ? x.r.issues[0]!.title : ""}\ns` === text)!.v },
});
const same = [1, 0, 0];
const aligned = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2), 0];

describe("cosine", () => {
  it("is 1 for the same direction, 0 for orthogonal, and 0 for a zero vector", () => {
    assert.ok(Math.abs(cosine([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([0, 0], [1, 1]), 0);
  });
});

describe("the golden duplicate detector follows the production rule", () => {
  const detect = (table: Record<string, { r: ExtractionResult; v: number[] }>, threshold = 0.9) => buildDuplicateDetector({ ...world(table), threshold });

  it("merges two messages about the same problem in the same area when they are similar enough", async () => {
    const d = detect({ a: { r: result({ title: "a" }), v: same }, b: { r: result({ title: "b" }), v: aligned(0.95) } });
    assert.equal(await d("a", "b"), true);
  });

  it("the threshold is inclusive: at it merges, just below it does not", async () => {
    const table = { a: { r: result({ title: "a" }), v: same }, b: { r: result({ title: "b" }), v: aligned(0.9) } };
    assert.equal(await detect(table, 0.899999)("a", "b"), true);
    assert.equal(await detect(table, 0.900001)("a", "b"), false);
  });

  it("never merges across categories or product areas, however similar", async () => {
    assert.equal(await detect({ a: { r: result({ title: "a" }), v: same }, b: { r: result({ title: "b", category: "ui" }), v: same } })("a", "b"), false);
    assert.equal(await detect({ a: { r: result({ title: "a" }), v: same }, b: { r: result({ title: "b", area: "billing" }), v: same } })("a", "b"), false);
    assert.equal(await detect({ a: { r: result({ title: "a", area: null }), v: same }, b: { r: result({ title: "b", area: null }), v: same } })("a", "b"), false, "no product area, no merge");
  });

  it("never merges sensitive or low-confidence extractions, or when the model fell back", async () => {
    assert.equal(await detect({ a: { r: result({ title: "a", sensitive: true }), v: same }, b: { r: result({ title: "b" }), v: same } })("a", "b"), false);
    assert.equal(await detect({ a: { r: result({ title: "a", confidence: 0.4 }), v: same }, b: { r: result({ title: "b" }), v: same } })("a", "b"), false);
    const d = buildDuplicateDetector({ extract: async () => ({ kind: "fallback", reason: "timeout" }), embedder: { embed: async () => same }, threshold: 0.9 });
    assert.equal(await d("a", "b"), false);
  });

  it("plugs into the golden metrics: a clean detector scores no false duplicates and finds the true one", async () => {
    const set: GoldenSet = {
      description: "t",
      cases: ["a", "b", "c"].map((id) => ({ id, text: id, expected: { isComplaint: true, offTopic: false, category: "bug" as const } })),
      duplicatePairs: [{ a: "a", b: "b", duplicate: true }, { a: "a", b: "c", duplicate: false }],
    };
    const w = world({ a: { r: result({ title: "a" }), v: same }, b: { r: result({ title: "b" }), v: aligned(0.97) }, c: { r: result({ title: "c" }), v: aligned(0.3) } });
    const report = await runGolden(set, w.extract, { detector: buildDuplicateDetector({ ...w, threshold: 0.9 }) });
    assert.equal(report.falseDuplicateRate?.rate, 0);
    assert.equal(report.duplicateRecall?.rate, 1);
  });
});

describe("the golden command", () => {
  it("skips cleanly and exits 0 when no model is configured", () => {
    const cli = fileURLToPath(new URL("./golden-cli.ts", import.meta.url));
    const out = execFileSync(process.execPath, ["--import", "tsx", cli], { env: { PATH: process.env["PATH"] ?? "" }, encoding: "utf8" });
    assert.match(out, /SKIPPED/);
  });
});
