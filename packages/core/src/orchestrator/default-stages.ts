import {
  ExtractionOutcomeSchema, PIPELINE_STAGES,
  type ExtractFn, type FallbackResult, type PipelineStage,
} from "@relay/shared";
import { PermanentFailureError } from "../queue/index.js";
import { StageRegistry, type StageHandler } from "./stages.js";

/** Stand-in until Issue #7 supplies the real extractor. Always reports a typed fallback. */
export const placeholderExtract: ExtractFn = async (): Promise<FallbackResult> => ({
  kind: "fallback",
  reason: "llm_error",
  detail: "extractor not configured (placeholder until #7)",
});

/** Stage skeleton: records that nothing ran so a missing implementation is visible in the stored run. */
const noop = (stage: PipelineStage): StageHandler => async () => ({ result: { noop: true, stage } });

/** The extract stage: loads the redacted text, calls the injected extractor, stores its outcome. */
export function extractStage(extract: ExtractFn): StageHandler {
  return async (ctx) => {
    const text = await ctx.db(async (c) => {
      const { rows } = await c.query<{ text_redacted: string | null }>("SELECT text_redacted FROM messages WHERE id = $1", [ctx.messageId]);
      return rows[0]?.text_redacted ?? null;
    });
    if (text === null) throw new PermanentFailureError("message has no redacted text", "no_redacted_text");
    // No transaction is open here: the extractor may take seconds.
    const outcome = ExtractionOutcomeSchema.safeParse(
      await extract(text, { tenantId: ctx.tenantId, conversationId: ctx.conversationId, traceId: ctx.traceId }),
    );
    if (!outcome.success) throw new PermanentFailureError("extractor returned an invalid result", "invalid_extraction_result");
    return { result: { ...outcome.data } };
  };
}

/**
 * Registry with the real extract stage (using `opts.extract`) and no-op skeletons for the rest.
 * Later issues call `registry.register(stage, handler)` to replace a skeleton:
 * dedupe #11, priority #10, ticket #8, github-sync #9/#12, switch #15, notify #16.
 */
export function createDefaultStageRegistry(opts: { extract?: ExtractFn } = {}): StageRegistry {
  const registry = new StageRegistry();
  for (const stage of PIPELINE_STAGES) registry.register(stage, noop(stage));
  registry.register("extract", extractStage(opts.extract ?? placeholderExtract));
  return registry;
}
