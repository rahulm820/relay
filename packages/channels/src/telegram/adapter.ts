import type { ChannelAdapter, HealthStatus, InboundRequest, NormalizedMessage, SendResult, Secret } from "@relay/shared";
import { z } from "zod";
import { DEFAULT_TELEGRAM_API, callTelegram, downloadTelegramFile } from "./api.js";
import { splitMessage } from "./chunk.js";
import { TelegramError, TelegramRateLimitError } from "./errors.js";
import { verifyWebhookSecret } from "./secret.js";

export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** The slice of a Telegram Message we read. Extra fields are allowed and ignored. */
const MessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int(),
  text: z.string().optional(),
  chat: z.object({ id: z.number().int(), type: z.string() }),
  from: z.object({ id: z.number().int(), is_bot: z.boolean().optional() }).optional(),
  entities: z.array(z.object({ type: z.string(), offset: z.number().int() })).optional(),
});

/** Only update_id is required: an update we cannot use must still be acknowledged, never retried forever. */
const UpdateSchema = z.object({ update_id: z.number().int().nonnegative(), message: z.unknown().optional() });

export type IgnoreReason = "not_message" | "unsupported" | "not_private" | "bot_sender" | "no_text" | "command" | "stale";

export type ParsedUpdate =
  | { kind: "invalid" }
  | { kind: "ignored"; updateId: number; reason: IgnoreReason }
  | { kind: "message"; updateId: number; message: NormalizedMessage };

export interface TelegramAdapterOptions {
  /** From the verified bot record, never from a payload. */
  tenantId: string;
  botId: string;
  /** sha256 hex of the webhook secret (bots.webhook_secret_hash). */
  webhookSecretHash?: string | null;
  /** Needed for send / fetchMedia / healthCheck only. */
  token?: Secret;
  /** Injectable so tests can use a local mock server. */
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Telegram allows about one message per second per chat. */
  minSendIntervalMs?: number;
  maxSendRetries?: number;
  maxRetryWaitMs?: number;
  /** Older messages are acknowledged but not processed. */
  maxUpdateAgeSeconds?: number;
  requestTimeoutMs?: number;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class TelegramAdapter implements ChannelAdapter {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;
  private readonly maxAgeSeconds: number;
  private readonly timeoutMs: number;
  /** Per chat: the tail of the send queue, so sends to one chat run one at a time, in order. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly lastSentAt = new Map<string, number>();

  constructor(private readonly o: TelegramAdapterOptions) {
    this.baseUrl = o.apiBaseUrl ?? DEFAULT_TELEGRAM_API;
    this.fetchFn = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
    this.minIntervalMs = o.minSendIntervalMs ?? 1000;
    this.maxRetries = o.maxSendRetries ?? 3;
    this.maxRetryWaitMs = o.maxRetryWaitMs ?? 60_000;
    this.maxAgeSeconds = o.maxUpdateAgeSeconds ?? 24 * 60 * 60;
    this.timeoutMs = o.requestTimeoutMs ?? 10_000;
  }

  /** True only if the secret-token header matches this bot's stored hash. Constant time. */
  verifyRequest(req: InboundRequest): boolean {
    const header = req.headers[SECRET_HEADER];
    return verifyWebhookSecret(header, this.o.webhookSecretHash);
  }

  /** Turns a decoded update into a NormalizedMessage, or says why it is being ignored. Pure. */
  parseUpdate(body: unknown): ParsedUpdate {
    const update = UpdateSchema.safeParse(body);
    if (!update.success) return { kind: "invalid" };
    const updateId = update.data.update_id;
    if (update.data.message === undefined) return { kind: "ignored", updateId, reason: "not_message" };
    const m = MessageSchema.safeParse(update.data.message);
    if (!m.success) return { kind: "ignored", updateId, reason: "unsupported" };
    const msg = m.data;
    if (msg.chat.type !== "private") return { kind: "ignored", updateId, reason: "not_private" };
    if (!msg.from || msg.from.is_bot) return { kind: "ignored", updateId, reason: "bot_sender" };
    if (msg.text === undefined || msg.text.trim() === "") return { kind: "ignored", updateId, reason: "no_text" };
    if (msg.entities?.some((e) => e.type === "bot_command" && e.offset === 0)) return { kind: "ignored", updateId, reason: "command" };
    if (msg.date < this.now() / 1000 - this.maxAgeSeconds) return { kind: "ignored", updateId, reason: "stale" };
    return {
      kind: "message",
      updateId,
      message: {
        tenantId: this.o.tenantId,
        botId: this.o.botId,
        channel: "telegram",
        // Telegram message ids repeat across chats, so the chat id is part of the key.
        platformMessageId: `${msg.chat.id}:${msg.message_id}`,
        platformChatId: String(msg.chat.id),
        senderRef: String(msg.from.id),
        text: msg.text,
        attachments: [],
        receivedAt: new Date(msg.date * 1000).toISOString(),
        replyTo: null,
      },
    };
  }

  parseInbound(req: InboundRequest): NormalizedMessage[] {
    const raw = typeof req.rawBody === "string" ? req.rawBody : Buffer.from(req.rawBody).toString("utf8");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return [];
    }
    const parsed = this.parseUpdate(body);
    return parsed.kind === "message" ? [parsed.message] : [];
  }

  /**
   * Sends plain text (no parse_mode, so the text is never interpreted as markup), split at 4096
   * characters. Sends to the same chat are serialised and spaced by minSendIntervalMs; a 429 waits
   * `retry_after` seconds and retries up to maxSendRetries times. Returns the id of the FIRST piece.
   * For Telegram the second argument is the platform chat id (for a private chat, the user id),
   * not a Relay conversation id.
   */
  async send(_botId: string, chatId: string, content: string): Promise<SendResult> {
    const pieces = splitMessage(content);
    return this.serial(chatId, async () => {
      let first: SendResult | undefined;
      for (const piece of pieces) {
        const sent = await this.sendPiece(chatId, piece);
        first ??= sent;
      }
      return first!;
    });
  }

  async fetchMedia(ref: string): Promise<Uint8Array> {
    const token = this.requireToken();
    const file = await callTelegram<{ file_path?: string }>({ baseUrl: this.baseUrl, token, method: "getFile", body: { file_id: ref }, fetch: this.fetchFn, timeoutMs: this.timeoutMs });
    if (!file.file_path) throw new TelegramError("telegram returned no file path", "no_file_path");
    return downloadTelegramFile({ baseUrl: this.baseUrl, token, fetch: this.fetchFn, timeoutMs: this.timeoutMs, filePath: file.file_path, maxBytes: MAX_FILE_BYTES });
  }

  async healthCheck(_botId: string): Promise<HealthStatus> {
    try {
      await callTelegram({ baseUrl: this.baseUrl, token: this.requireToken(), method: "getMe", fetch: this.fetchFn, timeoutMs: this.timeoutMs });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof TelegramError ? err.code : "unknown" };
    }
  }

  private requireToken(): Secret {
    if (!this.o.token) throw new TelegramError("adapter has no bot token", "no_token");
    return this.o.token;
  }

  private serial<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(chatId) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    this.chains.set(chatId, tail);
    void tail.then(() => { if (this.chains.get(chatId) === tail) this.chains.delete(chatId); });
    return run;
  }

  private async sendPiece(chatId: string, text: string): Promise<SendResult> {
    const token = this.requireToken();
    for (let attempt = 0; ; attempt++) {
      const wait = (this.lastSentAt.get(chatId) ?? -Infinity) + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        const result = await callTelegram<{ message_id: number }>({
          baseUrl: this.baseUrl, token, method: "sendMessage", fetch: this.fetchFn, timeoutMs: this.timeoutMs,
          body: { chat_id: chatId, text, link_preview_options: { is_disabled: true } },
        });
        this.lastSentAt.set(chatId, this.now());
        return { platformMessageId: `${chatId}:${result.message_id}` };
      } catch (err) {
        this.lastSentAt.set(chatId, this.now());
        if (!(err instanceof TelegramRateLimitError) || attempt >= this.maxRetries) throw err;
        await this.sleep(Math.min(err.retryAfter * 1000, this.maxRetryWaitMs));
      }
    }
  }
}
