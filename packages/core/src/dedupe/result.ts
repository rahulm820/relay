// The dedupe stage's stored result (Issue #11). Kept dependency-light so the ticket and priority stages can import it.
import { z } from "zod";

export const DuplicateMatchSchema = z.object({
  issueIndex: z.number().int().min(0),
  ticketId: z.uuid(),
  similarity: z.number().min(0).max(1),
  /** The matched ticket's count plus this complaint. The priority stage uses it so the re-evaluation sees it. */
  affectedClientCount: z.number().int().min(2),
});
export type DuplicateMatch = z.infer<typeof DuplicateMatchSchema>;

export const DedupeStageResultSchema = z.object({
  matches: z.array(DuplicateMatchSchema),
  /** Embedding per extracted issue, in order. null when it could not be computed (the ticket is then not matched). */
  embeddings: z.array(z.array(z.number()).nullable()),
});
export type DedupeStageResult = z.infer<typeof DedupeStageResultSchema>;

export const NO_DEDUPE: DedupeStageResult = { matches: [], embeddings: [] };
