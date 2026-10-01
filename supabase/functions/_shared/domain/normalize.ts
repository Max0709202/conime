// Text normalization shared by the anime-master importer and answer normalization.
// The same function computes alias_normalized at import time and the lookup key at
// diagnosis time, so exact alias matching is consistent.

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;

/** NFKC → lower case → katakana to hiragana → drop whitespace, punctuation and symbols. Keeps 'ー'. */
export function normalizeAlias(input: string): string {
  let s = input.normalize("NFKC").toLowerCase();
  s = Array.from(s)
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp >= KATAKANA_START && cp <= KATAKANA_END ? String.fromCodePoint(cp - 0x60) : ch;
    })
    .join("");
  return s.replace(/[\p{P}\p{S}\p{Z}\p{C}]/gu, "");
}

/**
 * Cleanup for user content that is stored as entered (messages, answers, navigator input):
 * removes control characters except newline/tab and trims. Full-width characters are kept.
 */
export function cleanUserText(input: string): string {
  // deno-lint-ignore no-control-regex
  return input.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

/** Display names: NFKC (prevents look-alike variants), single spaces, no control characters. */
export function normalizeName(input: string): string {
  // deno-lint-ignore no-control-regex
  return input.normalize("NFKC").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
}

/** Splits a "複数可" free-text value into items (、, ／ / ・ newline separated). */
export function splitMultiValue(input: string): string[] {
  return input
    .split(/[、,，\/／\n;；]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
