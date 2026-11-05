// Redaction applied before any model call and before any extraction output is stored (Issue #7).
// It runs on the input the extractor receives (already baseline-redacted by @relay/channels) and
// again on every string the model returns, so a sensitive value echoed back is removed too.
//
// Regex-based, so it is a safety net, not a guarantee. Covered: card numbers (Luhn-checked), OTPs,
// passwords/PINs/CVVs, API keys and tokens, US SSNs, Aadhaar-shaped and PAN-shaped IDs.
// Not covered: names, addresses, free-text secrets without a keyword, obfuscated digits.

export type SensitiveKind = "card" | "otp" | "password" | "key" | "government_id";

export interface RedactionResult {
  text: string;
  /** Kinds of sensitive values found. Empty when nothing was redacted. */
  kinds: SensitiveKind[];
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

interface Rule {
  kind: SensitiveKind;
  apply: (text: string, mark: () => void) => string;
}

const replaceAll = (pattern: RegExp, replacement: string, kind: SensitiveKind): Rule => ({
  kind,
  apply: (text, mark) => text.replace(pattern, () => {
    mark();
    return replacement;
  }),
});

const RULES: Rule[] = [
  replaceAll(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, "[KEY]", "key"),
  replaceAll(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[TOKEN]", "key"),
  {
    // "my password is wrong" must not trip this: the value has to look like a secret
    // (contains a digit or symbol, or is long), not an ordinary word.
    kind: "password",
    apply: (text, mark) => text.replace(
      /\b(password|passwd|pwd|passcode|pin|cvv|cvc)\b(\s*(?:is|:|=)\s*)(\S+)/gi,
      (m, label: string, sep: string, value: string) => {
        if (!/[\d\W_]/.test(value) && value.length < 12) return m;
        mark();
        return `${label}${sep}[PASSWORD]`;
      },
    ),
  },
  {
    // Bare "code" is deliberately not a trigger: "promo code 2024" is not a one-time code.
    kind: "otp",
    apply: (text, mark) => text.replace(
      /\b(otp|one[- ]time (?:password|code)|verification code|security code|passcode)\b([^0-9\n]{0,20})(\d{4,8})\b/gi,
      (_m, label: string, sep: string) => {
        mark();
        return `${label}${sep}[OTP]`;
      },
    ),
  },
  {
    kind: "card",
    apply: (text, mark) => text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
      const digits = m.replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
      mark();
      return "[CARD]";
    }),
  },
  replaceAll(/\b\d{3}-\d{2}-\d{4}\b/g, "[GOV_ID]", "government_id"),
  // Standalone 12-digit ID, optionally grouped 4-4-4. Not a slice of a longer digit run (e.g. a 16-digit card).
  replaceAll(/(?<![\w-])(?<!\d[ -])(?:\d[ -]?){11}\d(?![\w-])(?![ -]\d)/g, "[GOV_ID]", "government_id"),
  replaceAll(/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[GOV_ID]", "government_id"),
];

/** Replaces sensitive values with placeholders and reports which kinds were found. Idempotent. */
export function redact(input: string): RedactionResult {
  const kinds = new Set<SensitiveKind>();
  let text = input;
  for (const rule of RULES) {
    text = rule.apply(text, () => kinds.add(rule.kind));
  }
  return { text, kinds: [...kinds] };
}

/** Applies `redact` to every string inside a JSON-like value. Keys are kept; sensitive kinds are unioned. */
export function redactDeep<T>(value: T): { value: T; kinds: SensitiveKind[] } {
  const kinds = new Set<SensitiveKind>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redact(v);
      r.kinds.forEach((k) => kinds.add(k));
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  return { value: walk(value) as T, kinds: [...kinds] };
}
