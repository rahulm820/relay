export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Returns a number in [0, 1). Injected so tests are deterministic; defaults to Math.random. */
  random?: () => number;
  /** A wait the remote system asked for (a rate limit's Retry-After). Honoured up to `hintCapMs`. */
  hintMs?: number;
  hintCapMs?: number;
}

/** Longest wait we will accept from a rate-limit hint: GitHub's primary limit resets hourly. */
export const DEFAULT_HINT_CAP_MS = 3_600_000;

/**
 * Delay before retry number `attempt` (1 = after the first failure): exponential, capped at `maxMs`, with "equal
 * jitter" (half fixed, half random) so a burst of failures does not retry in lockstep but never retries sooner
 * than half the exponential step. A remote hint, when larger, wins (bounded by `hintCapMs`), so we never hammer a
 * rate-limited API.
 */
export function computeBackoffMs(attempt: number, o: BackoffOptions): number {
  const exp = Math.min(o.baseMs * 2 ** Math.max(0, attempt - 1), o.maxMs);
  const jittered = exp / 2 + (o.random ?? Math.random)() * (exp / 2);
  const hint = o.hintMs !== undefined && o.hintMs > 0 ? Math.min(o.hintMs, o.hintCapMs ?? DEFAULT_HINT_CAP_MS) : 0;
  return Math.round(Math.max(jittered, hint));
}

/** The wait a thrown error asks for, if it carries one (TrackerError.retryAfterMs). */
export function retryHintOf(err: unknown): number | undefined {
  const v = (err as { retryAfterMs?: unknown })?.retryAfterMs;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}
