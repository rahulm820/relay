// BASELINE redaction applied to message text before it is stored in messages.text_redacted.
//
// This is a safety net, not a privacy guarantee. It uses regular expressions, so it catches the common
// shapes below and nothing else. NOT covered: personal names, street addresses, national ID formats,
// account numbers without a keyword, secrets split across lines, non-Latin digit forms, and anything
// cleverly obfuscated ("four one one one ..."). It also over-redacts on purpose: "token is expired"
// becomes "token is [REDACTED]". Issue #7 owns real redaction; it replaces this by injection (see
// `Redactor` and the `redact` option of ingestMessage / buildServer).

export type Redactor = (text: string) => string;

/** Luhn checksum, to tell real card numbers from other long digit strings. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export const baselineRedact: Redactor = (text) =>
  text
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer [TOKEN]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, "[KEY]")
    .replace(/\b(password|passwd|pwd|passcode|secret|token|api[_-]?key|apikey|pin|cvv)\b(\s*(?:is|:|=)\s*)(\S+)/gi, "$1$2[REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? "[CARD]" : m))
    .replace(/\b(otp|code|verification code|one[- ]time (?:password|code))\b([^0-9\n]{0,20})(\d{4,8})\b/gi, "$1$2[OTP]")
    .replace(/\+\d[\d ()-]{7,}\d|\(?\b\d{3}\)?[ -]\d{3}[ -]\d{4}\b/g, "[PHONE]")
    .replace(/\d{9,}/g, "[NUMBER]");
