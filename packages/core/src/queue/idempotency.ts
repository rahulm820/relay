import type { Redis } from "ioredis";

/**
 * "Has this key been seen?" cache for handlers: the first claim wins, later ones are no-ops.
 * Backed by `SET key 1 NX EX ttl`, which is atomic. Producer-side dedupe lives in the enqueue script.
 */
export class IdempotencyCache {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "idem:cache:",
  ) {}

  /** True if this call claimed the key (do the work); false if it was already claimed (skip). */
  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(this.prefix + key, "1", "EX", ttlSeconds, "NX")) === "OK";
  }

  /** Forget a claim, e.g. when the work failed and a retry must be allowed to run. */
  async release(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}
