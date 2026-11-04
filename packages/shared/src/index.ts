// @relay/shared: cross-service contracts, config and secret access.
// Keep this package dependency-light: zod only. No Fastify, no Next.js.

/** Version of the pipeline contract. Recorded on every llm_runs row. */
export const PIPELINE_VERSION = "0.1.0";
/** Version of the extraction prompt. Recorded on every llm_runs row (architecture §7.4). */
export const PROMPT_VERSION = "extract.v1";

export * from "./enums.js";
export * from "./state-machine.js";
export * from "./extraction.js";
export * from "./contracts.js";
export * from "./secret.js";
export * from "./config.js";
