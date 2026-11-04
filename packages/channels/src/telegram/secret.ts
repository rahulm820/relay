import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 random bits as base64url: 43 characters of A-Z a-z 0-9 _ -, the alphabet Telegram allows. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database stores: sha256 hex. The secret is high-entropy, so a fast hash is sufficient. */
export function hashWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

const DUMMY_HASH = hashWebhookSecret(randomBytes(32).toString("hex"));
const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Constant-time check of the X-Telegram-Bot-Api-Secret-Token header against the stored hash.
 * Always does the same work: a missing header, a missing stored hash or an unknown bot compares
 * against a dummy, so timing does not reveal which case it was.
 */
export function verifyWebhookSecret(header: string | undefined, storedHash: string | null | undefined): boolean {
  const known = typeof storedHash === "string" && HEX_SHA256.test(storedHash);
  const given = createHash("sha256").update(header ?? "").digest();
  const expected = Buffer.from(known ? storedHash : DUMMY_HASH, "hex");
  const equal = timingSafeEqual(given, expected);
  return equal && known && typeof header === "string" && header.length > 0;
}
