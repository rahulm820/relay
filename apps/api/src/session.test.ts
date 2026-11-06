import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COOKIE_NAME, LoginThrottle, clearedCookie, hashToken, newToken, readSessionToken, sessionCookie } from "./session.js";

describe("tokens", () => {
  it("are 43 characters of url-safe base64 (32 random bytes), unique, and hashed one way", () => {
    const a = newToken();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, newToken());
    assert.match(hashToken(a), /^[0-9a-f]{64}$/);
    assert.notEqual(hashToken(a), a);
    assert.equal(hashToken(a), hashToken(a));
  });
});

describe("session cookie", () => {
  const token = newToken();
  it("is HttpOnly, SameSite=Lax, scoped to /api, expiring, and Secure when asked", () => {
    const c = sessionCookie(token, 3600, false);
    for (const part of [`${COOKIE_NAME}=${token}`, "Max-Age=3600", "Path=/api", "HttpOnly", "SameSite=Lax"]) assert.ok(c.includes(part), part);
    assert.ok(!c.includes("Secure"));
    assert.ok(sessionCookie(token, 3600, true).includes("; Secure"));
  });
  it("is cleared with Max-Age=0 and the same scope", () => {
    const c = clearedCookie(true);
    assert.ok(c.startsWith(`${COOKIE_NAME}=;`) && c.includes("Max-Age=0") && c.includes("Path=/api") && c.includes("HttpOnly") && c.includes("Secure"));
  });
  it("is read from a Cookie header, and anything malformed is ignored", () => {
    assert.equal(readSessionToken(`a=1; ${COOKIE_NAME}=${token}; b=2`), token);
    for (const bad of [undefined, "", "a=1", `${COOKIE_NAME}=short`, `${COOKIE_NAME}=${token}x`, `${COOKIE_NAME}=${"!".repeat(43)}`]) assert.equal(readSessionToken(bad), null);
  });
});

describe("LoginThrottle", () => {
  const make = () => {
    let now = 1_000_000;
    return { t: new LoginThrottle({ maxPerAccount: 3, maxPerIp: 5, windowMs: 60_000, now: () => now }), tick: (ms: number) => { now += ms; } };
  };
  it("blocks an account after its limit, whatever the case of the email, and reports when to retry", () => {
    const { t } = make();
    for (let i = 0; i < 3; i++) { assert.equal(t.check("1.1.1.1", "A@x.com"), 0); t.fail("1.1.1.1", "A@x.com"); }
    assert.equal(t.check("2.2.2.2", "a@X.com"), 60);
  });
  it("recovers when the window passes", () => {
    const { t, tick } = make();
    for (let i = 0; i < 3; i++) t.fail("1.1.1.1", "a@x.com");
    assert.ok(t.check("1.1.1.1", "a@x.com") > 0);
    tick(60_001);
    assert.equal(t.check("1.1.1.1", "a@x.com"), 0);
  });
  it("a success clears the account but not the address", () => {
    const { t } = make();
    for (let i = 0; i < 3; i++) t.fail("1.1.1.1", "a@x.com");
    t.clear("a@x.com");
    assert.equal(t.check("9.9.9.9", "a@x.com"), 0);
    for (let i = 0; i < 2; i++) t.fail("1.1.1.1", "other@x.com");
    assert.ok(t.check("1.1.1.1", "fresh@x.com") > 0, "five failures from one address block it for any account");
  });
  it("counts unknown emails exactly like known ones (it cannot reveal accounts)", () => {
    const { t } = make();
    for (let i = 0; i < 3; i++) t.fail("1.1.1.1", "nobody@nowhere.example");
    assert.ok(t.check("3.3.3.3", "nobody@nowhere.example") > 0);
  });
});
