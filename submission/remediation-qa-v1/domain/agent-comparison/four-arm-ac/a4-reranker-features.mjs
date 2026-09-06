// 재정렬 엔진(a4-reranker-engine.mjs)용 순수 특징 추출. 평가 데이터·DB·네트워크 접근이
// 없으며, 모든 함수는 RerankerCandidate 하나와 RerankerQuestionContext 하나를 [0,1] 범위의
// 유한 수로 바꾸는 결정론적 동기 변환이다.
//
// 0과 0.5의 구분을 파일 전체에서 유지한다:
//   - 정당한 부재(예: BM25 leg가 그 후보를 아예 못 찾음)는 실제 정보이므로 0점 — rrf.mjs의
//     "없는 leg는 0 기여" 관례와 동일.
//   - 입력 결손(예: 청크 본문 미전달, 신호에 대한 질문 문맥 기대치 미제공)은 중립 0.5점 —
//     신호 하나를 계산할 수 없다는 이유로 후보를 벌점하지 않는다.

export const FEATURE_KEYS = Object.freeze([
  "bm25",
  "dense",
  "original_rrf",
  "wide_rrf",
  "lexical_overlap",
  "term_coverage",
  "metadata_match",
  "table_context",
  "provenance_completeness",
  "original_a_protect",
]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// 1-based rank -> reciprocal-style [0,1) feature. Absent/invalid rank is a
// legitimate zero (see header), never neutral.
function rankFeature(rank) {
  if (!isFiniteNumber(rank) || rank < 1) return 0;
  return 1 / (1 + rank);
}

// null = "no usable text" (missing input), never an empty array (which
// would silently read as "computed, zero overlap").
function tokenize(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const matches = text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ?? [];
}

export function lexicalOverlapFeature(candidateText, questionText) {
  const qTokens = tokenize(questionText);
  const cTokens = tokenize(candidateText);
  if (qTokens === null || cTokens === null || qTokens.length === 0) return 0.5;
  const cSet = new Set(cTokens);
  const hits = qTokens.filter((t) => cSet.has(t)).length;
  return clamp01(hits / qTokens.length);
}

// requiredMetricLabels: the question's own required metric/row-name
// vocabulary (e.g. conditions-derived, never Gold-derived) -- a DIFFERENT,
// narrower signal than lexicalOverlapFeature's full-question overlap.
export function termCoverageFeature(candidateText, requiredMetricLabels) {
  if (typeof candidateText !== "string" || candidateText.trim() === "") return 0.5;
  if (!Array.isArray(requiredMetricLabels) || requiredMetricLabels.length === 0) return 0.5;
  const normalizedText = candidateText.normalize("NFC");
  const usable = requiredMetricLabels.filter((t) => typeof t === "string" && t.length > 0);
  if (usable.length === 0) return 0.5;
  const hits = usable.filter((t) => normalizedText.includes(t.normalize("NFC"))).length;
  return clamp01(hits / usable.length);
}

export function metadataMatchFeature(candidateMetadata, questionContext) {
  if (!candidateMetadata || typeof candidateMetadata !== "object") return 0.5;
  const checks = [];
  const expectCorp = questionContext?.expected_corp_codes;
  if (Array.isArray(expectCorp) && expectCorp.length > 0) {
    checks.push(candidateMetadata.corp_code == null ? 0.5 : (expectCorp.includes(candidateMetadata.corp_code) ? 1 : 0));
  }
  const expectDocGroups = questionContext?.expected_doc_groups;
  if (Array.isArray(expectDocGroups) && expectDocGroups.length > 0) {
    checks.push(candidateMetadata.doc_group == null ? 0.5 : (expectDocGroups.includes(candidateMetadata.doc_group) ? 1 : 0));
  }
  const expectYears = questionContext?.expected_base_years;
  if (Array.isArray(expectYears) && expectYears.length > 0) {
    checks.push(candidateMetadata.base_year == null ? 0.5 : (expectYears.includes(candidateMetadata.base_year) ? 1 : 0));
  }
  const expectMonths = questionContext?.expected_base_months;
  if (Array.isArray(expectMonths) && expectMonths.length > 0) {
    checks.push(candidateMetadata.base_month == null ? 0.5 : (expectMonths.includes(candidateMetadata.base_month) ? 1 : 0));
  }
  if (checks.length === 0) return 0.5;
  return clamp01(checks.reduce((sum, v) => sum + v, 0) / checks.length);
}

export function tableContextFeature(candidate) {
  if (candidate?.row !== null && candidate?.row !== undefined && candidate?.col !== null && candidate?.col !== undefined) return 1;
  if (candidate?.is_table === true) return 0.7;
  if (candidate?.is_table === false) return 0.3;
  return 0.5;
}

const LOCATOR_STATUS_SCORE = Object.freeze({
  NODE_AND_ROW_RESOLVED: 1,
  NODE_RESOLVED_ROW_AMBIGUOUS: 0.7,
  MULTI_NODE_AMBIGUOUS: 0.5,
  EMPTY_SPANS_INVALID: 0,
});

export function provenanceCompletenessFeature(candidate) {
  const status = candidate?.locator_status;
  if (typeof status === "string" && Object.hasOwn(LOCATOR_STATUS_SCORE, status)) {
    return LOCATOR_STATUS_SCORE[status];
  }
  return 0.5;
}

// The explicit "protective signal" for candidates that were already in
// Frozen Arm A's own official top-20 -- a first-class feature (in
// addition to the engine's own fixed tie-break rule) so a config can
// weight it directly rather than relying on tie-breaking alone. Reads
// ONLY the authoritative source_membership.original_a_top20 flag, never
// the (unbounded, diagnostic-only) source_ranks.original_a number.
export function originalAProtectFeature(candidate) {
  return candidate?.source_membership?.original_a_top20 === true ? 1 : 0;
}

// candidate: a RerankerCandidate -- the real buildWideCandidatePool()
// output shape (a4-wide-candidate-pool.mjs / A4_RERANKER_V1_CONTRACT.md),
// consumed here with no remapping: source_ranks.{bm25,dense,original_a,
// wide_rrf} and source_membership.{bm25_top100,dense_top100,
// original_a_top20}.
// questionContext: a RerankerQuestionContext -- never a Gold object;
// callers must not pass one.
export function extractFeatures(candidate, questionContext) {
  if (!candidate || typeof candidate !== "object") throw new TypeError("candidate must be an object");
  const ranks = candidate.source_ranks ?? {};
  const features = Object.freeze({
    bm25: rankFeature(ranks.bm25),
    dense: rankFeature(ranks.dense),
    original_rrf: rankFeature(ranks.original_a),
    wide_rrf: rankFeature(ranks.wide_rrf),
    lexical_overlap: lexicalOverlapFeature(candidate.text, questionContext?.question_text),
    term_coverage: termCoverageFeature(candidate.text, questionContext?.required_metric_labels),
    metadata_match: metadataMatchFeature(candidate.metadata, questionContext),
    table_context: tableContextFeature(candidate),
    provenance_completeness: provenanceCompletenessFeature(candidate),
    original_a_protect: originalAProtectFeature(candidate),
  });
  for (const key of FEATURE_KEYS) {
    if (!isFiniteNumber(features[key])) throw new RangeError(`feature "${key}" computed a non-finite value`);
  }
  return features;
}
