import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

// Stored form: scrypt$N=32768,r=8,p=1$<salt base64url>$<hash base64url>. The parameters travel with the hash, so
// they can be raised later without invalidating old hashes, and tests can use cheap ones.
export interface ScryptParams { N: number; r: number; p: number }
export const DEFAULT_SCRYPT: ScryptParams = { N: 32768, r: 8, p: 1 };
const KEY_LEN = 32;
const maxmem = (n: ScryptParams) => 128 * n.N * n.r * 2 + 1024 * 1024;

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { ...params, maxmem: maxmem(params) });
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) return null;
  const params = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  // Refuse absurd parameters from a corrupted row rather than burning CPU/memory on them.
  if (params.N < 2 || params.N > 2 ** 20 || (params.N & (params.N - 1)) !== 0 || params.r > 32 || params.p > 16) return null;
  return { params, salt: Buffer.from(m[4]!, "base64url"), key: Buffer.from(m[5]!, "base64url") };
}

/** A real hash nobody knows the password for: verifying against it costs the same as a real check. */
let dummy: Promise<string> | undefined;
export const dummyPasswordHash = (): Promise<string> => (dummy ??= hashPassword(randomBytes(24).toString("hex")));

/**
 * Constant-time check. A malformed or missing stored hash is checked against a dummy instead, so the time spent
 * does not reveal whether an account exists. Returns false for any problem.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parsed = stored ? parse(stored) : null;
  const target = parsed ?? parse(await dummyPasswordHash())!;
  const key = await scrypt(password, target.salt, target.key.length, { ...target.params, maxmem: maxmem(target.params) });
  return timingSafeEqual(key, target.key) && parsed !== null;
}
