import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, it } from "node:test";
import { ConfigError, EnvSecretProvider, Secret, decryptText, encryptText, loadConfig, parseEncryptionKey, redactForLog } from "./index.js";

const base = { DATABASE_URL: "postgres://u:pw-DO-NOT-LEAK@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };

describe("loadConfig", () => {
  it("parses a minimal env and applies defaults", () => {
    const c = loadConfig(base);
    assert.equal(c.api.port, 8080);
    assert.equal(c.worker.port, 8081);
    assert.equal(c.llm.provider, "gemini");
    assert.equal(c.switch.gatewayUrl, "http://localhost:8000/gateway");
    assert.equal(c.github.token, undefined);
  });

  it("treats empty strings as unset and coerces ports", () => {
    const c = loadConfig({ ...base, GITHUB_TOKEN: "", API_PORT: "9000" });
    assert.equal(c.github.token, undefined);
    assert.equal(c.api.port, 9000);
  });

  it("fails with variable names only", () => {
    assert.throws(
      () => loadConfig({ REDIS_URL: "not a url SECRET-VALUE", API_PORT: "abc-SECRET-VALUE" }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /DATABASE_URL is required/);
        assert.match(err.message, /REDIS_URL is invalid/);
        assert.match(err.message, /API_PORT is invalid/);
        assert.doesNotMatch(err.message, /SECRET-VALUE/);
        return true;
      },
    );
  });

  it("rejects an unknown LLM provider by name", () => {
    assert.throws(() => loadConfig({ ...base, LLM_PROVIDER: "nope" }), /LLM_PROVIDER is invalid/);
  });
});

describe("DEV_AUTH", () => {
  const tenant = "00000000-0000-4000-8000-000000000001";
  it("is off by default and needs a tenant when on", () => {
    assert.equal(loadConfig(base).devAuth.enabled, false);
    assert.deepEqual(loadConfig({ ...base, DEV_AUTH_ENABLED: "true", DEV_AUTH_TENANT_ID: tenant }).devAuth, { enabled: true, tenantId: tenant });
    assert.throws(() => loadConfig({ ...base, DEV_AUTH_ENABLED: "true" }), /DEV_AUTH_TENANT_ID is required/);
    assert.throws(() => loadConfig({ ...base, DEV_AUTH_ENABLED: "yes" }), /DEV_AUTH_ENABLED is invalid/);
  });
  it("is refused in production", () => {
    assert.throws(() => loadConfig({ ...base, NODE_ENV: "production", DEV_AUTH_ENABLED: "true", DEV_AUTH_TENANT_ID: tenant }), /not allowed/);
  });
});

describe("MESSAGE_ENCRYPTION_KEY", () => {
  it("accepts 32 base64 bytes and rejects other lengths by name", () => {
    const ok = loadConfig({ ...base, MESSAGE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") });
    assert.equal(ok.security.messageEncryptionKey?.reveal(), Buffer.alloc(32, 7).toString("base64"));
    assert.throws(() => loadConfig({ ...base, MESSAGE_ENCRYPTION_KEY: "c2hvcnQ=" }), /MESSAGE_ENCRYPTION_KEY is invalid/);
    assert.equal(loadConfig(base).security.messageEncryptionKey, undefined);
  });
});

describe("secrets never leak", () => {
  const raw = "tok-abc123-SHOULD-NOT-APPEAR";
  const config = loadConfig({ ...base, GITHUB_TOKEN: raw, LLM_API_KEY: raw, SWITCH_ADMIN_PASSWORD: raw });

  it("masks in String, template, JSON and inspect", () => {
    const s = config.github.token!;
    assert.ok(s instanceof Secret);
    assert.equal(String(s), "[REDACTED]");
    assert.equal(`${s}`, "[REDACTED]");
    assert.equal(JSON.stringify({ s }), '{"s":"[REDACTED]"}');
    assert.equal(inspect(s), "[REDACTED]");
    assert.equal(s.reveal(), raw);
  });

  it("masks the whole config object in JSON and inspect", () => {
    assert.ok(!JSON.stringify(config).includes(raw));
    assert.ok(!inspect(config, { depth: 10 }).includes(raw));
  });

  it("redactForLog hides Secret instances and sensitive keys", () => {
    const out = JSON.stringify(redactForLog({ a: new Secret(raw), authorization: raw, nested: { api_key: raw }, ok: 1 }));
    assert.ok(!out.includes(raw));
    assert.match(out, /"ok":1/);
  });
});

describe("EnvSecretProvider", () => {
  it("resolves env:NAME refs and rejects other schemes", async () => {
    const p = new EnvSecretProvider({ FOO: "bar" });
    assert.equal((await p.get("env:FOO"))?.reveal(), "bar");
    assert.equal(await p.get("env:MISSING"), undefined);
    await assert.rejects(p.get("vault:x"));
  });
});

describe("message encryption", () => {
  const key = parseEncryptionKey(Buffer.alloc(32, 1).toString("base64"));
  it("round-trips, uses a fresh IV, and detects tampering and a wrong key", () => {
    const a = encryptText(key, "héllo 👋");
    const b = encryptText(key, "héllo 👋");
    assert.notDeepEqual(a, b);
    assert.equal(decryptText(key, a), "héllo 👋");
    assert.ok(!a.toString("utf8").includes("llo"));
    a[a.length - 1] = a[a.length - 1]! ^ 1;
    assert.throws(() => decryptText(key, a));
    assert.throws(() => decryptText(parseEncryptionKey(Buffer.alloc(32, 2).toString("base64")), b));
    assert.throws(() => parseEncryptionKey("c2hvcnQ="));
  });
});
