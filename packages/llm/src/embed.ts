// Embeddings for duplicate detection (Issue #11). The vector size must match tickets.embedding (vector(1024)).
import type { Config } from "@relay/shared";
import { ProviderError } from "./provider.js";

export const EMBEDDING_DIMENSIONS = 1024;

export interface Embedder {
  embed(text: string, signal: AbortSignal): Promise<number[]>;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch {
    throw new ProviderError(signal.aborted ? "timeout" : "llm_error", "embedding request failed");
  }
  if (res.status === 429) throw new ProviderError("rate_limited", "embedding rate limit (429)");
  if (!res.ok) throw new ProviderError("llm_error", `embedding HTTP ${res.status}`);
  return res.json();
}

function checked(values: unknown): number[] {
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS || !values.every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new ProviderError("llm_error", `embedding must have ${EMBEDDING_DIMENSIONS} finite numbers`);
  }
  return values as number[];
}

export function geminiEmbedder(opts: { apiKey: string; model: string; baseUrl?: string }): Embedder {
  const base = (opts.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  return {
    async embed(text, signal) {
      const json = await postJson(
        `${base}/v1beta/models/${encodeURIComponent(opts.model)}:embedContent`,
        { "x-goog-api-key": opts.apiKey },
        { content: { parts: [{ text }] }, outputDimensionality: EMBEDDING_DIMENSIONS },
        signal,
      ) as { embedding?: { values?: unknown } };
      return checked(json.embedding?.values);
    },
  };
}

export function ollamaEmbedder(opts: { model: string; baseUrl?: string }): Embedder {
  const base = (opts.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
  return {
    async embed(text, signal) {
      const json = await postJson(`${base}/api/embed`, {}, { model: opts.model, input: text }, signal) as { embeddings?: unknown[] };
      return checked(json.embeddings?.[0]);
    },
  };
}

/** Undefined when no embedding model is configured, or the provider has no embeddings endpoint (anthropic). */
export function createEmbedder(llm: Config["llm"]): Embedder | undefined {
  if (!llm.embedModel) return undefined;
  if (llm.provider === "ollama") return ollamaEmbedder({ model: llm.embedModel, baseUrl: llm.baseUrl });
  if (llm.provider === "gemini" && llm.apiKey) return geminiEmbedder({ apiKey: llm.apiKey.reveal(), model: llm.embedModel, baseUrl: llm.baseUrl });
  return undefined;
}
