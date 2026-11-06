import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeBackoffMs, retryHintOf } from "./backoff.js";

const o = { baseMs: 1000, maxMs: 60_000 };

describe("computeBackoffMs", () => {
  it("grows exponentially: the bounds double each attempt", () => {
    // random 0 -> lower bound (half the step), random ~1 -> upper bound (the whole step)
    const lo = (n: number) => computeBackoffMs(n, { ...o, random: () => 0 });
    const hi = (n: number) => computeBackoffMs(n, { ...o, random: () => 0.999999 });
    assert.deepEqual([1, 2, 3, 4].map(lo), [500, 1000, 2000, 4000]);
    assert.deepEqual([1, 2, 3, 4].map(hi), [1000, 2000, 4000, 8000]);
  });

  it("is capped at maxMs however many attempts have failed", () => {
    assert.equal(computeBackoffMs(30, { ...o, random: () => 0.999999 }), 60_000);
    assert.equal(computeBackoffMs(30, { ...o, random: () => 0 }), 30_000);
  });

  it("jitters: different random draws give different delays inside [step/2, step]", () => {
    const seen = new Set([0, 0.25, 0.5, 0.75].map((r) => computeBackoffMs(3, { ...o, random: () => r })));
    assert.equal(seen.size, 4);
    for (const d of seen) assert.ok(d >= 2000 && d <= 4000, String(d));
  });

  it("with the real Math.random the delay always stays inside the bounds", () => {
    for (let i = 0; i < 200; i++) {
      const d = computeBackoffMs(4, o);
      assert.ok(d >= 4000 && d <= 8000, String(d));
    }
  });

  it("honours a longer rate-limit hint, but never one beyond the cap", () => {
    assert.equal(computeBackoffMs(1, { ...o, random: () => 0, hintMs: 20_000 }), 20_000);
    assert.equal(computeBackoffMs(1, { ...o, random: () => 0, hintMs: 100 }), 500, "a short hint does not shorten the backoff");
    assert.equal(computeBackoffMs(1, { ...o, random: () => 0, hintMs: 10 * 3_600_000 }), 3_600_000);
    assert.equal(computeBackoffMs(1, { ...o, random: () => 0, hintMs: 90_000, hintCapMs: 30_000 }), 30_000);
  });

  it("treats attempt numbers below 1 like the first attempt", () => {
    assert.equal(computeBackoffMs(0, { ...o, random: () => 0 }), 500);
  });
});

describe("retryHintOf", () => {
  it("reads retryAfterMs off an error and ignores anything else", () => {
    assert.equal(retryHintOf(Object.assign(new Error("x"), { retryAfterMs: 5000 })), 5000);
    for (const bad of [new Error("x"), null, undefined, { retryAfterMs: "5" }, { retryAfterMs: 0 }, { retryAfterMs: NaN }]) assert.equal(retryHintOf(bad), undefined);
  });
});
