import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SECRET_HEADER, TelegramAdapter, generateWebhookSecret, hashWebhookSecret, splitMessage, verifyWebhookSecret } from "./index.js";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const nowSec = NOW / 1000;
const SECRET = generateWebhookSecret();
const adapter = (extra = {}) =>
  new TelegramAdapter({ tenantId: "tenant-1", botId: "bot-1", webhookSecretHash: hashWebhookSecret(SECRET), now: () => NOW, ...extra });
const update = (message: Record<string, unknown>, id = 10) => ({ update_id: id, message });
const priv = (over: Record<string, unknown> = {}) => ({
  message_id: 7, date: nowSec - 5, text: "checkout is broken", chat: { id: 555, type: "private" }, from: { id: 555, is_bot: false }, ...over,
});

describe("webhook secret", () => {
  it("generates 43 characters from the alphabet Telegram allows", () => {
    assert.match(generateWebhookSecret(), /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(generateWebhookSecret(), generateWebhookSecret());
  });
  it("verifies the right secret and rejects wrong, missing, empty and unregistered cases", () => {
    const hash = hashWebhookSecret(SECRET);
    assert.equal(verifyWebhookSecret(SECRET, hash), true);
    assert.equal(verifyWebhookSecret(SECRET + "x", hash), false);
    assert.equal(verifyWebhookSecret(undefined, hash), false);
    assert.equal(verifyWebhookSecret("", hash), false);
    assert.equal(verifyWebhookSecret(SECRET, null), false);
    assert.equal(verifyWebhookSecret(SECRET, "not-a-hash"), false);
  });
  it("adapter.verifyRequest reads the Telegram header", () => {
    assert.equal(adapter().verifyRequest({ headers: { [SECRET_HEADER]: SECRET }, rawBody: "" }), true);
    assert.equal(adapter().verifyRequest({ headers: { [SECRET_HEADER]: "nope" }, rawBody: "" }), false);
    assert.equal(adapter().verifyRequest({ headers: {}, rawBody: "" }), false);
  });
});

describe("parseUpdate", () => {
  it("normalises a private text message with a chat-scoped message id", () => {
    const r = adapter().parseUpdate(update(priv()));
    assert.equal(r.kind, "message");
    if (r.kind !== "message") return;
    assert.equal(r.updateId, 10);
    assert.deepEqual(r.message, {
      tenantId: "tenant-1", botId: "bot-1", channel: "telegram", platformMessageId: "555:7", platformChatId: "555",
      senderRef: "555", text: "checkout is broken", attachments: [], receivedAt: new Date((nowSec - 5) * 1000).toISOString(), replyTo: null,
    });
  });
  it("takes tenant and bot from the verified context, never from the payload", () => {
    const r = adapter().parseUpdate({ ...update(priv()), tenantId: "evil", botId: "evil" });
    assert.ok(r.kind === "message" && r.message.tenantId === "tenant-1" && r.message.botId === "bot-1");
  });
  it("ignores everything we do not process, with a reason", () => {
    const cases: [string, unknown, string][] = [
      ["edited message", { update_id: 1, edited_message: priv() }, "not_message"],
      ["channel post", { update_id: 1, channel_post: priv({ chat: { id: -100, type: "channel" } }) }, "not_message"],
      ["group chat", update(priv({ chat: { id: -5, type: "group" } })), "not_private"],
      ["bot sender", update(priv({ from: { id: 9, is_bot: true } })), "bot_sender"],
      ["no sender", update(priv({ from: undefined })), "bot_sender"],
      ["photo (no text)", update(priv({ text: undefined, photo: [{}] })), "no_text"],
      ["blank text", update(priv({ text: "   " })), "no_text"],
      ["command", update(priv({ text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] })), "command"],
      ["stale", update(priv({ date: nowSec - 3 * 86400 })), "stale"],
      ["malformed message", update({ message_id: "x" }), "unsupported"],
    ];
    for (const [name, body, reason] of cases) {
      const r = adapter().parseUpdate(body);
      assert.deepEqual([name, r.kind === "ignored" ? r.reason : r.kind], [name, reason]);
    }
  });
  it("a slash inside a normal sentence is not a command", () => {
    const r = adapter().parseUpdate(update(priv({ text: "app crashes on /settings", entities: [{ type: "bot_command", offset: 15, length: 9 }] })));
    assert.equal(r.kind, "message");
  });
  it("rejects bodies without an update_id as invalid", () => {
    for (const body of [null, "x", {}, { update_id: "1" }, []]) assert.equal(adapter().parseUpdate(body).kind, "invalid");
  });
  it("parseInbound handles JSON text and bytes and returns [] for junk", () => {
    const raw = JSON.stringify(update(priv()));
    assert.equal(adapter().parseInbound({ headers: {}, rawBody: raw }).length, 1);
    assert.equal(adapter().parseInbound({ headers: {}, rawBody: new TextEncoder().encode(raw) }).length, 1);
    assert.equal(adapter().parseInbound({ headers: {}, rawBody: "{not json" }).length, 0);
  });
});

describe("splitMessage", () => {
  it("keeps short text whole and exactly 4096 characters as one piece", () => {
    assert.deepEqual(splitMessage("hello"), ["hello"]);
    assert.equal(splitMessage("a".repeat(4096)).length, 1);
  });
  it("splits long text into pieces of at most 4096 that rejoin to the original words", () => {
    const text = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(" ");
    const pieces = splitMessage(text);
    assert.ok(pieces.length >= 2);
    for (const p of pieces) assert.ok(Array.from(p).length <= 4096);
    assert.equal(pieces.join(" "), text);
  });
  it("prefers paragraph breaks and hard-cuts text with no break at all", () => {
    const text = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
    assert.deepEqual(splitMessage(text), ["a".repeat(3000), "b".repeat(3000)]);
    const hard = splitMessage("x".repeat(5000));
    assert.deepEqual(hard.map((p) => p.length), [4096, 904]);
  });
  it("never cuts an emoji in half and counts by characters", () => {
    const pieces = splitMessage("😀".repeat(4097));
    assert.deepEqual(pieces.map((p) => Array.from(p).length), [4096, 1]);
  });
  it("rejects empty text", () => {
    assert.throws(() => splitMessage("   "));
  });
});
