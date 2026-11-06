// The golden set's duplicate detector, built from the SAME rules production uses (the dedupe stage in @relay/core):
// the text that is embedded, who is eligible, same category and product area, and cosine similarity at or above the
// threshold, decided by the real `pickDuplicate`. Lives here (not in @relay/llm) because @relay/core depends on
// @relay/llm, and one source of truth for the rule is the point.
import { pickDuplicate } from "@relay/core";
import type { DuplicateDetector, Embedder } from "@relay/llm";
import type { ExtractFn } from "@relay/shared";

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface Analysed { category: string; productArea: string | null; eligible: boolean; vector: number[] }

export function buildDuplicateDetector(o: { extract: ExtractFn; embedder: Embedder; threshold: number }): DuplicateDetector {
  const cache = new Map<string, Promise<Analysed | null>>();
  const ctx = { tenantId: "golden", conversationId: "golden", traceId: "golden" };

  // What the stage does for one message: extract, then embed `title\nsummary` of the first issue.
  const analyse = (text: string): Promise<Analysed | null> => {
    let hit = cache.get(text);
    if (!hit) {
      hit = (async () => {
        const r = await o.extract(text, ctx);
        const issue = r.kind === "extracted" && r.is_complaint && !r.off_topic ? r.issues[0] : undefined;
        if (r.kind !== "extracted" || !issue) return null;
        const vector = await o.embedder.embed(`${issue.title}\n${issue.summary}`, AbortSignal.timeout(20_000));
        return { category: issue.category, productArea: issue.product_area, eligible: !r.contains_sensitive_data && r.confidence >= 0.5 && issue.confidence >= 0.5, vector };
      })();
      cache.set(text, hit);
    }
    return hit;
  };

  return async (a, b) => {
    const [x, y] = await Promise.all([analyse(a), analyse(b)]);
    if (!x || !y) return false;
    const match = pickDuplicate(
      { category: x.category as never, productArea: x.productArea, eligible: x.eligible },
      [{ ticketId: "other", category: y.category as never, productArea: y.productArea, similarity: cosine(x.vector, y.vector), affectedClientCount: 1 }],
      o.threshold,
    );
    return match !== null;
  };
}
