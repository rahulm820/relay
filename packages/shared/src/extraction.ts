import { z } from "zod";
import { CATEGORIES } from "./enums.js";

// LLM extraction contract shared by the orchestrator (#6) and the LLM service (#7).
// Shape follows architecture §7.2. Callers branch on `kind`; the extractor never throws
// for LLM-side failures, it returns a FallbackResult instead.

export const ExtractedIssueSchema = z.object({
  title: z.string().min(1),
  summary: z.string(),
  category: z.enum(CATEGORIES),
  product_area: z.string().nullable().default(null),
  steps_to_reproduce: z.array(z.string()).default([]),
  expected: z.string().nullable().default(null),
  actual: z.string().nullable().default(null),
  environment: z.record(z.string(), z.string()).default({}),
  severity_signals: z.array(z.string()).default([]),
  missing_info: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});
export type ExtractedIssue = z.infer<typeof ExtractedIssueSchema>;

export const SENTIMENTS = ["neutral", "frustrated", "angry", "positive"] as const;

/** What the model must return: JSON only, no `kind` (the service adds it). */
export const ExtractionOutputSchema = z.object({
  language: z.string().min(2),
  is_complaint: z.boolean(),
  off_topic: z.boolean(),
  issues: z.array(ExtractedIssueSchema),
  contains_sensitive_data: z.boolean(),
  sentiment: z.enum(SENTIMENTS).default("neutral"),
  /** Overall confidence in the extraction, 0..1. */
  confidence: z.number().min(0).max(1),
  /** Union of facts still needed from the client; drives clarifying questions. */
  missing_info: z.array(z.string()).default([]),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

export const ExtractionResultSchema = ExtractionOutputSchema.extend({
  kind: z.literal("extracted"),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export const FALLBACK_REASONS = [
  "llm_error",
  "timeout",
  "rate_limited",
  "invalid_json",
  "schema_invalid",
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** Returned instead of throwing when the LLM fails; the orchestrator creates a P3 triage ticket. */
export const FallbackResultSchema = z.object({
  kind: z.literal("fallback"),
  reason: z.enum(FALLBACK_REASONS),
  /** Short diagnostic. Must never contain client message text. */
  detail: z.string().optional(),
});
export type FallbackResult = z.infer<typeof FallbackResultSchema>;

export const ExtractionOutcomeSchema = z.discriminatedUnion("kind", [
  ExtractionResultSchema,
  FallbackResultSchema,
]);
export type ExtractionOutcome = ExtractionResult | FallbackResult;

export function isFallback(outcome: ExtractionOutcome): outcome is FallbackResult {
  return outcome.kind === "fallback";
}

export interface ExtractionContext {
  tenantId: string;
  conversationId: string;
  traceId: string;
}

/** The only entry point #6 calls and #7 implements. `redactedText` is already redacted. */
export type ExtractFn = (
  redactedText: string,
  ctx: ExtractionContext,
) => Promise<ExtractionResult | FallbackResult>;
