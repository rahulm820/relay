// `npm run test:golden`: runs the golden set against the configured model and prints the metrics. Exits 0 always (a
// measurement, not a gate), and skips with a clear message when no model is configured, so it is safe in `npm test`
// and never spends money unless LLM_* is set. With LLM_EMBED_MODEL set it also reports the false-duplicate rate,
// using the same duplicate rule as production.
import { createEmbedder, createExtractor, createLlmProvider, formatReport, loadGoldenSet, runGolden } from "@relay/llm";
import { loadConfig } from "@relay/shared";
import { buildDuplicateDetector } from "./golden-detector.js";

async function main(): Promise<void> {
  // Only the LLM_* and DEDUPE_* variables matter here; the other required settings are placeholders to reuse the parser.
  const config = loadConfig({ DATABASE_URL: "postgres://unused/unused", REDIS_URL: "redis://unused", ...process.env });
  const { llm } = config;
  const ready = llm.provider === "ollama" || llm.apiKey !== undefined;
  if (!ready || !llm.fastModel) {
    console.log("Golden-set extraction smoke check: SKIPPED (no model configured: set LLM_PROVIDER, LLM_API_KEY and LLM_FAST_MODEL to run it).");
    return;
  }
  const set = loadGoldenSet();
  const extract = createExtractor({ provider: createLlmProvider(llm), model: llm.fastModel, promptVersion: "extract.v1", recordRun: async () => undefined });
  const embedder = createEmbedder(llm);
  console.log(`Golden-set extraction smoke check: ${set.cases.length} messages, provider ${llm.provider}, model ${llm.fastModel}${embedder ? `, embeddings ${llm.embedModel}` : ", no embedding model"} ...`);
  const detector = embedder ? buildDuplicateDetector({ extract, embedder, threshold: config.dedupe.similarity }) : undefined;
  console.log(formatReport(await runGolden(set, extract, detector ? { detector } : {})));
}

main().catch((err: unknown) => {
  // Never fail the build over a measurement; say what happened without echoing anything sensitive.
  console.log(`Golden-set extraction smoke check: could not run (${err instanceof Error ? err.name : "error"}). Not a test failure.`);
});
