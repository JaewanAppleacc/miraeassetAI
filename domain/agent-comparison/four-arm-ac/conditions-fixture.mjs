// Turn AC-IMPL, section D (metadata non-leak): the vFINAL spec's own
// metadata-filter rule is "conditions.py extracts corp/doc-group/period/
// candidate terms from the question text only". This repository has no
// `conditions.py` (that name belongs to a DIFFERENT team's separate Python
// codebase described in the AC-IMPL reference docs -- interfaces.md /
// team-architecture-v4.txt / team-split.md -- which this repo's own
// CLAUDE.md section 0 explicitly treats as reference material with "no
// compatibility obligation"). Per vFINAL section D's own fallback rule
// ("conditions SHA가 아직 없으면 synthetic fixture로만 테스트한다"), this
// module supplies SYNTHETIC, hand-authored condition fixtures for A/C
// testing only -- it is NOT a production question-understanding pipeline
// and must never be wired to a real DEV_TUNE/DEV_CHECK/HOLDOUT run.
//
// Non-leak invariant (vFINAL 20): every function in this file accepts only
// plain corp/doc-group/period/term fields a question-text extractor could
// produce. None of them ever reads or accepts a Gold-shaped field (
// gold_document_ids, expected_answer, required_slot ids, evidence locator,
// another arm's results) -- there is no parameter named or shaped like
// those anywhere below, by construction, not by a runtime filter.

// The exact metadata_filters shape the existing, unmodified
// fixed-kure-hybrid-retriever-adapter.mjs / RetrieverRequest schema already
// expect (see scripts/p11f0-shard-integration-smoke.mjs's own
// directRequest.metadata_filters) -- this module targets that shape, it
// does not invent a new one.
const METADATA_FILTER_KEYS = Object.freeze([
  "corp_codes", "document_ids", "doc_groups", "doc_subtypes",
  "base_years", "base_months", "receipt_date_from", "receipt_date_to",
  "is_correction", "retrieval_eligible",
]);

function asArray(value) {
  return Array.isArray(value) ? [...value] : [];
}

// conditions: { corp_codes, doc_groups, doc_subtypes, base_years,
// base_months, receipt_date_from, receipt_date_to, is_correction,
// document_ids, retrieval_eligible }. Every field is OPTIONAL; absent
// fields fall back to the documented "no constraint" default. Anything
// present on `conditions` that is NOT one of METADATA_FILTER_KEYS is
// silently dropped (never merged into the filter) -- this is the
// structural non-leak guard: a caller that accidentally passes a
// Gold-shaped object through here still cannot leak it into the filter.
export function buildMetadataFiltersFromConditions(conditions = {}) {
  if (conditions === null || typeof conditions !== "object") {
    throw new TypeError("conditions must be a plain object");
  }
  return Object.freeze({
    corp_codes: asArray(conditions.corp_codes),
    document_ids: asArray(conditions.document_ids),
    doc_groups: asArray(conditions.doc_groups),
    doc_subtypes: asArray(conditions.doc_subtypes),
    base_years: asArray(conditions.base_years),
    base_months: asArray(conditions.base_months),
    receipt_date_from: conditions.receipt_date_from ?? null,
    receipt_date_to: conditions.receipt_date_to ?? null,
    is_correction: conditions.is_correction ?? null,
    retrieval_eligible: conditions.retrieval_eligible ?? true,
  });
}

export { METADATA_FILTER_KEYS };

// vFINAL section 1's own LOW/HIGH segment rule, reproduced exactly for
// reporting (n_hard_conditions = len(corp_codes) + (years∪months nonempty
// ? 1 : 0) + (doc_groups∪doc_subtypes nonempty ? 1 : 0); LOW iff n<=2).
// Used only to LABEL a synthetic fixture in test output/reports -- never
// consulted by search() itself, and never computed from Gold.
export function computeConditionSegment(conditions = {}) {
  const corpCount = asArray(conditions.corp_codes).length;
  const hasPeriod = asArray(conditions.base_years).length > 0 || asArray(conditions.base_months).length > 0
    || Boolean(conditions.receipt_date_from) || Boolean(conditions.receipt_date_to);
  const hasDocGroup = asArray(conditions.doc_groups).length > 0 || asArray(conditions.doc_subtypes).length > 0;
  const nHardConditions = corpCount + (hasPeriod ? 1 : 0) + (hasDocGroup ? 1 : 0);
  return { n_hard_conditions: nHardConditions, segment: nHardConditions <= 2 ? "LOW" : "HIGH" };
}

// Hand-authored, question-text-only, never Gold-derived. Each fixture's
// `conditions` is exactly what a question-text extractor could plausibly
// produce for its own `question` string -- these are TEST-ONLY inputs for
// this Turn's scoped tests, not a substitute conditions.py deliverable.
export const SYNTHETIC_CONDITIONS_FIXTURES = Object.freeze([
  Object.freeze({
    fixture_id: "synthetic_low_01",
    question: "삼성전자의 2024년 3월 정기공시 매출액은 얼마인가요?",
    conditions: Object.freeze({ corp_codes: ["00126380"], doc_groups: ["periodic"], base_years: [2024], base_months: [3] }),
  }),
  Object.freeze({
    fixture_id: "synthetic_high_01",
    question: "2024년 3월 이후 정정공시가 있었던 주요사항보고서 중 공급계약 해지 건은?",
    conditions: Object.freeze({ doc_groups: ["major"], base_years: [2024], base_months: [3], is_correction: true }),
  }),
  Object.freeze({
    fixture_id: "synthetic_no_conditions_01",
    question: "공급계약 해지 공시를 알려주세요",
    conditions: Object.freeze({}),
  }),
]);
