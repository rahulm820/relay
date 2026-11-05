import type { Secret } from "@relay/shared";
import {
  TelegramApiError, TelegramAuthError, TelegramBlockedError, TelegramNetworkError, TelegramRateLimitError,
} from "./errors.js";

export const DEFAULT_TELEGRAM_API = "https://api.telegram.org";

export interface TelegramCallOptions {
  baseUrl: string;
  token: Secret;
  method: string;
  body?: Record<string, unknown>;
  fetch: typeof fetch;
  timeoutMs: number;
}

interface TelegramEnvelope {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** Bot API URLs embed the token (`/bot<token>/method`), so the URL is built here and never leaves. */
function methodUrl(baseUrl: string, token: Secret, method: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/bot${token.reveal()}/${method}`;
}

/** Calls one Bot API method. Throws a typed TelegramError; no error contains the URL or token. */
export async function callTelegram<T>(o: TelegramCallOptions): Promise<T> {
  let res: Response;
  try {
    res = await o.fetch(methodUrl(o.baseUrl, o.token, o.method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(o.body ?? {}),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: unknown } })?.cause;
    throw new TelegramNetworkError(typeof cause?.code === "string" ? cause.code : (err as Error).name);
  }
  let data: TelegramEnvelope;
  try {
    data = (await res.json()) as TelegramEnvelope;
  } catch {
    throw new TelegramApiError(res.status, "unreadable response");
  }
  if (data.ok) return data.result as T;
  const status = data.error_code ?? res.status;
  if (status === 429) throw new TelegramRateLimitError(data.parameters?.retry_after ?? 1);
  if (status === 403) throw new TelegramBlockedError(String(data.description ?? ""));
  if (status === 401) throw new TelegramAuthError();
  throw new TelegramApiError(status, String(data.description ?? ""));
}

/** Downloads a file Telegram holds. `filePath` comes from getFile. */
export async function downloadTelegramFile(o: Omit<TelegramCallOptions, "method" | "body"> & { filePath: string; maxBytes: number }): Promise<Uint8Array> {
  const url = `${o.baseUrl.replace(/\/+$/, "")}/file/bot${o.token.reveal()}/${o.filePath}`;
  let res: Response;
  try {
    res = await o.fetch(url, { signal: AbortSignal.timeout(o.timeoutMs) });
  } catch (err) {
    const cause = (err as { cause?: { code?: unknown } })?.cause;
    throw new TelegramNetworkError(typeof cause?.code === "string" ? cause.code : (err as Error).name);
  }
  if (!res.ok) throw new TelegramApiError(res.status, "file download failed");
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > o.maxBytes) throw new TelegramApiError(413, "file too large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > o.maxBytes) throw new TelegramApiError(413, "file too large");
  return bytes;
}
