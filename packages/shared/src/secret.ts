import { inspect } from "node:util";

const MASK = "[REDACTED]";

/**
 * Wraps a secret string so it cannot leak by accident. The value sits in a #private field:
 * String(), template strings, JSON.stringify, console.log and util.inspect all print the mask.
 * The only way out is the explicit `reveal()` call, which is easy to grep for.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [Symbol.toPrimitive](): string {
    return MASK;
  }

  [inspect.custom](): string {
    return MASK;
  }
}

const SENSITIVE_KEY = /token|secret|password|passwd|api[-_]?key|authorization|credential|cookie/i;

/**
 * Returns a deep copy that is safe to log: Secret instances and values under sensitive-looking
 * keys become "[REDACTED]". Handles cycles. Does not look inside strings.
 */
export function redactForLog(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Secret) return MASK;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, seen));
  if (value instanceof Error) return { name: value.name, message: value.message };
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? MASK : redactForLog(v, seen);
  }
  return out;
}

/** Resolves a `credentials_ref` (what the DB stores) to a secret. Only the ref is ever persisted. */
export interface SecretProvider {
  get(ref: string): Promise<Secret | undefined>;
}

/** Local implementation: `env:NAME` reads process env variable NAME. */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: Readonly<Record<string, string | undefined>>) {}

  async get(ref: string): Promise<Secret | undefined> {
    if (!ref.startsWith("env:")) throw new Error("Unsupported credentials_ref scheme (expected env:NAME)");
    const value = this.env[ref.slice(4)];
    return value ? new Secret(value) : undefined;
  }
}
