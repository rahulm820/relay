// The `dedupe` pipeline stage (Issue #11, architecture §4.3/§12 case 2). Embeds each extracted issue and looks for an
// open ticket of the same tenant that is a likely duplicate. It writes nothing: the ticket stage links duplicates.
//
// Never blocks a complaint: an embedding that fails, or no embedder being configured, means no matches and the
// complaint becomes its own ticket.
import { ExtractionOutcomeSchema, type Category } from "@relay/shared";
import type { StageHandler, StageContext } from "../orchestrator/index.js";
import { pickDuplicate, type DedupeCandidate } from "./engine.js";
import { NO_DEDUPE, type DedupeStageResult, type DuplicateMatch } from "./result.js";

export interface DedupeStageOptions {
  /** Returns an embedding of `text`. Undefined disables matching. Throws on failure; the stage treats that as "no match". */
  embed?: (text: string, signal: AbortSignal) => Promise<number[]>;
  /** Cosine similarity threshold (DEDUPE_SIMILARITY). */
  similarity: number;
  /** Candidate window in hours (DEDUPE_WINDOW_HOURS). */
  windowHours: number;
  /** Per embedding call, in ms. */
  embedTimeoutMs?: number;
}

const CANDIDATE_LIMIT = 5;

interface Row { id: string; category: Category; product_area: string | null; affected_client_count: number; similarity: number }

export const vectorLiteral = (v: number[]): string => `[${v.join(",")}]`;

export function dedupeStage(opts: DedupeStageOptions): StageHandler {
  const timeout = opts.embedTimeoutMs ?? 5000;

  return async (ctx: StageContext): Promise<{ result: Record<string, unknown> }> => {
    if (!opts.embed) return { result: { ...NO_DEDUPE, reason: "embedding_disabled" } };

    const parsed = ExtractionOutcomeSchema.safeParse(ctx.results["extract"]);
    if (!parsed.success || parsed.data.kind !== "extracted" || !parsed.data.is_complaint || parsed.data.off_topic) {
      return { result: { ...NO_DEDUPE } };
    }
    const outcome = parsed.data;
    const eligibleMessage = !outcome.contains_sensitive_data;

    const embeddings: (number[] | null)[] = [];
    for (const issue of outcome.issues) {
      try {
        const signal = AbortSignal.timeout(timeout);
        embeddings.push(await opts.embed(`${issue.title}\n${issue.summary}`, signal));
      } catch {
        embeddings.push(null);
      }
    }

    const matches: DuplicateMatch[] = [];
    for (const [index, issue] of outcome.issues.entries()) {
      const vector = embeddings[index];
      if (!vector) continue;
      const eligible = eligibleMessage && outcome.confidence >= 0.5 && issue.confidence >= 0.5;
      if (!eligible || !issue.product_area) continue;

      const rows = await ctx.db(async (c) => (await c.query<Row>(
        `SELECT id, category, product_area, affected_client_count, 1 - (embedding <=> $1::vector) AS similarity
           FROM tickets
          WHERE tenant_id = relay_current_tenant()
            AND embedding IS NOT NULL
            AND parent_id IS NULL
            AND status NOT IN ('resolved', 'closed', 'quarantined')
            AND category = $2 AND product_area = $3
            AND created_at > now() - make_interval(hours => $4)
          ORDER BY embedding <=> $1::vector
          LIMIT ${CANDIDATE_LIMIT}`,
        [vectorLiteral(vector), issue.category, issue.product_area, opts.windowHours],
      )).rows);

      const candidates: DedupeCandidate[] = rows.map((r) => ({
        ticketId: r.id, category: r.category, productArea: r.product_area,
        similarity: Number(r.similarity), affectedClientCount: r.affected_client_count,
      }));
      const best = pickDuplicate({ category: issue.category, productArea: issue.product_area, eligible }, candidates, opts.similarity);
      if (best) {
        matches.push({ issueIndex: index, ticketId: best.ticketId, similarity: best.similarity, affectedClientCount: best.affectedClientCount + 1 });
      }
    }

    return { result: { matches, embeddings } satisfies DedupeStageResult };
  };
}
