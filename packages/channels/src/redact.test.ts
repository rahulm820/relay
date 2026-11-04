import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baselineRedact } from "./redact.js";

describe("baselineRedact", () => {
  const cases: [string, string, string][] = [
    ["email", "mail me at jane.doe+x@example.co.uk please", "[EMAIL]"],
    ["valid card (Luhn)", "my card 4111 1111 1111 1111 failed", "[CARD]"],
    ["dashed card", "card 5500-0000-0000-0004", "[CARD]"],
    ["international phone", "call +1 (415) 555-2671 now", "[PHONE]"],
    ["US phone", "reach me on 415-555-2671", "[PHONE]"],
    ["long digit run", "account 123456789012 is stuck", "[NUMBER]"],
    ["bearer token", "header was Bearer abcdefghijklmnop1234", "Bearer [TOKEN]"],
    ["jwt", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4f", "[TOKEN]"],
    ["api key prefix", "key sk-abcdefghijklmnopqrstuvwxyz", "[KEY]"],
    ["github token", "ghp_abcdefghijklmnopqrstuvwxyz0123", "[KEY]"],
    ["password pair", "password: hunter2 and more", "password: [REDACTED]"],
    ["pin phrase", "my pin is 4821", "pin is [REDACTED]"],
    ["otp", "the otp code is 482913", "[OTP]"],
  ];
  for (const [name, input, expected] of cases) {
    it(`redacts ${name}`, () => {
      const out = baselineRedact(input);
      assert.ok(out.includes(expected), `${name}: ${out}`);
    });
  }

  it("removes the sensitive values themselves", () => {
    const out = baselineRedact("jane@example.com 4111111111111111 password=hunter2secret +14155552671");
    for (const leaked of ["jane@example.com", "4111111111111111", "hunter2secret", "14155552671"]) assert.ok(!out.includes(leaked), leaked);
  });

  it("leaves ordinary complaint text, dates and short numbers alone", () => {
    const text = "Checkout fails with error 500 on iPhone 15 since 2026-11-04, order 1234 not paid, version 4.2.1";
    assert.equal(baselineRedact(text), text);
  });

  it("does not treat a non-Luhn 16-digit string as a card but still hides it as a number", () => {
    const out = baselineRedact("ref 1234567890123456");
    assert.ok(!out.includes("[CARD]"));
    assert.ok(out.includes("[NUMBER]"));
  });
});
