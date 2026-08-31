# Phase 10 — 실패 유형 분류

분류 코드: A 검색 miss · B selector miss · C context/slot 구조 · D LLM 형식 위반 ·
E LLM 추론 오류 · F validator 문제 · G 결정론적 계산 문제 · H 정상 fallback

| QID | 최종 상태 | 원인 | 설명 |
|---|---|---|---|
| Q01 | LLM 서술 · PARTIALLY | — | 계약금액·기간 정확. gold span은 선택 evidence에 0/3이지만 답 자체는 검색 context 근거 |
| Q02 | 발췌 fallback | D, H | JSON parse 실패(`Expecting , delimiter`) → 안전 발췌 |
| Q03 | LLM 서술 · PARTIALLY | E | "아니요" 단답 — 주식수·지분율 수치를 제시하지 않음 |
| Q04 | 발췌 fallback | G, F(정상) | "얼마나 줄었는가" 계산형인데 slot이 `지표_연도`가 아니라 calculator 미발동 → LLM이 38,791 계산 → validator 차단 |
| Q05 | LLM 서술 · PARTIALLY | — | 1,383주 / 74,128,800원 — context 근거 존재 |
| Q06 | 발췌 fallback | D, H | 모델이 `answer`를 문자열이 아닌 list로 반환 → `AttributeError: list has no attribute strip` |
| Q07 | LLM 서술 · PARTIALLY | — | 서술 정상 |
| Q08 | 발췌 fallback | F | LLM 답이 원문 한 줄과 사실상 동일한데 공백 차이로 quote 대조 실패 → 과잉 거부 의심 |
| Q09 | 발췌 fallback | E, F(정상) | 취득주식수·기간 수치가 근거에 없음 → 차단 |
| Q10 | 발췌 fallback | API(429), G | HTTP 429로 호출 실패. 반기 비교형이지만 반기 열을 slot이 못 잡아 calculator도 미발동 |
| Q11 | 계산+발췌 | — | 매출액 30.26% / 영업이익 152.00% — 코드 계산 |
| Q12 | 계산+발췌 | — | 3.15% / 46.28% |
| Q13 | LLM 서술 · PARTIALLY | G | 두 기업 2025년 비교 — 같은 연도 두 기업이라 calculator 미발동, 차이값은 LLM이 제시하지 않음 |
| Q14 | 발췌 fallback | E, F(정상) | "매출액 변화 없음"은 오답. 근거 없는 수치라 차단됨 |
| Q15 | 발췌 fallback | E, F(정상) | 근거 수치 없는 비교 서술 → 차단 |
| Q16 | 계산+발췌 | G | 두 기업 비교인데 calculator에 기업 차원이 없어 HMM 값만 계산 — 현대모비스 몫 누락 |
| Q17 | 발췌 fallback | F | LLM이 "정보 부족"이라고 답했는데 그 답도 거부 → 과잉 거부 |
| Q18 | 발췌 fallback | E, F(정상) | 발행주식수 54,495주는 오독 → 차단 |
| Q19 | 발췌 fallback | D, H | JSON parse 실패(`Invalid \escape`) |
| Q20 | 발췌 fallback | G, F(정상) | "얼마나 증가했는가" 계산형, calculator 미발동 → LLM 계산값 차단 |
| Q21 | 발췌 fallback | API(429) | 호출 실패, 재시도 없음 |
| Q22 | 발췌 fallback | E, F(정상) | 계약금액 서술 중 근거 밖 수치 → 차단 |
| Q23 | 발췌 fallback | D, H | JSON parse 실패 |
| Q24 | 발췌 fallback | D, H | JSON parse 실패(`Extra data`) |
| Q25 | 발췌 fallback | D, H | `answer`가 list |

## 유형별 집계

| 유형 | 건수 | 문항 |
|---|---|---|
| D LLM 형식 위반 | 6 | Q02, Q06, Q19, Q23, Q24, Q25 |
| API 실패(429) | 2 | Q10, Q21 |
| G 계산 미발동/범위 부족 | 5 | Q04, Q10, Q13, Q16, Q20 |
| E LLM 추론 오류(차단됨) | 6 | Q09, Q14, Q15, Q18, Q22, Q03 |
| F validator 과잉 거부 의심 | 2 | Q08, Q17 |
| A 검색 miss | 0 문항 단위 | evidence 단위로 P1 2 / P2 6 |
| H 정상 fallback | 20 | 답변이 비지 않고 원문 발췌로 안전 종료 |

## hallucination

- 최종 답변 기준 validator `fabricated`: **전 문항 빈 목록**.
- 근거 없는 수치를 담은 LLM 답변 9건은 전부 `degraded_reason=unsupported`로 폐기되고
  원문 발췌로 대체됐다 — 사용자에게 나간 답에는 남지 않았다.
- Q01·Q05는 "Agent가 고른 evidence"만 대조하는 더 엄격한 지표에서 미근거로 잡혔지만,
  검색 context에는 존재하는 값이라 hallucination이 아니다. 판정 기준 차이일 뿐이다.
- 계산형에서 calculator가 동작한 문항(Q11·Q12·Q16)은 코드 계산값을 ground truth로 두고
  LLM 계산과 비교하지 않았다(설계상 LLM 호출 자체가 없었다).

## 코드 수정으로 해결 가능한 것 / 이번 범위 밖

**해결 가능(프롬프트 변경 없이)**
1. `answer`가 list로 오는 경우 문자열로 합치기 — Q06, Q25 즉시 복구 (2문항).
2. 호출 간 간격 삽입으로 429 회피 — Q10, Q21 (2문항). 재시도가 아니라 rate 조절.
3. `Extra data` 유형은 첫 JSON 오브젝트까지만 취해 복구 가능 — Q24. (평문→JSON 강제 변환이 아님)
4. calculator 확장: 기업 차원(Q16), 반기/분기 열(Q10), 단순 증감액·차이형(Q04, Q13, Q20).

**이번 범위 밖(건드리지 않음)**
- retrieval P1 2 / P2 6 — 이미 여러 라운드에서 한계 확인, 코퍼스/청킹 변경 필요.
- validator 과잉 거부(Q08, Q17) — 완화하면 hallucination 차단력이 같이 떨어진다. 별도 설계 필요.
- 프롬프트/PROMPT_VERSION — freeze 유지.
