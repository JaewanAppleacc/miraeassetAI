// Formalizes the completed human review of Harness v05's 17 real
// REVIEW_REQUIRED items into a real Owner decision (work/domain-seed/
// seed-response-owner-decision.v0.2.jsonl), and derives a generalized,
// non-overfit response-synthesis-requirements artifact
// (seed-response-synthesis-requirements.v0.1.json/.md) from the same 17
// judgments.
//
// P0 AUDIT DISCIPLINE (same pattern as every prior Owner-decision turn in
// this project): this script TRANSCRIBES an explicit human judgment --
// the Owner's (최재완) actual disposition for Q17 and Q22 comes verbatim
// from work/handoff/seed-final-response-owner-review/results/
// A_Q17_REVIEW_RESULT.json and C_Q22_REVIEW_RESULT.json (read, never
// invented), and the Owner's approval of the remaining 15 items reuses
// the specific, per-item issues already surfaced in the prior pre-review
// turn. This script contains NO code path that can produce
// "approved_by":"Claude" or any AI-self-approval marker -- reviewer is
// always the literal string "최재완", never a variable derived from
// process identity.
//
// Reads only -- never writes to work/domain-seed/seed-thin-flow-harness-v05.v0.1.jsonl,
// its wire response files, Gold v0.17, or seed-response-owner-review-template.v0.1.*
// (preserved byte-identical). Authors no new Fact, no Gold/Fact/Evidence/
// Event/Coverage/Relation/Chain change, no release manifest/decision/
// configured-runtime change, no per-question Thin Flow formatter.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEWED_AT = "2026-08-14T02:10:00.000Z"; // real system clock at authoring time
const REVIEWER = "최재완";

const TEMPLATE_PATH = "work/domain-seed/seed-response-owner-review-template.v0.1.jsonl";
const HARNESS_RESULT_PATH = "work/domain-seed/seed-thin-flow-harness-v05.v0.1.jsonl";
const Q17_RESULT_PATH = "work/handoff/seed-final-response-owner-review/results/A_Q17_REVIEW_RESULT.json";
const Q22_RESULT_PATH = "work/handoff/seed-final-response-owner-review/results/C_Q22_REVIEW_RESULT.json";

const DECISION_OUT = "work/domain-seed/seed-response-owner-decision.v0.2.jsonl";
const DECISION_MANIFEST_OUT = "work/domain-seed/seed-response-owner-decision.v0.2.manifest.json";
const DECISION_REVIEW_MD_OUT = "work/domain-seed/seed-response-owner-decision.v0.2.review.md";
const REQUIREMENTS_JSON_OUT = "work/domain-seed/seed-response-synthesis-requirements.v0.1.json";
const REQUIREMENTS_MD_OUT = "work/domain-seed/seed-response-synthesis-requirements.v0.1.md";

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
async function readAbs(p) { return readFile(path.join(REPO, p)); }
async function sha256OfFile(p) { return sha256(await readAbs(p)); }
async function readJsonlAbs(p) { return (await readAbs(p)).toString("utf8").trim().split("\n").map(JSON.parse); }
async function readJsonAbs(p) { return JSON.parse((await readAbs(p)).toString("utf8")); }
function jsonl(records) { return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`; }

// --- Generalized response-synthesis capability catalog. Every "applies_when"
// is a structured-signal description (intent / value-multiplicity /
// event-count / comparison-dimension / information-limit-status /
// attribution-status) -- never a question_id or company/document name. ---
const CAPABILITIES = [
  {
    capability_id: "ENTITY_AND_PERIOD_LABELING",
    description: "동일 metric에 대해 서로 다른 entity 또는 기간의 값이 여러 개 존재할 때, 각 값이 어느 entity·기간·scope에 해당하는지 응답 텍스트에서 명시적으로 라벨링한다.",
    applies_when: "calculation.value 또는 retrieved_context에 같은 metric_code/field 패턴이 2개 이상의 서로 다른 entity_id 또는 period 값과 함께 존재함 (구조화 signal: distinct (entity, period) 쌍의 개수 >= 2)",
    required_output_elements: ["각 값 옆에 해당 entity 명칭", "각 값 옆에 해당 기간(연도/기준일)", "값과 라벨의 1:1 대응"],
    forbidden_or_safety: ["라벨 없이 값만 순서대로 나열", "서로 다른 entity의 값을 하나의 문장에서 뒤섞어 어느 entity 값인지 모호하게 표현"],
    implementation_layers: ["Response Composer", "Final Validator"],
  },
  {
    capability_id: "COMPARATIVE_CONCLUSION",
    description: "이미 계산된 차이·배수·증감률이 있을 때, 그 결과가 의미하는 방향성 결론을 자연어 문장으로 표현한다 (숫자만 나열하지 않는다).",
    applies_when: "calculation.value에 diff/percent/change/ratio 계열 필드가 존재하고 그 값으로부터 도출 가능한 승자/방향/우위 결론 필드(예: *_winner, larger_*, both_*_exceeds_*)가 존재하거나 계산 가능함 (구조화 signal: comparison_dimensions >= 1)",
    required_output_elements: ["차이/배수/증감 방향을 서술하는 문장", "결론이 어느 두 대상을 비교한 것인지 명시"],
    forbidden_or_safety: ["계산된 방향성 결론을 답변에서 생략", "계산되지 않은 우열을 추가로 주장"],
    implementation_layers: ["Response Composer"],
  },
  {
    capability_id: "TEMPORAL_EVENT_SYNTHESIS",
    description: "원공시→정정→연장→해지→소각 등 다단계 사건이 있을 때, 각 사건을 날짜순으로 분리하고 각 날짜의 변경 원인과 변경된 필드를 연결해 서술한다.",
    applies_when: "validation.events >= 2 이거나 retrieved_context/related_evidence의 document_id 서로 다른 공시가 3개 이상이면서 각 공시가 서로 다른 날짜를 가짐 (구조화 signal: event_count >= 2 또는 correction_chain_length >= 2)",
    required_output_elements: ["사건을 날짜 오름차순으로 분리", "각 날짜별 변경 필드명", "각 날짜별 변경 원인(가능한 경우)", "정정 구간을 하나의 범위로 압축하지 않고 각 정정을 개별 언급"],
    forbidden_or_safety: ["서로 다른 날짜의 정정을 하나의 문장/범위로 압축", "사건 순서를 뒤섞음"],
    implementation_layers: ["Planner", "Response Composer"],
  },
  {
    capability_id: "LATEST_EFFECTIVE_STATE",
    description: "여러 시점의 값이 존재할 때, 가장 최근에 유효한 조건과 그 값이 유효하게 된 기준일을 응답에서 직접 명시한다.",
    applies_when: "동일 필드에 대해 corrected_at/effective_at 성격의 날짜가 2개 이상 존재하거나 gold_expected_answer_value에 latest_effective_* 계열 필드가 존재함 (구조화 signal: temporal_version_count >= 2)",
    required_output_elements: ["최신 유효 조건 값", "그 값이 유효해진 기준일", "이전 값과의 관계(정정/연장 등)"],
    forbidden_or_safety: ["기준일 없이 최신 값만 단독 제시", "과거 값과 최신 값을 구분 없이 병기"],
    implementation_layers: ["Response Composer", "Final Validator"],
  },
  {
    capability_id: "INFORMATION_LIMIT_DISCLOSURE",
    description: "값 상태가 NOT_FOUND / NOT_APPLICABLE / OUTSIDE_CORPUS / WITHHELD인 필드가 있을 때, 그 정보 한계를 응답 텍스트에서 명시적으로 서술한다 (침묵하거나 생략하지 않는다).",
    applies_when: "calculation.value의 어떤 필드의 *_status 값이 NOT_FOUND/NOT_APPLICABLE/OUTSIDE_CORPUS/WITHHELD이거나 gold_expected_answer_value에 그런 status 필드가 존재함 (구조화 signal: information_limit_field_count >= 1)",
    required_output_elements: ["어떤 항목이 확인되지 않았는지/코퍼스 밖인지/유보되었는지 명시", "그 한계가 오류가 아니라 코퍼스/공시 범위의 한계임을 표시"],
    forbidden_or_safety: ["정보 부재를 값 자체를 생략하는 방식으로 감춤", "정보 부재를 추정치로 대체"],
    implementation_layers: ["Response Composer", "Final Validator"],
  },
  {
    capability_id: "ATTRIBUTION_PRESERVATION",
    description: "회사가 스스로 밝힌 판단·전망·사유(재무적 영향 전망, 해지 사유 등)를 검증된 객관적 사실과 분리해서, '회사가 공시함/판단함'과 같은 귀속 표현을 유지한 채 서술한다.",
    applies_when: "raw_label/quoted_text에 전망·판단·사유 성격의 서술형 값이 있고 해당 필드가 수치가 아닌 자유 서술 필드임 (구조화 signal: attribution_field_present == true, 즉 필드 값이 회사의 진술/판단을 인용하는 문자열)",
    required_output_elements: ["회사가 진술한 내용임을 명시하는 귀속구", "그 진술과 검증된 수치적 사실의 구분"],
    forbidden_or_safety: ["회사의 전망/판단을 검증된 객관적 사실처럼 서술", "귀속 없이 결론만 단정적으로 제시"],
    implementation_layers: ["Response Composer", "Final Validator"],
  },
  {
    capability_id: "QUALIFIER_PRESERVATION",
    description: "원문의 '약', '예정', '계획', '유보', '정정 전/후' 같은 한정 표현을 응답에서도 그대로 보존한다 (더 정밀하거나 확정적인 값으로 바꾸지 않는다).",
    applies_when: "quoted_text에 근사치/예정/계획/유보를 나타내는 표현이 포함된 값을 응답이 재인용함 (구조화 signal: source_qualifier_present == true)",
    required_output_elements: ["원문의 한정 표현을 응답에서도 동일하게 사용", "정정 전/후 값이 있는 경우 두 값을 모두 표시"],
    forbidden_or_safety: ["'약'이 붙은 근사치를 정확한 값처럼 제시", "'예정'인 사실을 확정된 사실처럼 제시"],
    implementation_layers: ["Response Composer", "Final Validator"],
  },
  {
    capability_id: "REQUEST_COMPLETENESS",
    description: "질문이 복수의 하위 요구사항(예: A와 B를 비교, 확정된 것과 아닌 것을 구분)을 포함할 때, 모든 하위 요구사항에 대해 응답이 실제로 답했는지 최종적으로 점검한다.",
    applies_when: "question_intent에 접속사/병렬 요구가 2개 이상 있거나 required_operations가 2개 이상임 (구조화 signal: sub_request_count >= 2)",
    required_output_elements: ["각 하위 요구사항에 대응하는 응답 문장 존재 여부 자체 점검", "누락된 하위 요구사항이 있으면 그 사실 자체를 명시"],
    forbidden_or_safety: ["하위 요구사항 중 일부를 답변에서 조용히 생략"],
    implementation_layers: ["Final Validator"],
  },
  {
    capability_id: "NEUTRAL_COMPARABILITY_CAVEAT",
    description: "비교 대상들의 기준(연도/통화/계약기간/범위)이 서로 다를 때, 명목 비교와 경제적 우열 판단을 구분하는 중립적 주의문을 추가한다. 이 caveat는 새로운 외부 사실이 아니라 과도한 해석을 제한하는 서술이며, 투자 추천이나 기업가치 판단으로 확장하지 않는다.",
    applies_when: "비교 대상 각각의 기준 연도/통화/계약기간/범위 중 하나 이상이 서로 다름 (구조화 signal: comparison_basis_mismatch_count >= 1)",
    required_output_elements: ["기준이 다르다는 사실 자체를 명시", "명목 비교가 경제적 우열을 의미하지 않는다는 문장"],
    forbidden_or_safety: ["투자 추천·기업가치·경쟁력 우열 판단으로 확장", "caveat를 새로운 사실 주장처럼 제시"],
    implementation_layers: ["Response Composer", "Final Validator"],
  },
  {
    capability_id: "EVIDENCE_REFERENCED_NARRATIVE",
    description: "구조화된 사실·근거 목록을 그대로 나열하지 않고, 근거 문서와 연결된 자연어 설명으로 합성한다. 질문이 요구하는 정리/비교/설명 형식에 맞춰 결론을 먼저 서술한다.",
    applies_when: "response_format이 raw key-value bullet list + 근거 공시 목록이고, 질문이 정리/비교/설명/시간순 서술을 요구함 (구조화 signal: intent in {SUMMARIZE, COMPARE, EXPLAIN_TIMELINE} AND response는 구조화 사실 나열 형태)",
    required_output_elements: ["질문이 요구하는 형식(정리/비교/시간순)에 맞는 문장형 서술", "근거는 결론을 뒷받침하는 형태로 인용, 결론 없이 근거만 나열하지 않음"],
    forbidden_or_safety: ["구조화 사실을 라벨 없이 그대로 bullet로만 제시", "질문에 대한 결론 문장 없이 근거 목록으로 응답을 대체"],
    implementation_layers: ["Response Composer"],
  },
];

// --- Per-item Owner decision. Q17/Q22 fields come verbatim from the real
// result files (loaded below); the other 15 reuse the specific issues
// already surfaced in the prior pre-review turn, now Owner-approved as
// FIX_REQUIRED. capability_ids reference ONLY the generalized catalog
// above -- never a question-specific rule.
const ITEM_OVERRIDES = {
  "question_seed_v07_06::claim_coverage": {
    issues: [
      "투자금액(원) 두 값이 라벨 없이 순서대로만 제시되어 어느 값이 Floating Dock 확장이고 어느 값이 6,500ton급 Floating Crane인지 응답 문장만으로는 구분되지 않는다.",
      "지분율(5.5%, 6.8%)과 투자 목적(생산량 증대, 건조 효율성 증대)이 근거 목록에는 있지만 구조화 사실 bullet에는 빠져 있다.",
      "질문이 요구한 '투자 대상, 규모, 목적 중심' 정리가 아니라 raw 값 나열에 그친다.",
    ],
    capability_ids: ["ENTITY_AND_PERIOD_LABELING", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_07::claim_coverage": {
    issues: [
      "app_tozma_specific_launch_month_status/app_tozma_standalone_revenue_status가 NOT_FOUND라는 정보 한계가 응답에 전혀 언급되지 않는다.",
      "품목허가·출시 상태가 enum 코드(FINAL_MARKETING_AUTHORIZATION_EU_EC 등)로만 제시되고 자연어 설명이 없다.",
    ],
    capability_ids: ["INFORMATION_LIMIT_DISCLOSURE", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_08::claim_coverage": {
    issues: [
      "정정 전/후 값(기타주식 691,204→691,203, 인수단 '삼성증권 등'→5개 증권사 명시)이 근거 목록에는 있지만 정정 사건으로 서술되지 않는다.",
      "취득결정→취득결과→소각결정→소각완료의 4단계 사건 순서가 날짜별로 분리 서술되지 않는다.",
    ],
    capability_ids: ["TEMPORAL_EVENT_SYNTHESIS", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_09::claim_coverage": {
    issues: [
      "신탁계약 체결(2025-02-07)→중도해지(2025-06-23)→소각(2025-06-26)의 3단계 사건이 날짜순 서술 없이 enum 코드로만 제시된다.",
      "중도해지 사유(termination_reason)가 근거 목록에는 있지만 응답 문장에 없다.",
    ],
    capability_ids: ["TEMPORAL_EVENT_SYNTHESIS", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_09::explicit_fact_value_slots": {
    issues: [
      "termination_reason 값이 근거 문서에 정확히 인용 가능한 형태로 존재('자기주식 취득 완료에 따른 중도해지')하지만 calculation.value에 필드 자체가 생성되지 않았다.",
      "해지 사유는 사건(termination)에 부수되는 서술 필드이므로 사건 합성 과정에서 함께 추출되어야 한다.",
    ],
    capability_ids: ["TEMPORAL_EVENT_SYNTHESIS", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_14::claim_coverage": {
    issues: [
      "영업이익 값 두 개가 연도 라벨 없이 순서대로만 제시되어 2023년/2025년 값을 구분할 수 없다.",
      "매출액 항목이 해당 없음(NOT_APPLICABLE)이라는 사실과 그 대체 지표(별도재무제표 영업수익 등)로 대체 계산을 금지한다는 caveat가 응답에 없다.",
      "영업이익 증감률(15.12%)이 계산되었지만 그 증감 방향에 대한 결론 문장이 없다.",
    ],
    capability_ids: ["ENTITY_AND_PERIOD_LABELING", "INFORMATION_LIMIT_DISCLOSURE", "COMPARATIVE_CONCLUSION", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_15::claim_coverage": {
    issues: [
      "질문이 요구한 '사업 규모와 영업 수익성 비교' 결론(HD현대중공업이 규모·수익성 모두 우위)이 응답 문장에 전혀 없다.",
      "매출·영업이익 값 4개가 두 기업 라벨 없이 나열된다.",
    ],
    capability_ids: ["ENTITY_AND_PERIOD_LABELING", "COMPARATIVE_CONCLUSION", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_15::explicit_fact_value_slots": {
    issues: [
      "margin_calculation_note(영업이익률 계산식 설명)와 scale_vs_profitability_summary(규모·수익성 비교 결론)가 이미 인용된 매출·영업이익 값으로부터 파생 가능함에도 calculation.value에 생성되지 않았다.",
    ],
    capability_ids: ["COMPARATIVE_CONCLUSION", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_16::claim_coverage": {
    issues: [
      "매출·영업이익 값 8개가 기업·연도 라벨 없이 나열되어 어느 값이 어느 기업의 어느 연도 값인지 응답 문장만으로 알 수 없다.",
      "calculation.value에 이미 계산되어 있는 both_companies_operating_profit_growth_exceeds_revenue_growth/larger_change_magnitude_company 결론이 응답 문장에 서술되지 않는다.",
    ],
    capability_ids: ["ENTITY_AND_PERIOD_LABELING", "COMPARATIVE_CONCLUSION", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  // Q17: verbatim from A_Q17_REVIEW_RESULT.json (loaded below); capability_ids only.
  "question_seed_v07_17::claim_coverage": {
    capability_ids: ["NEUTRAL_COMPARABILITY_CAVEAT", "TEMPORAL_EVENT_SYNTHESIS", "LATEST_EFFECTIVE_STATE", "COMPARATIVE_CONCLUSION", "ATTRIBUTION_PRESERVATION", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_17::explicit_fact_value_slots": {
    issues: [
      "comparability_caveat, samsung_heavy_termination_reason, issuer_stated_financial_impact 세 서술 필드가 근거 문서에 문장 형태로 존재하지만 calculation.value에 생성되지 않았다.",
    ],
    capability_ids: ["NEUTRAL_COMPARABILITY_CAVEAT", "ATTRIBUTION_PRESERVATION", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_21::claim_coverage": {
    issues: [
      "체결(2023-03-13 정정)→연장(2024-03-12)→해지(2024-08-08)→소각(2024-08-16)의 4단계 사건이 날짜순으로 분리 서술되지 않는다.",
      "연장공시 원문 자체는 코퍼스 밖이며 해지공시를 통해 그 존재와 연장기간이 이차적으로 확인된다는 사실이 응답에 없다(extension_source_document_status=OUTSIDE_CORPUS).",
      "질문이 요구한 '체결, 연장, 해지, 소각까지' 4개 하위 요구사항 중 다수가 응답 문장에서 명시적으로 다뤄지지 않는다.",
    ],
    capability_ids: ["TEMPORAL_EVENT_SYNTHESIS", "INFORMATION_LIMIT_DISCLOSURE", "REQUEST_COMPLETENESS", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  // Q22: verbatim from C_Q22_REVIEW_RESULT.json (loaded below); capability_ids only.
  "question_seed_v07_22::claim_coverage": {
    capability_ids: ["TEMPORAL_EVENT_SYNTHESIS", "LATEST_EFFECTIVE_STATE", "QUALIFIER_PRESERVATION", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_23::claim_coverage": {
    issues: [
      "회사가 스스로 밝힌 재무적 영향 판단(financial_impact_attribution)이 근거 목록에는 있지만 응답 문장에 귀속구와 함께 서술되지 않는다.",
      "일시중단 25회, 비용 보상 여부 등 세부 사실이 raw 인용으로만 존재하고 서술로 종합되지 않는다.",
    ],
    capability_ids: ["ATTRIBUTION_PRESERVATION", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_23::explicit_fact_value_slots": {
    issues: [
      "financial_impact_attribution 필드가 근거 문서에 문장 형태로 존재하지만 calculation.value에 생성되지 않았다.",
    ],
    capability_ids: ["ATTRIBUTION_PRESERVATION", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_24::claim_coverage": {
    issues: [
      "정정 전/후 상대방 값만 나열될 뿐, 금액·기간·비율이 정정 전후로 변경되지 않았다는 사실이 응답에 없다.",
      "이 정정이 계약조건 변경이 아니라 유보되었던 상대방명이 공개된 사건이라는 결론(correction_nature)이 응답에 없다.",
      "정정 전 상대방명이 유보(WITHHELD)되어 있었다는 정보 상태 자체가 명시되지 않는다.",
    ],
    capability_ids: ["ATTRIBUTION_PRESERVATION", "INFORMATION_LIMIT_DISCLOSURE", "COMPARATIVE_CONCLUSION", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
  "question_seed_v07_25::claim_coverage": {
    issues: [
      "유보기한 변경 이력(2024-03-30/05-31/06-30/07-30 및 최종 2030-12-31)이 시간순으로 분리 서술되지 않는다.",
      "질문이 명시적으로 요구한 '2024년 7월 2일 기준 확정된 사실과 여전히 공개되지 않은 정보의 구분'이 응답에 전혀 없다 -- 특히 counterparty_legal_name_confirmed=false(계약상대방의 법적 명칭이 여전히 미확정)가 언급되지 않는다.",
      "'경영상 비밀유지 사유로 2030년 12월 31일 공개될 예정'이라는 원문의 예정 표현이 응답 서술에 반영되지 않는다.",
    ],
    capability_ids: ["TEMPORAL_EVENT_SYNTHESIS", "REQUEST_COMPLETENESS", "INFORMATION_LIMIT_DISCLOSURE", "QUALIFIER_PRESERVATION", "EVIDENCE_REFERENCED_NARRATIVE"],
  },
};

async function main() {
  const [template, harnessRecords, q17Result, q22Result] = await Promise.all([
    readJsonlAbs(TEMPLATE_PATH),
    readJsonlAbs(HARNESS_RESULT_PATH),
    readJsonAbs(Q17_RESULT_PATH),
    readJsonAbs(Q22_RESULT_PATH),
  ]);

  // --- Re-derive the REVIEW_REQUIRED set mechanically (never trust a
  // prior report or a hardcoded 17) and prove it matches the template's
  // review_item_id set exactly: 0 missing, 0 extra. ----------------------
  const mechanicallyDerived = [];
  for (const record of harnessRecords) {
    for (const [metricName, metric] of Object.entries(record.metric_results ?? {})) {
      if (metric && metric.status === "REVIEW_REQUIRED") mechanicallyDerived.push(`${record.question_id}::${metricName}`);
    }
  }
  const templateKeys = template.map((r) => `${r.question_id}::${r.metric_name}`);
  const derivedSet = new Set(mechanicallyDerived);
  const templateSet = new Set(templateKeys);
  const missingFromTemplate = mechanicallyDerived.filter((k) => !templateSet.has(k));
  const extraInTemplate = templateKeys.filter((k) => !derivedSet.has(k));
  if (missingFromTemplate.length > 0 || extraInTemplate.length > 0) {
    throw new Error(`REVIEW_REQUIRED set mismatch -- missing: ${JSON.stringify(missingFromTemplate)}, extra: ${JSON.stringify(extraInTemplate)}`);
  }
  if (mechanicallyDerived.length !== 17) throw new Error(`expected 17 mechanically-derived REVIEW_REQUIRED items, found ${mechanicallyDerived.length}`);

  // --- Verify the Q17/Q22 result files target the right question/metric. --
  if (q17Result.question_id !== "question_seed_v07_17") throw new Error("A_Q17_REVIEW_RESULT.json question_id mismatch");
  if (q17Result.review_field !== "comparability_caveat") throw new Error("A_Q17_REVIEW_RESULT.json review_field mismatch");
  if (q22Result.question_id !== "question_seed_v07_22") throw new Error("C_Q22_REVIEW_RESULT.json question_id mismatch");
  if (q22Result.metric_name !== "claim_coverage") throw new Error("C_Q22_REVIEW_RESULT.json metric_name mismatch");

  const capabilityIds = new Set(CAPABILITIES.map((c) => c.capability_id));

  const decisionRecords = template.map((templateRecord) => {
    const key = `${templateRecord.question_id}::${templateRecord.metric_name}`;
    const override = ITEM_OVERRIDES[key];
    if (!override) throw new Error(`no Owner judgment authored for ${key}`);
    for (const capId of override.capability_ids) {
      if (!capabilityIds.has(capId)) throw new Error(`${key} references unknown capability_id ${capId}`);
    }

    const isQ17 = key === "question_seed_v07_17::claim_coverage";
    const isQ22 = key === "question_seed_v07_22::claim_coverage";

    const base = {
      review_item_id: templateRecord.review_item_id,
      question_id: templateRecord.question_id,
      metric_name: templateRecord.metric_name,
      source_template_path: TEMPLATE_PATH,
      source_template_sha256: null, // filled in below once the template's own sha256 is computed
      owner_disposition: "FIX_REQUIRED",
      reviewer: REVIEWER,
      reviewed_at: REVIEWED_AT,
      required_response_capabilities: override.capability_ids,
      requires_gold_change: false,
      requires_fact_change: false,
      requires_metric_change: false,
      requires_response_implementation: true,
    };

    if (isQ17) {
      return {
        ...base,
        decision_basis: `work/handoff/seed-final-response-owner-review/results/A_Q17_REVIEW_RESULT.json (reviewer_track ${q17Result.reviewer_track})의 Owner 판정을 그대로 전사함.`,
        comparability_caveat: q17Result.recommendation,
        comparability_caveat_premise_values_check: q17Result.premise_values_check,
        comparability_caveat_creates_new_fact: q17Result.creates_new_fact,
        comparability_caveat_permits_economic_superiority_claim: q17Result.permits_economic_superiority_claim,
        comparability_caveat_suggested_safe_wording: q17Result.suggested_safe_wording,
        issues: q17Result.issues,
        notes: q17Result.notes,
      };
    }
    if (isQ22) {
      return {
        ...base,
        decision_basis: `work/handoff/seed-final-response-owner-review/results/C_Q22_REVIEW_RESULT.json (reviewer_track ${q22Result.reviewer_track})의 Owner 판정을 그대로 전사함.`,
        effective_predecessor_check: q22Result.effective_predecessor_check,
        latest_conditions_check: q22Result.latest_conditions_check,
        timeline_check: q22Result.timeline_check,
        issues: q22Result.issues,
        notes: q22Result.notes,
      };
    }
    return {
      ...base,
      decision_basis: "이전 턴의 pre-review에서 식별된 구조적 결함(근거는 정확하나 응답 합성이 불충분함)을 Owner가 그대로 승인함.",
      issues: override.issues,
      notes: null,
    };
  });

  // Fill in source_template_sha256 (the real, unmodified template's hash) now
  // that we know we're not going to throw.
  const templateSha256 = await sha256OfFile(TEMPLATE_PATH);
  for (const record of decisionRecords) record.source_template_sha256 = templateSha256;

  // --- Validation: 17 records, 0 duplicate, 17/17 FIX_REQUIRED + requires_response_implementation,
  // Q17/Q22 preserved, no gold/fact/metric change claimed. -----------------
  if (decisionRecords.length !== 17) throw new Error(`expected 17 decision records, built ${decisionRecords.length}`);
  const ids = decisionRecords.map((r) => r.review_item_id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate review_item_id in decision records");
  for (const record of decisionRecords) {
    if (record.owner_disposition !== "FIX_REQUIRED") throw new Error(`${record.review_item_id}: owner_disposition must be FIX_REQUIRED`);
    if (record.requires_response_implementation !== true) throw new Error(`${record.review_item_id}: requires_response_implementation must be true`);
    if (record.requires_gold_change !== false || record.requires_fact_change !== false || record.requires_metric_change !== false) {
      throw new Error(`${record.review_item_id}: requires_gold_change/requires_fact_change/requires_metric_change must all be false`);
    }
    if (record.reviewer !== REVIEWER) throw new Error(`${record.review_item_id}: reviewer must be ${REVIEWER}`);
    if (!Array.isArray(record.required_response_capabilities) || record.required_response_capabilities.length === 0) {
      throw new Error(`${record.review_item_id}: required_response_capabilities must be non-empty`);
    }
  }
  const q17Record = decisionRecords.find((r) => r.review_item_id.includes("question_seed_v07_17_claim_coverage"));
  if (q17Record.comparability_caveat !== "ALLOW_NEUTRAL_CAVEAT") throw new Error("Q17 comparability_caveat not preserved");
  const q22Record = decisionRecords.find((r) => r.review_item_id.includes("question_seed_v07_22_claim_coverage"));
  if (q22Record.effective_predecessor_check !== "PASS" || q22Record.latest_conditions_check !== "FAIL" || q22Record.timeline_check !== "FAIL") {
    throw new Error("Q22 three-check result not preserved");
  }
  if (q22Record.issues.length !== 6) throw new Error(`Q22 issues count must be 6, found ${q22Record.issues.length}`);

  // --- Derive the reverse index (capability -> review_item_id list) from
  // the SAME per-item mapping above, so the two artifacts can never drift
  // apart from each other. -------------------------------------------------
  const capabilityToItems = new Map(CAPABILITIES.map((c) => [c.capability_id, []]));
  for (const record of decisionRecords) {
    for (const capId of record.required_response_capabilities) capabilityToItems.get(capId).push(record.review_item_id);
  }
  for (const cap of CAPABILITIES) {
    if (capabilityToItems.get(cap.capability_id).length === 0) throw new Error(`capability ${cap.capability_id} has no linked review_item_id`);
  }

  // Overfitting guard: no capability's applies_when/description may
  // literally contain a question_id or a known company name from this
  // batch's questions.
  const FORBIDDEN_OVERFIT_TOKENS = [
    "question_seed_v07", "삼성중공업", "효성중공업", "현대건설", "SATORP", "한화오션", "셀트리온",
    "삼성전자", "신한지주", "HD현대중공업", "HMM", "현대모비스", "삼성E&A", "삼성바이오로직스", "에스엠",
  ];
  for (const cap of CAPABILITIES) {
    const text = `${cap.description} ${cap.applies_when}`;
    for (const token of FORBIDDEN_OVERFIT_TOKENS) {
      if (text.includes(token)) throw new Error(`capability ${cap.capability_id} contains overfit token "${token}"`);
    }
  }

  // --- Write outputs. ------------------------------------------------------
  const decisionText = jsonl(decisionRecords);
  await writeFile(path.join(REPO, DECISION_OUT), decisionText, "utf8");
  const decisionSha256 = sha256(Buffer.from(decisionText, "utf8"));

  const requirementsArtifact = {
    schema_version: "0.1.0",
    artifact_id: "seed-response-synthesis-requirements-v0.1",
    generated_at: REVIEWED_AT,
    scope:
      "Harness v05의 실제 REVIEW_REQUIRED 17건에 대한 Owner 검수(seed-response-owner-decision.v0.2)로부터 기계적으로 도출한, "
      + "일반화된 응답 합성 capability 카탈로그. question_id나 기업/문서명으로 분기하지 않으며, 구조화 signal(intent/"
      + "value 다중성/사건 수/비교 차원/정보한계 상태/귀속 상태)로만 적용 조건을 판단한다.",
    overfitting_guard_note:
      "각 capability의 applies_when은 구조화 signal만 사용한다. review_item_id 목록은 이번 25문항 배치에서 관측된 사례일 뿐, "
      + "dispatch 규칙이 아니다 -- Runtime 구현은 applies_when의 구조화 조건으로 capability를 트리거해야 하며 question_id/기업명 "
      + "분기를 추가해서는 안 된다.",
    capabilities: CAPABILITIES.map((cap) => ({
      ...cap,
      observed_review_item_ids: capabilityToItems.get(cap.capability_id),
    })),
    source_decision: { path: DECISION_OUT, sha256: decisionSha256, record_count: decisionRecords.length },
  };
  const requirementsText = `${JSON.stringify(requirementsArtifact, null, 2)}\n`;
  await writeFile(path.join(REPO, REQUIREMENTS_JSON_OUT), requirementsText, "utf8");
  const requirementsSha256 = sha256(Buffer.from(requirementsText, "utf8"));

  const requirementsMd = `# Seed Response Synthesis Requirements v0.1

**Generated at:** ${REVIEWED_AT}
**Source:** ${DECISION_OUT} (17/17 FIX_REQUIRED, Owner: ${REVIEWER})

이 문서는 17건 REVIEW_REQUIRED 검수에서 반복적으로 나타난 결함을 질문/기업별 규칙이 아니라
일반화된 응답 합성 capability로 정리한 것이다. 각 capability의 적용 조건은 구조화 signal이며,
review_item_id 목록은 이번 배치에서 관측된 사례일 뿐 dispatch 규칙이 아니다.

${CAPABILITIES.map((cap) => `## ${cap.capability_id}

${cap.description}

- **적용 조건 (구조화 signal):** ${cap.applies_when}
- **필수 출력 요소:** ${cap.required_output_elements.join("; ")}
- **금지 표현/안전 조건:** ${cap.forbidden_or_safety.join("; ")}
- **구현 계층 제안:** ${cap.implementation_layers.join(", ")}
- **관측된 review_item_id (${capabilityToItems.get(cap.capability_id).length}건):** ${capabilityToItems.get(cap.capability_id).join(", ")}
`).join("\n")}
`;
  await writeFile(path.join(REPO, REQUIREMENTS_MD_OUT), requirementsMd, "utf8");

  const decisionManifest = {
    schema_version: "0.1.0",
    artifact_id: "seed-response-owner-decision-v0.2",
    generated_at: REVIEWED_AT,
    reviewer: REVIEWER,
    supersedes_note:
      "work/domain-seed/seed-response-owner-review-template.v0.1.jsonl은 수정하지 않고 그대로 보존됨 (기계 생성 PENDING 템플릿, 감사 이력). "
      + "이 v0.2는 그 17개 PENDING 항목에 대한 실제 Owner 판정을 별도 artifact로 기록한 것이다.",
    inputs: {
      source_template: { path: TEMPLATE_PATH, sha256: templateSha256 },
      harness_result: { path: HARNESS_RESULT_PATH, sha256: await sha256OfFile(HARNESS_RESULT_PATH) },
      q17_review_result: { path: Q17_RESULT_PATH, sha256: await sha256OfFile(Q17_RESULT_PATH) },
      q22_review_result: { path: Q22_RESULT_PATH, sha256: await sha256OfFile(Q22_RESULT_PATH) },
    },
    outputs: {
      decision: { path: DECISION_OUT, sha256: decisionSha256, record_count: decisionRecords.length },
      requirements_json: { path: REQUIREMENTS_JSON_OUT, sha256: requirementsSha256, capability_count: CAPABILITIES.length },
    },
    review_required_set: {
      total: mechanicallyDerived.length,
      mechanically_derived: true,
      matches_template_exactly: true,
    },
  };
  await writeFile(path.join(REPO, DECISION_MANIFEST_OUT), `${JSON.stringify(decisionManifest, null, 2)}\n`, "utf8");

  const dispositionCounts = decisionRecords.reduce((acc, r) => { acc[r.owner_disposition] = (acc[r.owner_disposition] ?? 0) + 1; return acc; }, {});
  const reviewMd = `# Seed Response Owner Decision v0.2 -- Review Summary

**Reviewer:** ${REVIEWER}
**Reviewed at:** ${REVIEWED_AT}
**Source template (unmodified):** \`${TEMPLATE_PATH}\` (sha256 ${templateSha256})
**Mechanically re-derived REVIEW_REQUIRED count:** ${mechanicallyDerived.length} (0 missing, 0 extra vs template)

## 판정 분포

${Object.entries(dispositionCounts).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

## Q17 (comparability_caveat) -- 보존된 Owner 판정

- comparability_caveat: **${q17Record.comparability_caveat}**
- premise_values_check: ${q17Record.comparability_caveat_premise_values_check}
- creates_new_fact: ${q17Record.comparability_caveat_creates_new_fact}
- permits_economic_superiority_claim: ${q17Record.comparability_caveat_permits_economic_superiority_claim}
- suggested_safe_wording (참고용, 구현 템플릿 아님): "${q17Record.comparability_caveat_suggested_safe_wording}"
- issues (${q17Record.issues.length}건): ${q17Record.issues.map((s) => `\n  - ${s}`).join("")}

## Q22 (claim_coverage) -- 보존된 Owner 판정

- effective_predecessor_check: **${q22Record.effective_predecessor_check}**
- latest_conditions_check: **${q22Record.latest_conditions_check}**
- timeline_check: **${q22Record.timeline_check}**
- issues (${q22Record.issues.length}건): ${q22Record.issues.map((s) => `\n  - ${s}`).join("")}

## 17건 전체 목록

| review_item_id | owner_disposition | requires_response_implementation | capabilities |
|---|---|---|---|
${decisionRecords.map((r) => `| ${r.review_item_id} | ${r.owner_disposition} | ${r.requires_response_implementation} | ${r.required_response_capabilities.join(", ")} |`).join("\n")}

## 이번 결정이 의미하지 않는 것

- Gold/Fact/Evidence 의미 오류 아님 (requires_gold_change/requires_fact_change 모두 false)
- Metric 판정 로직 결함 아님 (requires_metric_change false)
- 새 Fact 필요 없음
- Runtime/Thin Flow 구현 변경 아님 (이번 턴 범위 밖)
`;
  await writeFile(path.join(REPO, DECISION_REVIEW_MD_OUT), reviewMd, "utf8");

  console.log(JSON.stringify({
    review_required_total: mechanicallyDerived.length,
    decision_records: decisionRecords.length,
    disposition_counts: dispositionCounts,
    capability_count: CAPABILITIES.length,
    capability_item_counts: Object.fromEntries(CAPABILITIES.map((c) => [c.capability_id, capabilityToItems.get(c.capability_id).length])),
    q17_comparability_caveat: q17Record.comparability_caveat,
    q22_checks: { effective_predecessor_check: q22Record.effective_predecessor_check, latest_conditions_check: q22Record.latest_conditions_check, timeline_check: q22Record.timeline_check },
    decision_path: DECISION_OUT, decision_sha256: decisionSha256,
    requirements_path: REQUIREMENTS_JSON_OUT, requirements_sha256: requirementsSha256,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
