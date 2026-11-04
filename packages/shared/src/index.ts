// @relay/shared: cross-service contracts, config and secret access.
// Domain types, zod schemas and the config loader arrive in Issue #3.
// Keep this package dependency-light: no Fastify, no Next.js.

/** Version of the LLM prompt/pipeline contract. Recorded on every llm_runs row. */
export const PIPELINE_VERSION = "0.1.0";

/** Ordered pipeline stages (architecture §4.3, Issue #6). */
export const PIPELINE_STAGES = [
  "extract",
  "dedupe",
  "priority",
  "ticket",
  "github-sync",
  "switch",
  "notify",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
