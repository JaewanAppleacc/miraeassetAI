// Turn P5.1: shared, pure helpers for the retrieval-index sizing/dedup/
// boilerplate analysis. Nothing here does I/O. This module never claims to
// know a real tokenizer's output -- every "token" number it can produce is
// explicitly a PROXY range, never presented as an exact model token count.
import { createHash } from "node:crypto";

export const SCHEMA_VERSION = "0.1.0";

export function sha256Hex(value) {
  const bytes = typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(canonicalize(value));
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalizeExcluding(value, excludedKeys) {
  const excluded = new Set(excludedKeys);
  const clone = canonicalize(value);
  for (const key of excluded) delete clone[key];
  return clone;
}

// Whitespace-token proxy: NOT a real tokenizer. Splits on runs of
// whitespace, counts non-empty segments. Useful only as a rough,
// deterministic, language-agnostic upper reference point -- Korean text in
// particular is agglutinative and a single whitespace-delimited "word" can
// correspond to several real subword tokens.
export function whitespaceTokenProxy(text) {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

// A model-token COUNT RANGE, deliberately wide and explicitly a proxy, not
// a claim about any specific tokenizer. Chosen bounds:
//   - lower bound: char_count * LOWER_CHARS_PER_TOKEN (favorable case --
//     mostly ASCII/English/digits, ~3-4 chars/token in common BPE vocabs)
//   - upper bound: char_count * UPPER_CHARS_PER_TOKEN (Korean-heavy case --
//     many Korean BPE vocabularies split a single syllable block into
//     multiple subword tokens, commonly ~1.2-2 chars/token)
// These constants are named and exported specifically so a caller can see
// and override the assumption rather than trusting a hidden magic number.
export const TOKEN_PROXY_LOWER_CHARS_PER_TOKEN = 3.2;
export const TOKEN_PROXY_UPPER_CHARS_PER_TOKEN = 1.5;

export function tokenProxyRange(charCount) {
  if (charCount === 0) return { low: 0, high: 0 };
  return {
    low: Math.ceil(charCount / TOKEN_PROXY_LOWER_CHARS_PER_TOKEN),
    high: Math.ceil(charCount / TOKEN_PROXY_UPPER_CHARS_PER_TOKEN),
  };
}

export function utf8ByteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

// Date-like and amount-like patterns used ONLY as a PROTECTIVE signal
// (never to auto-delete anything): a chunk matching either must never be
// excluded from search consideration by a pure-frequency boilerplate rule.
// Deliberately conservative (prefers false positives -- "protect it" -- over
// false negatives -- "let a real figure get flagged as boilerplate").
const DATE_LIKE_PATTERNS = [
  /\d{4}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}/, // 2025-07-24, 2025.07.24, 2025/07/24
  /\d{4}년\s?\d{1,2}월\s?\d{1,2}일/, // 2025년 7월 24일
  /(?<!\d)\d{8}(?!\d)/, // bare 8-digit date/receipt-number-shaped run
];
const AMOUNT_LIKE_PATTERNS = [
  /\d{1,3}(,\d{3}){1,}/, // comma-grouped number, e.g. 22,764,764,160,000
  /\d{6,}/, // a bare run of 6+ digits (large won amount, share count, etc.)
];

export function containsDateLike(text) {
  return DATE_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}

export function containsAmountLike(text) {
  return AMOUNT_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isProtectedFromBoilerplate(text) {
  return containsDateLike(text) || containsAmountLike(text);
}

// A chunk composed ENTIRELY of digits/punctuation/whitespace/common
// placeholder symbols, with zero letters (Hangul or Latin) at all.
const NUMBER_ONLY_PATTERN = /^[\d\s.,%()\-+:/·]+$/;
export function isNumberOnly(text) {
  return text.trim() !== "" && NUMBER_ONLY_PATTERN.test(text);
}

// A chunk composed entirely of symbols/placeholders with no letters AND no
// digits either (e.g. "- | - | -", "※", "…").
const SYMBOL_ONLY_PATTERN = /^[\s|\-–—_※*·.,:;()\[\]{}]+$/;
export function isSymbolOnly(text) {
  return text.trim() !== "" && SYMBOL_ONLY_PATTERN.test(text) && !/\d/.test(text);
}

const PAGE_NUMBER_LIKE_PATTERN = /^\s*-?\s*\d{1,4}\s*-?\s*$/;
export function isPageNumberLike(text) {
  return PAGE_NUMBER_LIKE_PATTERN.test(text.trim());
}

// A short, safe preview for a report -- never the full text of a chunk,
// and never more than PREVIEW_MAX_CHARS characters.
export const PREVIEW_MAX_CHARS = 40;
export function safePreview(text) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > PREVIEW_MAX_CHARS ? `${trimmed.slice(0, PREVIEW_MAX_CHARS)}…` : trimmed;
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return sortedValues[index];
}

export function newHistogram(edges) {
  const buckets = new Array(edges.length + 1).fill(0);
  return {
    add(value) {
      let index = edges.findIndex((edge) => value < edge);
      if (index === -1) index = edges.length;
      buckets[index] += 1;
    },
    toJSON() {
      const labels = [];
      for (let index = 0; index <= edges.length; index += 1) {
        const lower = index === 0 ? 0 : edges[index - 1];
        const upper = index === edges.length ? null : edges[index];
        labels.push({ range: upper === null ? `${lower}+` : `${lower}-${upper}`, count: buckets[index] });
      }
      return labels;
    },
  };
}
