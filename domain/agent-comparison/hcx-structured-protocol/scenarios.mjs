// Turn P11-D: the five fixed synthetic scenarios shared by BOTH candidates
// (CLAUDE.md Turn P11-D section F: "동일 합성 scenario 5개"). Mirrors
// hcx-real-smoke/scenarios.mjs's own corpus-boundary discipline -- every
// task text here is entirely fabricated, no real company/DART figure, no
// Gold/DEV_TUNE/HOLDOUT text. This is a structured-OUTPUT-protocol smoke,
// not a quality evaluation: the task text exists only to give the model
// something to answer about, never to judge how good the answer is.
//
// `allowedFactIds`/`allowedEvidenceIds` are the synthetic citation universe
// for THIS scenario -- pre-test 17 ("evidence ID 불일치 거부") checks that a
// candidate's used_fact_ids/used_evidence_ids never contain an id outside
// this set (a purely structural check; this smoke has no real Fact/
// Evidence store to authorize against, same limitation
// hcx-real-smoke/scenarios.mjs already documents).
//
// Deliberately NO json-formatting instruction in the task text itself
// (unlike hcx-real-smoke/scenarios.mjs's STRUCTURED_ANSWER_INSTRUCTION
// prefix): structure is enforced by the PROTOCOL layer this Turn compares
// (a forced tool call / response_format=json_schema), not by prompt
// wording -- CLAUDE.md Turn P11-D section F's "동일 의미의 prompt"
// requirement means the two candidates must differ only in protocol, never
// in how hard the prompt begs for JSON.
function scenario(scenario_type, description, task, allowedFactIds, allowedEvidenceIds) {
  return Object.freeze({
    scenario_type,
    description,
    task,
    allowedFactIds: Object.freeze([...allowedFactIds]),
    allowedEvidenceIds: Object.freeze([...allowedEvidenceIds]),
  });
}

export const P11D_STRUCTURED_PROTOCOL_SCENARIOS = Object.freeze([
  scenario(
    "SHORT_KOREAN_FACT_SUMMARY",
    "짧은 한국어 사실 요약",
    "다음 가상의 사실 하나만 사용해 한 문장으로 요약해 주세요: 가상 항목 X의 값은 1,000,000원입니다 (근거: synth_fact_0001, synth_evidence_0001). "
      + "위 두 근거 id 외의 다른 id는 인용하지 마세요. 이 두 id를 실제로 사용했다면 각각 used_fact_ids/used_evidence_ids에 넣으세요.",
    ["synth_fact_0001"],
    ["synth_evidence_0001"],
  ),
  scenario(
    "STRUCTURED_JSON_RESPONSE",
    "구조화 응답 비교",
    "가상 항목 Y(근거: synth_fact_0002)와 가상 항목 Z(근거: synth_fact_0003) 중, 실제 사실과 무관하게 어느 쪽이 더 큰 개념인지 한 문장으로만 답하세요. "
      + "사용한 근거 id만 used_fact_ids에 넣고, evidence id는 사용하지 않았다면 빈 배열로 두세요.",
    ["synth_fact_0002", "synth_fact_0003"],
    [],
  ),
  scenario(
    "INFORMATION_LIMIT_RESPONSE",
    "정보 부족 시 제한 답변",
    "가상 항목 W에 대한 근거 자료가 전혀 제공되지 않았습니다. 정확한 수치를 알 수 없다는 취지로만 한 문장으로 답하고, "
      + "used_fact_ids와 used_evidence_ids는 반드시 빈 배열로 두세요. 추측하지 마세요.",
    [],
    [],
  ),
  scenario(
    "NUMBER_DATE_FORMAT_RESPONSE",
    "숫자·날짜 형식 응답",
    "다음 가상 사실을 근거로 답하세요: 가상 계약의 금액은 1,234,567원이고 체결일은 2026-01-15입니다 (근거: synth_fact_0004, synth_evidence_0002). "
      + "금액과 날짜 형식을 그대로 사용해 한 문장으로 답하고, 실제로 사용한 근거 id만 각 배열에 넣으세요.",
    ["synth_fact_0004"],
    ["synth_evidence_0002"],
  ),
  scenario(
    "SAFE_EDGE_CASE_INPUT",
    "잘못된/모호한 입력에 대한 안전한 처리",
    "다음 입력은 의미 있는 질문이 아닙니다: \"???!!!===\". 이 점을 짧게 안내하는 답변만 하고, "
      + "used_fact_ids와 used_evidence_ids는 반드시 빈 배열로 두세요.",
    [],
    [],
  ),
]);
