export const TELEGRAM_MAX_TEXT = 4096;

/** Index at which to cut chars[start..end): a paragraph break, else a line break, else a space, in the later half; else `end`. */
function breakPoint(chars: string[], start: number, end: number): number {
  const floor = start + Math.floor((end - start) / 2);
  const finders = [
    (i: number) => chars[i] === "\n" && chars[i + 1] === "\n",
    (i: number) => chars[i] === "\n",
    (i: number) => chars[i] === " ",
  ];
  for (const matches of finders) {
    for (let i = end - 1; i >= floor; i--) if (matches(i)) return i;
  }
  return end;
}

/**
 * Splits text into pieces of at most `limit` characters, counted as Unicode code points so an emoji is
 * never cut in half. Whitespace at the seams is dropped; pieces are never empty.
 */
export function splitMessage(text: string, limit = TELEGRAM_MAX_TEXT): string[] {
  const chars = Array.from(text);
  const pieces: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const hardEnd = Math.min(start + limit, chars.length);
    const end = hardEnd < chars.length ? breakPoint(chars, start, hardEnd) : hardEnd;
    const piece = chars.slice(start, end).join("").trim();
    if (piece) pieces.push(piece);
    start = end;
    while (start < chars.length && /\s/.test(chars[start]!)) start++;
  }
  if (pieces.length === 0) throw new Error("cannot send an empty message");
  return pieces;
}
