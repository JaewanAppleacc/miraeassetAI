// Turn P6 section C.7: Style/Contract Scorer. Deterministic, regex-level
// checks only (no semantic/NLP pass, same discipline as
// hard-claim-grounding.mjs) for: a raw internal enum/snake_case token
// leaking into the answer (e.g. "CONSOLIDATED", "value_status", a bare
// metric_code), a raw corp_code (8-digit) not in the expected corp_code
// set, a duplicated sentence, and a "double bullet"/malformed-label
// artifact (e.g. "- - ", "•• ", "- 항목: 항목:").
import { fail, pass } from "./axis-result.mjs";

const SNAKE_CASE_TOKEN_PATTERN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const SCREAMING_ENUM_TOKEN_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const CORP_CODE_PATTERN = /\b[0-9]{8}\b/g;
const DOUBLE_BULLET_PATTERN = /(?:^|\n)\s*[-•]\s*[-•]\s+/;

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8); // short fragments/labels are not meaningful "sentences" for repetition purposes
}

export function scoreStyle({ answerText, allowedCorpCodes = [] }) {
  const text = typeof answerText === "string" ? answerText : "";
  const errorCodes = [];
  const details = {};

  const snakeTokens = [...new Set([...text.matchAll(SNAKE_CASE_TOKEN_PATTERN)].map((m) => m[0]))];
  const enumTokens = [...new Set([...text.matchAll(SCREAMING_ENUM_TOKEN_PATTERN)].map((m) => m[0]))];
  if (snakeTokens.length > 0 || enumTokens.length > 0) {
    errorCodes.push("INTERNAL_TOKEN_LEAKED");
    details.leaked_tokens = [...snakeTokens, ...enumTokens];
  }

  const allowedCorpCodeSet = new Set(allowedCorpCodes);
  const corpCodesInText = [...new Set([...text.matchAll(CORP_CODE_PATTERN)].map((m) => m[0]))];
  const unauthorizedCorpCodes = corpCodesInText.filter((code) => !allowedCorpCodeSet.has(code));
  if (unauthorizedCorpCodes.length > 0) {
    errorCodes.push("CORP_CODE_EXPOSED");
    details.unauthorized_corp_codes = unauthorizedCorpCodes;
  }

  const sentences = splitSentences(text);
  const seen = new Set();
  const duplicates = new Set();
  for (const sentence of sentences) {
    if (seen.has(sentence)) duplicates.add(sentence);
    seen.add(sentence);
  }
  if (duplicates.size > 0) {
    errorCodes.push("REPEATED_SENTENCE");
    details.repeated_sentences = [...duplicates];
  }

  if (DOUBLE_BULLET_PATTERN.test(text)) {
    errorCodes.push("MALFORMED_LABEL_OR_DOUBLE_BULLET");
  }

  if (errorCodes.length === 0) return pass();
  return fail([...new Set(errorCodes)], details);
}
