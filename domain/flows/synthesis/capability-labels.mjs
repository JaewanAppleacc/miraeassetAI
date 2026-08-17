// Natural-language, user-facing labels for internal capability IDs. Used
// ONLY when composing the visible `answer` text for a PARTIAL synthesis
// result -- the raw capability_id (e.g. "REQUEST_COMPLETENESS") must
// never appear in text shown to the end user; it may still appear in
// think_trace.validation.synthesis's structured metadata, which is an
// internal diagnostic record, not prose.
export const CAPABILITY_LIMITATION_LABELS_KO = Object.freeze({
  ENTITY_AND_PERIOD_LABELING: "일부 기업/기간 라벨이 충분히 구분되지 않았습니다",
  ENTITY_LABEL_RESOLUTION: "일부 기업명이 검증된 형태로 확인되지 않았습니다",
  COMPARATIVE_CONCLUSION: "비교 결론을 충분히 서술하지 못했습니다",
  TEMPORAL_EVENT_SYNTHESIS: "관련 사건의 시간순 정리가 충분하지 않습니다",
  LATEST_EFFECTIVE_STATE: "최신 유효 상태를 충분히 확인하지 못했습니다",
  INFORMATION_LIMIT_DISCLOSURE: "일부 정보의 확인 여부를 충분히 명시하지 못했습니다",
  ATTRIBUTION_PRESERVATION: "회사 진술과 객관적 사실의 구분이 충분하지 않습니다",
  QUALIFIER_PRESERVATION: "원문의 한정 표현이 충분히 보존되지 않았습니다",
  REQUEST_COMPLETENESS: "질문의 일부 하위 요구사항이 충분히 답변되지 않았을 수 있습니다",
  NEUTRAL_COMPARABILITY_CAVEAT: "비교 기준 차이에 대한 주의문이 충분하지 않습니다",
  EVIDENCE_REFERENCED_NARRATIVE: "근거와 연결된 설명이 충분하지 않았습니다",
});

export const DEFAULT_LIMITATION_LABEL_KO = "일부 요청 사항은 충분히 확인되지 않았습니다";

export function limitationLabelKo(capabilityId) {
  return CAPABILITY_LIMITATION_LABELS_KO[capabilityId] ?? DEFAULT_LIMITATION_LABEL_KO;
}
