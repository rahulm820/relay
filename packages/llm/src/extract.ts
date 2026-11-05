// The extraction service (Issue #7): redact, call the fast-tier model, validate, retry once on bad
// output, then fall back. Implements the ExtractFn contract from @relay/shared.
//
// Guarantees:
//  - Never throws for LLM-side failures. Those become a FallbackResult (the ticket stage then creates a
//    "needs human triage" ticket, so the client message is not lost).
//  - Sensitive values are removed from the model input and from every string in the output.
//  - One llm_runs row per provider request (a retry is a second request and a second row).
//  - Invalid JSON or schema-invalid output gets exactly one retry; a second failure is a fallback.
import { createHash } from "node:crypto";
import {
  ExtractionOutputSchema,
  type ExtractFn,
  type ExtractionResult,
  type FallbackReason,
  type FallbackResult,
} from "@relay/shared";
import { redact, redactDeep } from "./redact.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { ProviderError, type LlmProvider } from "./provider.js";

export interface LlmRunRecord {
  tenantId: string;
  model: string;
  promptVersion: string;
  /** sha256 of prompt version + the exact (redacted) user prompt. */
  inputHash: string;
  /** Redacted parsed output, or null when the model did not produce a valid object. */
  outputJson: unknown | null;
  confidence: number | null;
  latencyMs: number;
  costUsd: number;
}

export interface ExtractorOptions {
  provider: LlmProvider;
  /** Fast-tier model name, from config (LLM_FAST_MODEL). */
  model: string;
  /** Prompt version, from config/shared (PROMPT_VERSION). Recorded on every llm_runs row. */
  promptVersion: string;
  /** Persists one llm_runs row. Errors propagate so the stage is retried. */
  recordRun: (run: LlmRunRecord) => Promise<void>;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

const MAX_ATTEMPTS = 2; // one attempt plus one retry, only for invalid JSON or schema-invalid output
const DEFAULT_TIMEOUT_MS = 20_000;

/** Some models wrap JSON in a markdown fence even when told not to. Strip one fence pair if present. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return m?.[1] ?? trimmed;
}

export function createExtractor(opts: ExtractorOptions): ExtractFn {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  return async (redactedText, ctx) => {
    // 1. Redact the input again. Idempotent on already-redacted text, and a safety net if it is not.
    const input = redact(redactedText);
    const user = buildUserPrompt(input.text);
    const inputHash = createHash("sha256").update(opts.promptVersion).update("\n").update(user).digest("hex");

    let lastReason: FallbackReason = "invalid_json";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const started = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let raw: { text: string; costUsd: number };
      try {
        raw = await opts.provider.complete({ model: opts.model, system: SYSTEM_PROMPT, user, signal: controller.signal });
      } catch (err) {
        const latencyMs = now() - started;
        const reason: FallbackReason = controller.signal.aborted
          ? "timeout"
          : err instanceof ProviderError ? err.kind : "llm_error";
        await opts.recordRun({ tenantId: ctx.tenantId, model: opts.model, promptVersion: opts.promptVersion, inputHash, outputJson: null, confidence: null, latencyMs, costUsd: 0 });
        return fallback(reason, err instanceof ProviderError ? err.message : "provider error");
      } finally {
        clearTimeout(timer);
      }
      const latencyMs = now() - started;

      // 2. Parse and validate. Failures here are the only ones that get a retry.
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripFence(raw.text));
      } catch {
        await opts.recordRun({ tenantId: ctx.tenantId, model: opts.model, promptVersion: opts.promptVersion, inputHash, outputJson: null, confidence: null, latencyMs, costUsd: raw.costUsd });
        lastReason = "invalid_json";
        continue;
      }
      const checked = ExtractionOutputSchema.safeParse(parsed);
      if (!checked.success) {
        await opts.recordRun({ tenantId: ctx.tenantId, model: opts.model, promptVersion: opts.promptVersion, inputHash, outputJson: null, confidence: null, latencyMs, costUsd: raw.costUsd });
        lastReason = "schema_invalid";
        continue;
      }

      // 3. Redact everything the model returned. A card or OTP echoed back must not reach a ticket.
      const cleaned = redactDeep(checked.data);
      const sensitive = input.kinds.length > 0 || cleaned.kinds.length > 0;
      const output = cleaned.value;

      await opts.recordRun({ tenantId: ctx.tenantId, model: opts.model, promptVersion: opts.promptVersion, inputHash, outputJson: output, confidence: output.confidence, latencyMs, costUsd: raw.costUsd });

      const result: ExtractionResult = {
        ...output,
        kind: "extracted",
        contains_sensitive_data: output.contains_sensitive_data || sensitive,
      };
      return result;
    }

    return fallback(lastReason, lastReason === "schema_invalid" ? "output failed schema validation after retry" : "output was not valid JSON after retry");
  };
}

function fallback(reason: FallbackReason, detail: string): FallbackResult {
  // `detail` is a fixed diagnostic from this module or a provider status, never client message text.
  return { kind: "fallback", reason, detail };
}
