// Turn P1.1: minimal, fail-closed post-generation grounding check for a
// model-generated answer. Deliberately NOT a general semantic/NLP claim
// checker ("자유로운 표현 전체를 완벽히 의미 분석하는 새 연구는 하지 않는다") --
// it only extracts the three highest-risk hallucination-prone token
// classes in a disclosure answer (numbers, dates, document ids) via plain
// regexes, and checks each one for EXACT membership in the same tokens
// extracted from this request's own grounded Fact/Evidence data. No
// company name string-matching is implemented here: this codebase's own
// domain contract already treats corp_code, not a name string, as the
// join key/identity for a company (see domain/README.md, "기업 조인은
// corp_code를 사용합니다. 이름은 조인 키가 아닙니다.") -- an 8+ digit
// corp_code embedded in an answer is already caught by the "number" class
// below (this is how a differently-identified company's data being cited
// is actually caught in this system's own terms, without inventing a
// separate Korean-name-matching NLP pass). A real company-name check would
// require a company directory adapter this Turn does not wire in and is
// explicitly out of scope.
//
// This module is used by flows/structured-first-agent.mjs and is written
// to be reusable by any future Agent variant that also generates text via
// a ModelAdapter (see IMPLEMENTATION_GUIDE.md).

const DOCUMENT_ID_PATTERN = /(?:periodic|major|exchange|holding)_[0-9]{14}/g;
const ISO_DATE_PATTERN = /[0-9]{4}[-.][0-9]{2}[-.][0-9]{2}/g;
const KOREAN_DATE_PATTERN = /[0-9]{4}\s*년(?:\s*[0-9]{1,2}\s*월(?:\s*[0-9]{1,2}\s*일)?)?/g;
const COMMA_GROUPED_NUMBER_PATTERN = /[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?/g;
const DECIMAL_NUMBER_PATTERN = /\b[0-9]+\.[0-9]+\b/g;
const LONG_DIGIT_RUN_PATTERN = /\b[0-9]{4,}\b/g;

function normalizeNumber(token) {
  return token.replaceAll(",", "");
}

function normalizeDateDigits(token) {
  return token.replace(/[^0-9]/g, "");
}

function blankMatches(text, pattern) {
  return text.replace(pattern, (match) => " ".repeat(match.length));
}

// Order matters: each stage blanks its own matches out of the working copy
// before the next stage runs, so a comma-grouped number's digits are never
// ALSO picked up as a residual "long digit run", and a date's digits are
// never picked up as a plain number.
export function extractHardClaims(text) {
  const source = typeof text === "string" ? text : "";
  let working = source;

  const documentIds = [...working.matchAll(DOCUMENT_ID_PATTERN)].map((m) => m[0]);
  working = blankMatches(working, DOCUMENT_ID_PATTERN);

  const isoDates = [...working.matchAll(ISO_DATE_PATTERN)].map((m) => m[0]);
  working = blankMatches(working, ISO_DATE_PATTERN);
  const koreanDates = [...working.matchAll(KOREAN_DATE_PATTERN)].map((m) => m[0]);
  working = blankMatches(working, KOREAN_DATE_PATTERN);
  const dates = [...isoDates, ...koreanDates].map(normalizeDateDigits);

  const commaNumbers = [...working.matchAll(COMMA_GROUPED_NUMBER_PATTERN)].map((m) => m[0]);
  working = blankMatches(working, COMMA_GROUPED_NUMBER_PATTERN);
  const decimalNumbers = [...working.matchAll(DECIMAL_NUMBER_PATTERN)].map((m) => m[0]);
  working = blankMatches(working, DECIMAL_NUMBER_PATTERN);
  const longRunNumbers = [...working.matchAll(LONG_DIGIT_RUN_PATTERN)].map((m) => m[0]);
  const numbers = [...commaNumbers, ...decimalNumbers, ...longRunNumbers].map(normalizeNumber);

  return Object.freeze({
    documentIds: Object.freeze([...new Set(documentIds)]),
    dates: Object.freeze([...new Set(dates)]),
    numbers: Object.freeze([...new Set(numbers)]),
  });
}

// groundedFacts: [{ fact, quotes: string[] }, ...] -- the exact shape
// flows/structured-first-agent.mjs already builds. Only fields that are
// themselves part of a VALIDATED Fact/Evidence record are ever included,
// never anything derived from the question text.
function buildAllowedSourceText(groundedFacts) {
  const parts = [];
  for (const entry of groundedFacts) {
    const fact = entry.fact ?? {};
    parts.push(
      fact.raw_value_text ?? "",
      fact.normalized_value === undefined || fact.normalized_value === null ? "" : String(fact.normalized_value),
      fact.period_start ?? "",
      fact.period_end ?? "",
      fact.known_at ?? "",
      fact.valid_from ?? "",
      fact.valid_to ?? "",
      fact.as_of_date ?? "",
      fact.source_document_id ?? "",
    );
    parts.push(...(entry.quotes ?? []));
  }
  return parts.join(" \n ");
}

// Returns { ok, unsupportedClaims: [{type, value}] }. `type` is one of
// "number" | "date" | "document_id". Exact-membership check against tokens
// extracted the SAME way from the grounded source text -- not a raw
// substring-of-blob check, which would risk false positives (e.g. "345"
// wrongly matching inside an unrelated "12345678").
export function verifyHardClaims(text, groundedFacts) {
  const claims = extractHardClaims(text);
  const allowed = extractHardClaims(buildAllowedSourceText(groundedFacts));
  const allowedNumbers = new Set(allowed.numbers);
  const allowedDates = new Set(allowed.dates);
  const allowedDocumentIds = new Set([...allowed.documentIds, ...groundedFacts.map((entry) => entry.fact?.source_document_id).filter(Boolean)]);

  const unsupportedClaims = [];
  for (const value of claims.numbers) if (!allowedNumbers.has(value)) unsupportedClaims.push({ type: "number", value });
  for (const value of claims.dates) if (!allowedDates.has(value)) unsupportedClaims.push({ type: "date", value });
  for (const value of claims.documentIds) if (!allowedDocumentIds.has(value)) unsupportedClaims.push({ type: "document_id", value });

  return { ok: unsupportedClaims.length === 0, unsupportedClaims };
}

// Citation binding: the model's OWN claimed used_fact_ids/used_evidence_ids
// must be a subset of what THIS request actually authorized (grounded Fact
// ids) and actually validated (evidence ids whose validateEvidence call
// succeeded this request). Never trusts the model's claim on its own.
export function verifyCitationBinding({ usedFactIds = [], usedEvidenceIds = [], authorizedFactIds, validatedEvidenceIds }) {
  const badFactId = usedFactIds.find((id) => !authorizedFactIds.has(id));
  if (badFactId !== undefined) return { ok: false, reason: "UNAUTHORIZED_FACT_ID" };
  const badEvidenceId = usedEvidenceIds.find((id) => !validatedEvidenceIds.has(id));
  if (badEvidenceId !== undefined) return { ok: false, reason: "UNVALIDATED_EVIDENCE_ID" };
  return { ok: true, reason: null };
}

// The single entry point flows/structured-first-agent.mjs calls: combines
// the citation-binding (id-level) check and the hard-claim (text-level)
// check into one PASS/FAIL verdict plus an unsupported-claim count.
export function verifyGeneratedAnswer({ text, usedFactIds, usedEvidenceIds, authorizedFactIds, validatedEvidenceIds, groundedFacts }) {
  const binding = verifyCitationBinding({ usedFactIds, usedEvidenceIds, authorizedFactIds, validatedEvidenceIds });
  if (!binding.ok) {
    return { status: "FAIL", unsupportedClaimCount: 0, reason: binding.reason };
  }
  const claims = verifyHardClaims(text, groundedFacts);
  if (!claims.ok) {
    return { status: "FAIL", unsupportedClaimCount: claims.unsupportedClaims.length, reason: "UNSUPPORTED_HARD_CLAIM" };
  }
  return { status: "PASS", unsupportedClaimCount: 0, reason: null };
}
