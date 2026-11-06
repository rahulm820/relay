// Golden-set smoke check for extraction (architecture §7.4): runs labelled messages through the real extractor and
// reports category accuracy, how often the model's complaint/off-topic judgement matches, the fallback rate, and
// (once duplicate detection exists) the false-duplicate rate. It is a measurement, not a gate: it never fails a build.
import { readFileSync } from "node:fs";
import { CATEGORIES, type Category, type ExtractFn } from "@relay/shared";

export interface GoldenCase {
  id: string;
  text: string;
  expected: { isComplaint: boolean; offTopic: boolean; category: Category | null };
}
export interface GoldenPair { a: string; b: string; duplicate: boolean }
export interface GoldenSet { description: string; cases: GoldenCase[]; duplicatePairs: GoldenPair[] }

/** Decides whether two messages describe the same problem. Provided by the duplicate-detection issue (#11). */
export type DuplicateDetector = (a: string, b: string) => Promise<boolean>;

export function loadGoldenSet(path: URL = new URL("../golden/golden-set.json", import.meta.url)): GoldenSet {
  return JSON.parse(readFileSync(path, "utf8")) as GoldenSet;
}

export interface Rate { correct: number; total: number; rate: number | null }
const rate = (correct: number, total: number): Rate => ({ correct, total, rate: total === 0 ? null : correct / total });

export interface GoldenReport {
  cases: number;
  /** The model answered with a valid extraction (not a fallback). */
  answered: number;
  fallbacks: number;
  /** Of the messages that should become tickets: how many got the right category. A fallback counts as wrong. */
  categoryAccuracy: Rate;
  perCategory: Record<string, Rate>;
  /** Did the model agree on "is this a complaint" and "is this off topic"? */
  complaintJudgement: Rate;
  offTopicJudgement: Rate;
  /** Non-duplicate pairs the detector wrongly merged / all non-duplicate pairs. Null until a detector exists. */
  falseDuplicateRate: Rate | null;
  /** Duplicate pairs the detector found / all duplicate pairs. Null until a detector exists. */
  duplicateRecall: Rate | null;
  misses: { id: string; expected: string; got: string }[];
}

export async function runGolden(
  set: GoldenSet,
  extract: ExtractFn,
  opts: { detector?: DuplicateDetector; concurrency?: number } = {},
): Promise<GoldenReport> {
  const ctx = { tenantId: "golden", conversationId: "golden", traceId: "golden" };
  const results = new Array<Awaited<ReturnType<ExtractFn>>>(set.cases.length);
  let next = 0;
  // A few at a time: fast enough, gentle on provider rate limits.
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, set.cases.length) }, async () => {
    while (next < set.cases.length) { const i = next++; results[i] = await extract(set.cases[i]!.text, ctx); }
  }));

  let answered = 0, fallbacks = 0, catOk = 0, catTotal = 0, complaintOk = 0, offOk = 0;
  const per: Record<string, { ok: number; total: number }> = Object.fromEntries(CATEGORIES.map((c) => [c, { ok: 0, total: 0 }]));
  const misses: GoldenReport["misses"] = [];
  set.cases.forEach((c, i) => {
    const r = results[i]!;
    if (r.kind === "fallback") fallbacks++; else answered++;
    if (r.kind === "extracted") {
      if (r.is_complaint === c.expected.isComplaint) complaintOk++;
      if (r.off_topic === c.expected.offTopic) offOk++;
    }
    if (c.expected.category) {
      catTotal++; per[c.expected.category]!.total++;
      const got = r.kind === "extracted" ? r.issues[0]?.category : undefined;
      if (got === c.expected.category) { catOk++; per[c.expected.category]!.ok++; }
      else misses.push({ id: c.id, expected: c.expected.category, got: got ?? (r.kind === "fallback" ? `fallback:${r.reason}` : "no issue") });
    }
  });

  let falseDup: Rate | null = null, recall: Rate | null = null;
  if (opts.detector) {
    const text = new Map(set.cases.map((c) => [c.id, c.text]));
    let fp = 0, neg = 0, tp = 0, pos = 0;
    for (const p of set.duplicatePairs) {
      const verdict = await opts.detector(text.get(p.a)!, text.get(p.b)!);
      if (p.duplicate) { pos++; if (verdict) tp++; } else { neg++; if (verdict) fp++; }
    }
    falseDup = rate(fp, neg);
    recall = rate(tp, pos);
  }

  return {
    cases: set.cases.length, answered, fallbacks,
    categoryAccuracy: rate(catOk, catTotal),
    perCategory: Object.fromEntries(Object.entries(per).filter(([, v]) => v.total > 0).map(([k, v]) => [k, rate(v.ok, v.total)])),
    complaintJudgement: rate(complaintOk, answered), offTopicJudgement: rate(offOk, answered),
    falseDuplicateRate: falseDup, duplicateRecall: recall, misses,
  };
}

const pct = (r: Rate | null) => (r === null ? "n/a" : r.rate === null ? "n/a (nothing to measure)" : `${(r.rate * 100).toFixed(1)}% (${r.correct}/${r.total})`);

export function formatReport(r: GoldenReport, header = "Golden-set extraction smoke check"): string {
  const lines = [
    header,
    `  messages:               ${r.cases}   answered: ${r.answered}   fallbacks: ${r.fallbacks}`,
    `  category accuracy:      ${pct(r.categoryAccuracy)}`,
    ...Object.entries(r.perCategory).map(([c, v]) => `    ${c.padEnd(9)} ${pct(v)}`),
    `  complaint judgement:    ${pct(r.complaintJudgement)}`,
    `  off-topic judgement:    ${pct(r.offTopicJudgement)}`,
    `  false-duplicate rate:   ${r.falseDuplicateRate === null ? "n/a (set LLM_EMBED_MODEL to measure it)" : pct(r.falseDuplicateRate)}`,
    `  duplicate recall:       ${r.duplicateRecall === null ? "n/a (no embedding model configured)" : pct(r.duplicateRecall)}`,
  ];
  if (r.misses.length) lines.push("  category misses:", ...r.misses.map((m) => `    ${m.id}: expected ${m.expected}, got ${m.got}`));
  return lines.join("\n");
}
