import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for message text at rest. Layout of the stored bytes:
//   [1 byte version = 1][12 byte IV][16 byte auth tag][ciphertext]
// A fresh random IV per message; the tag makes tampering detectable. One key, no rotation yet.
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

/** Decodes a base64 key and checks it is exactly 32 bytes. Throws without echoing the value. */
export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes, base64-encoded");
  return key;
}

export function encryptText(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Throws if the data was altered, the key is wrong, or the version is unknown. */
export function decryptText(key: Buffer, data: Buffer): string {
  if (data.length < 1 + IV_LEN + TAG_LEN || data[0] !== VERSION) throw new Error("unsupported ciphertext");
  const iv = data.subarray(1, 1 + IV_LEN);
  const tag = data.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(1 + IV_LEN + TAG_LEN)), decipher.final()]).toString("utf8");
}
