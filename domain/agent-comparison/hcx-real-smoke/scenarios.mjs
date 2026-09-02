// Turn P11-B: the five fixed synthetic scenario prompts this smoke is
// allowed to send. Every prompt here is entirely fabricated -- no real
// company name, no real DART figure, no Gold/DEV_TUNE/HOLDOUT question or
// answer text (CLAUDE.md's own corpus-boundary invariant, section 7 item
// 1, extended here to "no real Gold text either"). This is a PROTOCOL
// smoke, not a quality evaluation -- the scenarios exist to exercise the
// request/response envelope and the fail-closed paths, never to judge how
// good an answer is.
//
// Every prompt instructs the model to reply with the SAME structured JSON
// shape model-adapter.mjs's parseStructuredAnswer already expects:
// {"answer": "...", "used_fact_ids": [], "used_evidence_ids": []} -- both
// id arrays are always empty here since this smoke has no real Fact/
// Evidence records to authorize (hard-claim-grounding.mjs is out of scope
// for this Turn; see the P11-B instructions -- this only proves the
// transport/parsing contract, not citation binding).
//
// Turn P11-C priority-1 mitigation: 2 of the first 4 real HCX-005 calls
// (INFORMATION_LIMIT_RESPONSE, NUMBER_DATE_FORMAT_RESPONSE) came back
// MODEL_CALL_MALFORMED_RESPONSE under the P11-B wording above. The wording
// below is strengthened to explicitly forbid both a code fence and any
// leading/trailing explanatory sentence -- a prompt-level fix, tried before
// any parser-level tolerance (hcx-model-adapter.mjs's single-```json-fence
// allowance exists only as the documented fallback for whatever this
// strengthening does not fully eliminate).
const STRUCTURED_ANSWER_INSTRUCTION =
  '반드시 아래 JSON 객체 하나만 출력하세요. 코드블록(```)으로 감싸지 마세요. ' +
  'JSON 앞이나 뒤에 어떠한 설명 문장도 추가하지 마세요. 출력은 반드시 "{" 로 시작해서 "}" 로 끝나야 합니다: ' +
  '{"answer": "<한국어 답변>", "used_fact_ids": [], "used_evidence_ids": []}';

export const HCX_REAL_SMOKE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenario_type: "SHORT_KOREAN_FACT_SUMMARY",
    description: "짧은 한국어 사실 요약",
    prompt: `${STRUCTURED_ANSWER_INSTRUCTION}\n\n다음 가상의 문장을 한 문장으로 요약하세요: "가상 예시 문서에 따르면, 가상의 항목 X의 값은 1,000,000원으로 기재되어 있습니다."`,
  }),
  Object.freeze({
    scenario_type: "STRUCTURED_JSON_RESPONSE",
    description: "구조화 JSON 응답",
    prompt: `${STRUCTURED_ANSWER_INSTRUCTION}\n\n가상의 항목 Y와 가상의 항목 Z 중 어느 쪽이 더 큰 개념인지, 실제 사실과 무관하게 한 문장으로만 답하세요.`,
  }),
  Object.freeze({
    scenario_type: "INFORMATION_LIMIT_RESPONSE",
    description: "정보 부족 시 제한 답변",
    prompt: `${STRUCTURED_ANSWER_INSTRUCTION}\n\n주어진 정보가 전혀 없는 상태에서, 가상의 항목 W의 정확한 수치를 알 수 없다는 취지로만 답하세요. 추측하지 마세요.`,
  }),
  Object.freeze({
    scenario_type: "NUMBER_DATE_FORMAT_RESPONSE",
    description: "숫자·날짜 형식 응답",
    prompt: `${STRUCTURED_ANSWER_INSTRUCTION}\n\n가상의 예시로, 금액은 "1,234,567원", 날짜는 "2026-01-15" 형식을 그대로 사용해 한 문장으로 답하세요.`,
  }),
  Object.freeze({
    scenario_type: "SAFE_EDGE_CASE_INPUT",
    description: "잘못된/모호한 입력에 대한 안전한 처리",
    prompt: `${STRUCTURED_ANSWER_INSTRUCTION}\n\n입력: "???!!!===" -- 이 입력이 의미 있는 질문이 아니라는 점을 짧게 안내하는 답변만 하세요.`,
  }),
]);
