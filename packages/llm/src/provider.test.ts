import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { geminiProvider, ProviderError } from "./provider.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("gemini adapter sends the key in a header, not the URL, and returns the model text", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init?.headers as Record<string, string>;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }] }), { status: 200 });
  }) as typeof fetch;

  const p = geminiProvider({ apiKey: "SECRET-KEY" });
  const res = await p.complete({ model: "flash", system: "s", user: "u", signal: new AbortController().signal });
  assert.equal(res.text, "{\"ok\":true}");
  assert.equal(seenHeaders["x-goog-api-key"], "SECRET-KEY");
  assert.doesNotMatch(seenUrl, /SECRET-KEY/);
});

test("gemini adapter maps HTTP 429 to rate_limited", async () => {
  globalThis.fetch = (async () => new Response("slow down", { status: 429 })) as typeof fetch;
  const p = geminiProvider({ apiKey: "k" });
  await assert.rejects(
    p.complete({ model: "m", system: "s", user: "u", signal: new AbortController().signal }),
    (err: unknown) => err instanceof ProviderError && err.kind === "rate_limited",
  );
});

test("gemini adapter maps other HTTP errors to llm_error", async () => {
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  const p = geminiProvider({ apiKey: "k" });
  await assert.rejects(
    p.complete({ model: "m", system: "s", user: "u", signal: new AbortController().signal }),
    (err: unknown) => err instanceof ProviderError && err.kind === "llm_error",
  );
});
