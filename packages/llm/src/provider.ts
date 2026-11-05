// Provider adapters for the extraction call. Each one sends a system and user prompt and returns the
// raw text the model produced. Keys go in headers, never in URLs, so they cannot end up in logs.
import type { Config } from "@relay/shared";

export type LlmProviderName = Config["llm"]["provider"];

export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  signal: AbortSignal;
}

export interface LlmResponse {
  text: string;
  /** Provider-reported cost in USD when available, otherwise 0. */
  costUsd: number;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Thrown by providers. The extractor maps `kind` to a FallbackResult reason. */
export class ProviderError extends Error {
  constructor(
    readonly kind: "rate_limited" | "timeout" | "llm_error",
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new ProviderError("timeout", "provider request timed out");
    throw new ProviderError("llm_error", `provider network error: ${(err as Error).name}`);
  }
  if (res.status === 429) throw new ProviderError("rate_limited", "provider rate limit (429)");
  if (!res.ok) throw new ProviderError("llm_error", `provider HTTP ${res.status}`);
  return res.json();
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const missing = (what: string): never => {
  throw new ProviderError("llm_error", `provider response missing ${what}`);
};

export function geminiProvider(opts: { apiKey: string; baseUrl?: string }): LlmProvider {
  const base = (opts.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  return {
    name: "gemini",
    async complete({ model, system, user, signal }) {
      const json = await postJson(
        `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": opts.apiKey },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        },
        signal,
      ) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = str(json.candidates?.[0]?.content?.parts?.[0]?.text) ?? missing("text");
      return { text, costUsd: 0 };
    },
  };
}

export function anthropicProvider(opts: { apiKey: string; baseUrl?: string }): LlmProvider {
  const base = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  return {
    name: "anthropic",
    async complete({ model, system, user, signal }) {
      const json = await postJson(
        `${base}/v1/messages`,
        { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        { model, max_tokens: 2048, temperature: 0, system, messages: [{ role: "user", content: user }] },
        signal,
      ) as { content?: { type?: string; text?: string }[] };
      const text = json.content?.find((b) => b.type === "text")?.text ?? missing("text");
      return { text, costUsd: 0 };
    },
  };
}

export function ollamaProvider(opts: { baseUrl?: string }): LlmProvider {
  const base = (opts.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
  return {
    name: "ollama",
    async complete({ model, system, user, signal }) {
      const json = await postJson(
        `${base}/api/chat`,
        {},
        {
          model,
          stream: false,
          format: "json",
          options: { temperature: 0 },
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        },
        signal,
      ) as { message?: { content?: string } };
      const text = str(json.message?.content) ?? missing("text");
      return { text, costUsd: 0 };
    },
  };
}

/** Builds the provider named in config. Fails at startup when a required key is absent. */
export function createLlmProvider(llm: Config["llm"]): LlmProvider {
  if (llm.provider === "ollama") return ollamaProvider({ baseUrl: llm.baseUrl });
  const key = llm.apiKey?.reveal();
  if (!key) throw new Error(`LLM_API_KEY is required for provider ${llm.provider}`);
  return llm.provider === "gemini"
    ? geminiProvider({ apiKey: key, baseUrl: llm.baseUrl })
    : anthropicProvider({ apiKey: key, baseUrl: llm.baseUrl });
}
