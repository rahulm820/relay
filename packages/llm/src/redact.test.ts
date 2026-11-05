import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactDeep } from "./redact.js";

test("redacts a Luhn-valid card number and reports the kind", () => {
  const r = redact("I was charged on 4111 1111 1111 1111 twice");
  assert.equal(r.text, "I was charged on [CARD] twice");
  assert.deepEqual(r.kinds, ["card"]);
});

test("does not redact a digit string that fails Luhn", () => {
  const r = redact("reference 4111 1111 1111 1112");
  assert.equal(r.text, "reference 4111 1111 1111 1112");
  assert.deepEqual(r.kinds, []);
});

test("redacts an OTP after its label", () => {
  const r = redact("my OTP is 428193 and it expired");
  assert.equal(r.text, "my OTP is [OTP] and it expired");
  assert.deepEqual(r.kinds, ["otp"]);
});

test("does not treat an ordinary promo code as an OTP", () => {
  const r = redact("promo code 2024 does not work");
  assert.equal(r.text, "promo code 2024 does not work");
  assert.deepEqual(r.kinds, []);
});

test("does not redact a complaint that merely mentions a password", () => {
  const r = redact("my password is wrong every time");
  assert.equal(r.text, "my password is wrong every time");
  assert.deepEqual(r.kinds, []);
});

test("redacts a password value that looks like a secret", () => {
  const r = redact("password is Summer2024 please help");
  assert.equal(r.text, "password is [PASSWORD] please help");
  assert.deepEqual(r.kinds, ["password"]);
});

test("redacts government IDs: US SSN and PAN-shaped codes", () => {
  const r = redact("SSN 123-45-6789 and PAN ABCDE1234F on file");
  assert.equal(r.text, "SSN [GOV_ID] and PAN [GOV_ID] on file");
  assert.deepEqual(r.kinds, ["government_id"]);
});

test("redacts API keys and bearer-style tokens", () => {
  const r = redact("key sk-abcdefghijklmnop1234 and eyJhbGciOi.payload12345.signature123");
  assert.equal(r.text, "key [KEY] and [TOKEN]");
  assert.deepEqual(r.kinds, ["key"]);
});

test("is idempotent", () => {
  const once = redact("card 4111 1111 1111 1111, otp is 998877, password is hunter222");
  assert.equal(redact(once.text).text, once.text);
});

test("redactDeep walks nested structures and unions the kinds", () => {
  const out = redactDeep({
    title: "Card 4111 1111 1111 1111 declined",
    issues: [{ steps_to_reproduce: ["enter OTP is 123456"], environment: { browser: "Chrome" } }],
    confidence: 0.8,
  });
  assert.equal(out.value.title, "Card [CARD] declined");
  assert.equal(out.value.issues[0]?.steps_to_reproduce[0], "enter OTP is [OTP]");
  assert.equal(out.value.issues[0]?.environment.browser, "Chrome");
  assert.equal(out.value.confidence, 0.8);
  assert.deepEqual(out.kinds.sort(), ["card", "otp"]);
});
