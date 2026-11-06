// Duplicate matching rules (Issue #11). Pure: the stage supplies candidates from the database.
import type { Category } from "@relay/shared";

export interface DedupeCandidate {
  ticketId: string;
  category: Category;
  productArea: string | null;
  /** Cosine similarity, 1 - cosine distance (pgvector `<=>`). */
  similarity: number;
  affectedClientCount: number;
}

export interface DedupeSubject {
  category: Category;
  productArea: string | null;
  /** Sensitive or low-confidence extractions are never merged: a human sees them as their own tickets. */
  eligible: boolean;
}

/**
 * The best candidate that is a duplicate, or null.
 * A duplicate needs all of: eligible subject, same category, the same non-empty product area (a different area is
 * never merged, whatever the similarity), and similarity at or above the threshold. Ties go to the earlier candidate.
 */
export function pickDuplicate(subject: DedupeSubject, candidates: readonly DedupeCandidate[], threshold: number): DedupeCandidate | null {
  if (!subject.eligible || !subject.productArea) return null;
  let best: DedupeCandidate | null = null;
  for (const c of candidates) {
    if (c.category !== subject.category) continue;
    if (c.productArea !== subject.productArea) continue;
    if (c.similarity < threshold) continue;
    if (!best || c.similarity > best.similarity) best = c;
  }
  return best;
}
