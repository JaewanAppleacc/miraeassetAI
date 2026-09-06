// A/C 테스트용 합성 조건 픽스처. 메타데이터 필터 규칙은 "질문 텍스트에서 추출한
// 회사/문서군/기간/후보어만 쓴다"이며, 이 모듈은 그 모양의 손수 만든 합성 픽스처만
// 공급한다 — 실제 질문 이해 파이프라인이 아니고, 실제 평가 실행에 배선해서는 안 된다.
//
// 비유출 불변식: 이 파일의 모든 함수는 질문 텍스트 추출기가 만들 수 있는 평범한
// 회사/문서군/기간/용어 필드만 받는다. 정답 모양 필드(gold_document_ids, expected_answer,
// required_slot id, 근거 locator, 다른 arm의 결과)를 읽거나 받는 매개변수는 구조적으로
// 존재하지 않는다 — 런타임 필터가 아니라 구성 자체로 보장한다.

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
// scoped tests, not a substitute conditions.py deliverable.
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
