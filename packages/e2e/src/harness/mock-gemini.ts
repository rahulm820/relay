// A local stand-in for the Gemini generateContent endpoint, so the real extractor, redaction and validation run
// against scripted answers. Test-only; the API key it sees is fake.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface GeminiRequest { model: string; userPrompt: string; authed: boolean }
/** Returns the model's JSON answer for a prompt (the text between the untrusted delimiters is the client's message). */
export type Responder = (clientText: string) => unknown;

/** What the model would say about a few kinds of message. Enough to drive the demo story deterministically. */
export const scriptedExtraction: Responder = (text) => {
  const base = { language: "en", is_complaint: true, off_topic: false, contains_sensitive_data: false, sentiment: "frustrated", confidence: 0.92, missing_info: [] as string[] };
  if (/checkout|pay now|payment/i.test(text)) {
    return { ...base, issues: [{
      title: "Checkout fails with a server error when paying", summary: "Tapping Pay now at checkout returns an error 500, so the customer cannot complete the purchase.",
      category: "bug", product_area: "checkout", steps_to_reproduce: ["Add an item to the cart", "Tap Pay now"], expected: "The order is placed", actual: "Error 500 is shown",
      environment: {}, severity_signals: ["payment_failure"], missing_info: [], confidence: 0.92 }] };
  }
  return { ...base, issues: [{
    title: "Something looks wrong in the app", summary: "The customer reports a problem.", category: "other", product_area: null, steps_to_reproduce: [], expected: null, actual: null,
    environment: {}, severity_signals: [], missing_info: [], confidence: 0.8 }] };
};

export class MockGemini {
  readonly requests: GeminiRequest[] = [];
  responder: Responder = scriptedExtraction;
  /** Statuses to answer with instead of a model answer, one per request, first in first out. */
  private failures: number[] = [];
  url = "";
  private server!: Server;

  fail(...statuses: number[]): void { this.failures.push(...statuses); }
  reset(): void { this.requests.length = 0; this.failures = []; this.responder = scriptedExtraction; }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const userPrompt = String(body?.contents?.[0]?.parts?.[0]?.text ?? "");
      const model = /\/models\/([^:/]+):generateContent/.exec(req.url ?? "")?.[1] ?? "";
      this.requests.push({ model, userPrompt, authed: String(req.headers["x-goog-api-key"] ?? "") !== "" });
      const failure = this.failures.shift();
      if (failure !== undefined) return void res.writeHead(failure, { "content-type": "application/json" }).end(JSON.stringify({ error: "mock failure" }));
      const clientText = /<client_message_untrusted>\n([\s\S]*?)\n<\/client_message_untrusted>/.exec(userPrompt)?.[1] ?? userPrompt;
      const answer = JSON.stringify(this.responder(clientText));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] }));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop(): Promise<void> { return new Promise((r) => { this.server.closeAllConnections(); this.server.close(() => r()); }); }
}
