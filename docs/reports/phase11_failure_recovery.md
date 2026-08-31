# Phase 11 — 최소 실패 복구

측정일 2026-08-31 · PROMPT_VERSION `qa-2026-08-31.1` · fingerprint `21fcb1a14ff8` (둘 다 불변) ·
model HCX-005. 모델·청킹·retrieval·reranker·selector·calculator·prompt·Gold25 무변경.
validator 판정 기준도 무변경(느슨하게 만들지 않았다).

## 1. 수정 내역 (허용 범위 안)

| Fix | 파일 | 내용 |
|---|---|---|
| A. answer 정규화 | `agents/qa_agent.py` `answer_text` / `_element_text` | `answer`가 리스트로 오면 원소를 기계적으로 문자열화해 결합. dict 원소는 `키: 값 · 키: 값`. 값의 의미를 해석하거나 문장으로 재작성하지 않는다. `answer`가 dict 통째면 복구하지 않는다 |
| B. JSON 추출 | `llm.py` `_balanced_objects` / `extract_json` | 문자열 리터럴을 존중하며 최상위 `{...}` 후보를 각각 파싱. 정확히 1개면 채택, 2개 이상이면 모호하다고 실패, 깨진 JSON은 그대로 실패 |
| C. 429 재시도 | `llm.py` `_post` | 429일 때만 3초 대기 후 **최대 1회** 재시도. 그 외 오류·연결 실패는 재시도 없음. `last_retries`로 기록 |

## 2. 테스트 (수정 전에 작성)

`tests/agents/test_failure_recovery.py` 신규 — list 정규화 6건, JSON 추출 10건
(평문·깨진 JSON·잘못된 escape·오브젝트 2개·배열은 **실패로 남는지** 확인), 429 재시도 4건.
전체 **598 passed / 1 skipped** (`DART_DETECTIVE_LLM=off`).
Gold25 retrieval regression: E-R@1/3/5/10/20 전부 **+0.0000**.

## 3. 재측정 (문항당 1회, 총 5회 호출)

| QID | before (Phase 10) | after (Phase 11) | 결과 |
|---|---|---|---|
| Q06 | `AttributeError: list...` → 발췌 fallback | JSON PASS · LLM 답변 채택 · PARTIALLY_SUPPORTED · fabricated 0 | **복구** |
| Q25 | `AttributeError: list...` → 발췌 fallback | JSON PASS · 정규화 성공 · validator `unsupported`로 폐기 → fallback | 파서는 복구, 답변은 차단 유지 |
| Q24 | JSON 파싱 실패(`Extra data`) | JSON PASS · validator가 근거 미달로 폐기 → fallback | 파서는 복구, 답변은 차단 유지 |
| Q10 | HTTP 429 → fallback | 정상 응답 · PARTIALLY_SUPPORTED (재시도 0회) | **복구** |
| Q21 | HTTP 429 → fallback | 정상 응답 · PARTIALLY_SUPPORTED (재시도 0회) | **복구** |

Q02 / Q19 / Q23은 재호출하지 않았다. 오류가 각각 `Expecting ',' delimiter`,
`Invalid \escape`, `Expecting ',' delimiter` — **오브젝트 내부가 깨진 JSON**이라
포장 제거로 복구되는 형태가 아니다. 규칙상 의미 추론 수정은 금지.

Q06·Q25는 실제 payload가 **dict의 리스트**였다. 최초 정규화(문자열 원소만 결합)로는
빈 답이 되어 fallback으로 갔고, 저장된 raw 응답을 **API 호출 없이** 되먹여
원소 직렬화 방식으로 바꾼 뒤 Q06이 복구됐다(재호출 아님).

## 4. 전체 비교

| 지표 | Phase 10 (해당 5문항) | Phase 11 |
|---|---|---|
| API 호출 | 5 | 5 |
| 성공 응답 | 3 (429 2건 실패) | 5 |
| LLM 답변 채택 | 0 | 3 (Q06, Q10, Q21) |
| retry | 0 (기능 없음) | 0 (429 미발생) |
| fallback | 5 | 2 (Q24, Q25) |
| validator SUPPORTED / PARTIALLY | 5 / 0 | 2 / 3 |
| fabricated final answer | 0 | **0** |
| unsupported 숫자 문항 | 0 | 1 (Q21 — 검색 context에는 존재, 선택 evidence 대조 기준의 과엄격 판정) |
| latency 평균 | 3.0s | 11.0s (LLM이 실제로 답을 생성하게 됐기 때문) |
| tokens | 8,339 | 24,699 |
| 비용 | — | **38.89원 (VAT 별도) / 42.78원 (포함)** |

## 5. 합격 기준 점검

| 기준 | 결과 |
|---|---|
| 기존 정상 문항 regression 0 | 충족 — retrieval delta 0, 전체 테스트 598 통과, 변경은 파서/전송에 한정 |
| fabricated final answer 0 | 충족 |
| hallucination 차단 능력 유지 | 충족 — Q24·Q25는 파싱 성공 후에도 validator가 폐기 |
| 실패 문항 1건 이상 복구 | 충족 — 3건(Q06, Q10, Q21) |
| latency 비정상 증가 없음 | 충족 — 증가분은 LLM 응답 생성 자체(최대 16.3s, Phase 10 최대 18.0s 이내) |
| retry 무한 반복 없음 | 충족 — 최대 1회, 단위 테스트로 강제 |

## 6. 최종 표

| Fix | Target | Before | After | Regression | Decision |
|---|---|---|---|---|---|
| list normalization | Q06 / Q25 | 예외로 응답 폐기, 발췌 fallback | Q06 답변 채택(fabricated 0), Q25 validator 차단 | 없음 | **KEEP** |
| JSON extraction | Q24 (Q02/Q19/Q23 제외) | `Extra data`로 파싱 실패 | 파싱 성공, 답변은 근거 미달로 차단 | 없음 | **KEEP** |
| 429 retry | Q10 / Q21 | HTTP 429 → fallback | 정상 응답, 재시도 0회 | 없음 | **KEEP** |

## 7. 결론

- **Phase 10 baseline**: 25문항 중 LLM 답변 채택 5, fallback 20, API 429 2, JSON 실패 4, 형식 위반 2.
- **Phase 11 결과**: 대상 5문항 중 **3문항 복구**(Q06, Q10, Q21). Q24·Q25는 파서 단계는
  복구됐지만 validator가 답변을 차단해 fallback 유지 — 의도한 동작이다.
- **실제 개선 문항 수**: 3.
- **추가 비용**: 38.89원(VAT 별도) / 42.78원(포함). 누적 234.01원 / 257.41원, 상한 3,000원.
- **fabricated answer**: 0건.
- **regression**: 없음(retrieval delta 0, 테스트 598 통과, prompt fingerprint 불변).
- **production 적용 여부**: 세 수정 모두 KEEP 판정. 커밋은 하지 않았다(작업 트리에만 존재).

추가 실험은 이어가지 않는다.
