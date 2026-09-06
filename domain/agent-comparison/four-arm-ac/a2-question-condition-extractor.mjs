// Turn A2-DOCUMENTIR-NODESTORE-V1.1, Section 4: a Gold-blind extractor that
// produces `validateEvidenceDimensions()`'s required `{scope, entity,
// period, unit, row_column}` shape from a question's own text plus the
// existing, already-frozen `devtune101_conditions.v2.jsonl` artifact and
// `documents.jsonl` metadata -- no Gold answer, acceptable_sources,
// evidence span, scoring result, or critical packet ID is ever read here
// (this module imports nothing from those and takes no such parameter).
//
// Design constraint from the task: a dimension not explicitly stated in the
// question text is left `null` (the validator then trivially PASSes that
// dimension -- this module never guesses a value the question does not
// state). The one hard requirement is the opposite direction: an explicit
// 연결/별도/개별 marker actually present in the question text must never be
// missed (Section 4: "질문에 명시된 연결/별도 표현을 놓치면 계약 실패다").
//
// period/scope reuse the SAME normalization rules as the already-frozen
// scope validator (imported directly, not re-implemented) so a period
// phrase in a question and a period phrase in fetched evidence are held to
// one identical definition of what a quarter/half/year/cumulative range is.

import { normalizePeriodLabel } from "./a2-evidence-scope-validator.mjs";

export const EXTRACTOR_VERSION = "fourarm.a2-question-condition-extractor.v1";

const CONSOLIDATED_MARKERS = ["연결재무제표", "연결"];
const SEPARATE_MARKERS = ["별도재무제표", "개별재무제표", "별도", "개별"];

// ---------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------

function extractScope(questionText) {
  const text = questionText.normalize("NFKC");
  const hasConsolidated = CONSOLIDATED_MARKERS.some((m) => text.includes(m));
  const hasSeparate = SEPARATE_MARKERS.some((m) => text.includes(m));
  if (hasConsolidated && hasSeparate) return null; // genuinely ambiguous in the question itself -- never guessed
  if (hasConsolidated) return "CONSOLIDATED";
  if (hasSeparate) return "SEPARATE";
  return null;
}

// ---------------------------------------------------------------------------
// period -- reuses normalizePeriodLabel on every period-shaped substring
// found in the question text; a question stating more than one distinct,
// resolvable period (e.g. comparing two fiscal years) cannot be reduced to
// ONE required period, so this stays null rather than picking one.
// ---------------------------------------------------------------------------

const PERIOD_PHRASE_PATTERN = /\d{4}\s*년[^.,\n]{0,20}?(?:사업연도|연간|연차|상반기|반기|하반기|[1-4]\s*분기)(?:[^.,\n]{0,10}?(?:누적|3\s*개월))?/g;

// A cross-period comparison ("2023년...과 2025년... 비교") mentions 2+
// distinct years alongside a comparison connector. The keyword-adjacency
// regex above can accidentally bind its fiscal keyword to only the LAST
// year in such a sentence (Korean "A와(과) B" phrasing puts the shared
// keyword only near B), which would wrongly resolve to "only B's period is
// required" -- silently dropping A. Detected here and forced to null
// (never one arbitrarily-picked side of the comparison) rather than
// trusting a single accidental regex match.
const COMPARISON_CONNECTOR_PATTERN = /와\(과\)|대비|비교|[Vv][Ss]\.?/;
const YEAR_PATTERN = /\d{4}\s*년/g;

function isAmbiguousMultiYearComparison(text) {
  if (!COMPARISON_CONNECTOR_PATTERN.test(text)) return false;
  const years = new Set([...text.matchAll(YEAR_PATTERN)].map((m) => m[0].match(/\d{4}/)[0]));
  return years.size >= 2;
}

function extractPeriod(questionText) {
  const text = questionText.normalize("NFKC");
  if (isAmbiguousMultiYearComparison(text)) return null;
  const matches = [...text.matchAll(PERIOD_PHRASE_PATTERN)].map((m) => m[0]);
  const resolved = [];
  for (const phrase of matches) {
    const r = normalizePeriodLabel(phrase);
    if (r) resolved.push(r);
  }
  const distinct = [];
  for (const r of resolved) {
    if (!distinct.some((d) => d.fiscal_year === r.fiscal_year && d.start_month === r.start_month && d.end_month === r.end_month)) {
      distinct.push(r);
    }
  }
  return distinct.length === 1 ? distinct[0] : null;
}

// ---------------------------------------------------------------------------
// unit -- only when a denomination is EXPLICITLY named in the question
// text as the unit the answer/comparison should use (never inferred from
// the metric type).
// ---------------------------------------------------------------------------

const UNIT_TOKENS = ["원", "천원", "백만원", "억원", "십억원", "주", "%"];

function extractUnit(questionText) {
  const text = questionText.normalize("NFKC");
  // "같은 단위(백만원)로" / "단위: 원" style explicit unit statements only --
  // a bare currency word appearing incidentally (e.g. inside a company
  // name) is not a unit requirement, so this requires a unit token
  // immediately preceded by a parenthesis/colon/"단위" marker.
  const explicit = text.match(/(?:단위\s*[:：]?\s*|\()\s*(원|천원|백만원|억원|십억원|주|%)\s*\)?/);
  if (explicit && UNIT_TOKENS.includes(explicit[1])) {
    return Object.freeze({ required_unit: explicit[1], required_sign: null });
  }
  return null;
}

// ---------------------------------------------------------------------------
// row_column -- conservative by design: checkRowColumn does an exact,
// normalized STRING match (never fuzzy/semantic), so populating this with a
// paraphrased metric name would produce false REJECTs rather than catching
// real conflicts. Only a small, fixed set of canonical role phrases that
// commonly appear verbatim as DART table column headers are recognized;
// everything else is left null per "질문에 명시되지 않은 조건은 추측하지
// 않는다".
// ---------------------------------------------------------------------------

const COLUMN_ROLE_PATTERNS = [
  { pattern: /정정\s*전/, label: "정정전" },
  { pattern: /정정\s*후/, label: "정정후" },
  { pattern: /변경\s*전/, label: "변경전" },
  { pattern: /변경\s*후/, label: "변경후" },
  { pattern: /직전\s*보고서/, label: "직전" },
  { pattern: /이번\s*보고서|금번\s*보고서|당해\s*보고서/, label: "당기" },
  { pattern: /전기(?!말)/, label: "전기" },
  { pattern: /당기(?!말)/, label: "당기" },
];

function extractRowColumn(questionText) {
  const text = questionText.normalize("NFKC");
  for (const { pattern, label } of COLUMN_ROLE_PATTERNS) {
    if (pattern.test(text)) {
      return Object.freeze({ required_table_title: null, required_row_label: null, required_column_label: label });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// entity -- reuses the existing CompanyResolver's own output (the `corps`
// field already produced by devtune101_conditions.v2.jsonl's extractor) --
// this module does not re-resolve company names itself. A question naming
// more than one company cannot be reduced to one required entity, so this
// stays null (comparison questions are not this dimension's job).
// ---------------------------------------------------------------------------

function extractEntity(officialConditions) {
  const corps = officialConditions?.corps;
  if (Array.isArray(corps) && corps.length === 1 && typeof corps[0] === "string" && corps[0].trim() !== "") {
    return corps[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

// questionText: the question's own raw text (already-approved input; never
//   Gold).
// officialConditions: the `conditions` object from one row of the existing,
//   frozen `devtune101_conditions.v2.jsonl` (its own CompanyResolver output,
//   `corps`) -- optional; entity stays null without it.
export function extractQuestionConditions({ questionText, officialConditions = null } = {}) {
  if (typeof questionText !== "string" || questionText.length === 0) {
    throw new TypeError("questionText is required");
  }
  return Object.freeze({
    scope: extractScope(questionText),
    period: extractPeriod(questionText),
    unit: extractUnit(questionText),
    row_column: extractRowColumn(questionText),
    entity: extractEntity(officialConditions),
  });
}
