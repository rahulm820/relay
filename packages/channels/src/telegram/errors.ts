/** Base for everything the Telegram client throws. Messages never contain URLs, tokens or message text. */
export class TelegramError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "TelegramError";
  }
}

/** 429: flood control. `retryAfter` is in seconds, as Telegram reports it. */
export class TelegramRateLimitError extends TelegramError {
  constructor(readonly retryAfter: number) {
    super("telegram rate limit", "rate_limited");
    this.name = "TelegramRateLimitError";
  }
}

/** 403: the user blocked the bot, deactivated their account, or the bot may not write to this chat. */
export class TelegramBlockedError extends TelegramError {
  constructor(readonly description: string) {
    super("telegram refused: forbidden", "blocked");
    this.name = "TelegramBlockedError";
  }
}

/** 401: the bot token is wrong or revoked. */
export class TelegramAuthError extends TelegramError {
  constructor() {
    super("telegram rejected the bot token", "unauthorized");
    this.name = "TelegramAuthError";
  }
}

/** Any other `ok: false` answer. */
export class TelegramApiError extends TelegramError {
  constructor(readonly status: number, readonly description: string) {
    super(`telegram api error ${status}`, `api_${status}`);
    this.name = "TelegramApiError";
  }
}

/** The request never produced an answer (DNS, refused, timeout). */
export class TelegramNetworkError extends TelegramError {
  constructor(code: string) {
    super("telegram unreachable", `network_${code}`);
    this.name = "TelegramNetworkError";
  }
}
