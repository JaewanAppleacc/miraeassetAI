// Generic internal-representation-to-natural-Korean translation (Turn M
// capability B). Every dictionary below is keyed by a REAL, CLOSED enum
// token taken from the actual VERIFIED Fact/Event ontology (Fact.
// normalized_value, Event.event_type, Event.event_status) -- the same
// kind of generic data-ontology translation narrative-field-extractor.mjs
// already does for value_status (STATUS_LABEL_KO). It is never keyed by
// question_id, company name, or document id, and it applies uniformly to
// ANY Fact/Event carrying these values regardless of which question
// references them. An enum token this module has never seen still
// degrades safely (never left as a raw SCREAMING_SNAKE_CASE token, never
// thrown) via a generic underscore-to-space transliteration, flagged
// `confident: false` so the caller can log an internal PARTIAL reason.
const FACT_ENUM_LABELS = Object.freeze({
  ACQUIRED_AND_RETIRED: "자기주식 취득 후 소각 완료",
  DEFINITIVE_AGREEMENT_CONFIRMED: "본계약 체결 확정",
  FINAL_MARKETING_AUTHORIZATION_EU_EC: "EU 집행위원회 최종 판매 허가 획득",
  ISSUED: "발행 완료",
  LAUNCHED_2025_H2_FIVE_PRODUCT_GROUP: "2025년 하반기 5개 제품군 출시 완료",
  RIGHTS_ISSUE_DECIDED: "유상증자 결정",
  TERMINATED: "해지 완료",
});

const EVENT_TYPE_LABELS = Object.freeze({
  DEFINITIVE_AGREEMENT: "본계약 체결",
  HOLDING_REPORT_CORRECTION: "보유상황보고서 정정",
  ISSUANCE_COMPLETION: "발행 완료",
  LOI_DECISION: "양해각서(LOI) 체결 결정",
  RIGHTS_ISSUE_DECISION: "유상증자 결정",
  RIGHTS_ISSUE_DECISION_CORRECTION: "유상증자 결정 정정",
  SHARE_ACQUISITION_DECISION: "자기주식 취득 결정",
  SHARE_ACQUISITION_DECISION_CORRECTION: "자기주식 취득 결정 정정",
  SHARE_ACQUISITION_RETIREMENT_COMPLETION: "자기주식 취득 후 소각 완료",
  SHARE_DISPOSAL_DECISION: "자기주식 처분 결정",
  SUPPLY_CONTRACT_DECISION: "공급계약 체결 결정",
  SUPPLY_CONTRACT_DECISION_CORRECTION: "공급계약 체결 결정 정정",
  SUPPLY_CONTRACT_TERMINATION: "공급계약 해지",
  TRUST_ACQUISITION_DECISION: "신탁계약을 통한 자기주식 취득 결정",
  TRUST_ACQUISITION_DECISION_CORRECTION: "신탁계약을 통한 자기주식 취득 결정 정정",
  TRUST_ACQUISITION_TERMINATION: "신탁계약을 통한 자기주식 취득 계약 해지",
});

const EVENT_STATUS_LABELS = Object.freeze({
  COMPLETED: "완료",
  CONFIRMED: "확정",
  CORRECTED: "정정됨",
  DECIDED: "결정됨",
  TERMINATED: "해지됨",
});

// Multi-segment SCREAMING_SNAKE_CASE only (at least one underscore) --
// deliberately excludes a bare single all-caps word (e.g. a real
// counterparty/joint-venture identity string disclosed verbatim in a
// Fact), which is a legitimate proper noun already correctly disclosed,
// not an internal enum token.
const INTERNAL_ENUM_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
export function looksLikeInternalEnum(value) {
  return typeof value === "string" && INTERNAL_ENUM_SHAPE.test(value);
}

// lower_snake_case (raw field/slot-name shape) -- for defensive scanning,
// never for detecting the enum dictionaries above (those are upper-case).
const SNAKE_CASE_SHAPE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;
export function looksLikeSnakeCaseToken(value) {
  return typeof value === "string" && SNAKE_CASE_SHAPE.test(value);
}

// Turn M2 item 3: an enum-shaped token this module has never seen must
// NEVER reach the reader in any form derived from the raw token -- a
// underscore-to-space transliteration (e.g. "unknown internal status")
// is STILL the internal representation, just reformatted, and is exactly
// the kind of leak this whole module exists to prevent. The only safe
// output is this fixed, token-independent phrase; the raw token itself
// is surfaced solely via the caller's `unnaturalized_enum` composition
// warning (never inlined into narrative/answer text), which downstream
// code funnels into an internal-only PARTIAL reason.
const UNTRANSLATABLE_ENUM_LABEL = "상태를 자연어로 변환할 수 없어 추가 확인이 필요합니다";

function lookup(token, dict) {
  if (typeof token !== "string") return { label: String(token), confident: false };
  if (dict[token]) return { label: dict[token], confident: true };
  if (!looksLikeInternalEnum(token)) return { label: token, confident: true }; // not enum-shaped -- pass through unchanged
  return { label: UNTRANSLATABLE_ENUM_LABEL, confident: false };
}

export function naturalizeFactEnum(token) { return lookup(token, FACT_ENUM_LABELS); }
export function naturalizeEventType(token) { return lookup(token, EVENT_TYPE_LABELS); }
export function naturalizeEventStatus(token) { return lookup(token, EVENT_STATUS_LABELS); }

// Strips a leading raw disclosure-form numbering or bullet prefix
// ("3. ", "9. ", "- ") -- generic across ANY raw_label, not a specific
// field name. Composer callers prepend their own "- " list bullet when
// rendering a line, so a raw_label that already starts with "- " (a
// sub-item bullet carried over from the source document's own layout)
// would otherwise double up as "- - label: ...". The remainder
// (including "·" separators, which are legitimate Korean list
// punctuation) is left untouched.
const LEADING_NUMBERING_OR_BULLET = /^\s*(?:\d+\.\s*|-\s+)/;
export function naturalizeFieldLabel(rawLabel) {
  if (typeof rawLabel !== "string") return rawLabel;
  return rawLabel.replace(LEADING_NUMBERING_OR_BULLET, "");
}
