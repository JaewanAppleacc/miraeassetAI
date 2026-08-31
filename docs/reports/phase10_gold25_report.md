# Phase 10 — Gold25 E2E 최종 검증 (freeze candidate)

측정일 2026-08-31 · PROMPT_VERSION `qa-2026-08-31.1` · fingerprint `21fcb1a14ff8` ·
model HCX-005 · Gold25 25문항 **1회만** 실행 · 재호출/재시도 없음(가드로 강제).

프리즈 대상: Chunking A0 / BM25 / hybrid·reranker·dense 없음 / stage1_k 50 /
column-aware selector / deterministic calculator / quote·derived·unsupported 분리 validator.
이번 Phase에서 production·prompt·gold·retrieval·chunking 변경 없음.

## 1. 실행 전 검증

| 항목 | 결과 |
|---|---|
| PROMPT_VERSION | `qa-2026-08-31.1` (일치) |
| prompt fingerprint | `21fcb1a14ff8` (일치) |
| calculator / column-aware selector / validator `derived` 인자 | 전부 적용 확인 |
| Gold25 데이터 | `gold25.jsonl` 25행, evidence 140행 — 변경 없음 |
| 전체 테스트 (`DART_DETECTIVE_LLM=off`) | **575 passed, 1 skipped** |
| 러너 예행(스텁 LLM, API 0회) | 25문항 완주 확인 후 실호출 |

## 2. 문항별 기록

| QID | LLM used | skipped | API | JSON | schema | validator | fallback | degraded | derived | latency(ms) | in tok | out tok | total | gold ev | 최종 답변 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Q01 | True | - | OK | PASS | PASS | PARTIALLY_SUPPORTED | N | - | 0 | 7118 | 5393 | 160 | 5553 | 0/3 | LLM 서술 |
| Q02 | False | - | OK | FAIL | - | SUPPORTED | Y | - | 0 | 3055 | 1521 | 103 | 1624 | 0/2 | 발췌 fallback |
| Q03 | True | - | OK | PASS | PASS | PARTIALLY_SUPPORTED | N | - | 0 | 2352 | 2658 | 53 | 2711 | 0/2 | LLM 서술 |
| Q04 | True | - | OK | PASS | PASS | SUPPORTED | Y | unsupported | 0 | 4368 | 6193 | 115 | 6308 | 0/3 | 발췌 fallback |
| Q05 | True | - | OK | PASS | PASS | PARTIALLY_SUPPORTED | N | - | 0 | 3955 | 2759 | 135 | 2894 | 1/6 | LLM 서술 |
| Q06 | False | - | OK | PASS | PASS | SUPPORTED | Y | - | 0 | 11587 | 1520 | 486 | 2006 | 0/8 | 발췌 fallback |
| Q07 | True | - | OK | PASS | PASS | PARTIALLY_SUPPORTED | N | - | 0 | 7741 | 5823 | 268 | 6091 | 1/2 | LLM 서술 |
| Q08 | True | - | OK | PASS | PASS | SUPPORTED | Y | unsupported | 0 | 5780 | 3920 | 218 | 4138 | 0/9 | 발췌 fallback |
| Q09 | True | - | OK | PASS | PASS | SUPPORTED | Y | unsupported | 0 | 18026 | 7407 | 665 | 8072 | 0/9 | 발췌 fallback |
| Q10 | False | - | FAIL (HTTP 429) | - | - | SUPPORTED | Y | - | 0 | 690 | - | - | - | 2/4 | 발췌 fallback |
| Q11 | False | deterministic_calculation | 호출없음 | - | - | SUPPORTED | Y | - | 4 | 524 | - | - | - | 0/4 | 계산+발췌 |
| Q12 | False | deterministic_calculation | 호출없음 | - | - | SUPPORTED | Y | - | 4 | 801 | - | - | - | 4/4 | 계산+발췌 |
| Q13 | True | - | OK | PASS | PASS | PARTIALLY_SUPPORTED | N | - | 0 | 6391 | 4937 | 199 | 5136 | 0/4 | LLM 서술 |
| Q14 | True | - | OK | PASS | PASS | SUPPORTED | Y | unsupported | 0 | 9666 | 7378 | 254 | 7632 | 0/4 | 발췌 fallback |
| Q15 | True | - | OK | PASS | PASS | SUPPORTED | Y | unsupported | 0 | 11104 | 5273 | 403 | 5676 | 0/4 | 발췌 fallback |
| Q16 | False | deterministic_calculation | 호출없음 | - | - | SUPPORTED | Y | - | 4 | 1310 | - | - | - | 0/8 | 계산+발췌 |
| Q17 | True | - | OK | PASS | PASS | SUPPORTED | Y | unsupported | 0 | 10244 | 3258 | 412 | 3670 | 0/9 | 발췌 fallback |
| Q18 | True | - | OK | PASS | PASS | SUPPORTED | Y | unsupported | 0 | 5340 | 6792 | 170 | 6962 | 1/5 | 발췌 fallback |
| Q19 | False | - | OK | FAIL | - | SUPPORTED | Y | - | 0 | 4249 | 3571 | 144 | 3715 | 0/5 | 발췌 fallback |
| Q20 | True | - | OK | PASS | PASS | SUPPORTED | Y | unsupported | 0 | 3329 | 3024 | 116 | 3140 | 0/5 | 발췌 fallback |
| Q21 | False | - | FAIL (HTTP 429) | - | - | SUPPORTED | Y | - | 0 | 430 | - | - | - | 2/6 | 발췌 fallback |
| Q22 | True | - | OK | PASS | PASS | SUPPORTED | Y | unsupported | 0 | 10709 | 2809 | 424 | 3233 | 0/7 | 발췌 fallback |
| Q23 | False | - | OK | FAIL | - | SUPPORTED | Y | - | 0 | 4118 | 1472 | 145 | 1617 | 1/6 | 발췌 fallback |
| Q24 | False | - | OK | FAIL | - | SUPPORTED | Y | - | 0 | 3677 | 4231 | 96 | 4327 | 0/8 | 발췌 fallback |
| Q25 | False | - | OK | PASS | PASS | SUPPORTED | Y | - | 0 | 13389 | 3654 | 559 | 4213 | 0/13 | 발췌 fallback |

## 3. 전체 요약

| 지표 | 값 |
|---|---|
| total questions | 25 |
| 실제 API 호출 | 22 (3문항은 계산 성립으로 호출 자체 없음) |
| LLM 답변 채택 | 5 |
| deterministic calculation | 3 (Q11, Q12, Q16) |
| API 실패 | 2 (HTTP 429, Q10·Q21) |
| JSON parse 실패 | 4 (Q02, Q19, Q23, Q24) |
| schema 실패 | 0 |
| 응답 형식 실패(answer가 문자열이 아닌 list) | 2 (Q06, Q25) |
| validator UNSUPPORTED (최종) | 0 |
| validator SUPPORTED / PARTIALLY_SUPPORTED | 20 / 5 |
| degraded (LLM 답 폐기 후 발췌 대체) | 9 |
| fallback | 20 |
| gold evidence coverage (Agent 선택 evidence 기준) | 12/140 |
| latency 평균 / 중앙값 / 최대 | 5,998ms / 4,368ms / 18,026ms |
| tokens in / out / total | 83,593 / 5,125 / 88,718 |
| 비용 | **130.12원 (VAT 별도) · 143.13원 (VAT 포함)** |

주의: 요약 JSON의 `validator_partial`은 0으로 찍히지만 실제 상태 문자열은
`PARTIALLY_SUPPORTED`다(집계 키 이름 불일치). 실분포는 SUPPORTED 20 / PARTIALLY_SUPPORTED 5.

## 4. Retrieval 회귀 (LLM 무관, 별도 측정)

| metric | Phase 9 | Phase 10 | delta |
|---|---|---|---|
| E-R@1 | 0.2929 | 0.2929 | +0.0000 |
| E-R@3 | 0.6214 | 0.6214 | +0.0000 |
| E-R@5 | 0.6786 | 0.6786 | +0.0000 |
| E-R@10 | 0.8214 | 0.8214 | +0.0000 |
| E-R@20 | 0.9429 | 0.9429 | +0.0000 |

evidence verdict (140건): **HIT 103 · P1 2 · P2 6 · P4 29**

P4 정의 주의: 이번 집계는 "상위 20 안에 있으나 같은 인용이 **전체 랭킹 청크** 5개 이상에
중복 등장"으로 셌다. 과거 라운드의 P4=1은 상위 20 내부 중복만 센 값이라 **직접 비교 불가**다.
비교 가능한 값은 HIT+P4=132 = E-R@20 0.9429×140로, 과거(131+1=132)와 동일하다.
즉 랭킹 자체는 Phase 9와 완전히 같다.

조건 표기: 위 수치는 Stage 2 후보를 gold 문서 캐시로 구성한 **historical/optimistic 조건**이며
Phase 9 baseline과 같은 조건이다. 실제 후보문서 조건(top-70 캐시)의 값은 E-R@20 0.7429로 별개다.

## 5. 최종 의사결정표

| Component | Current | Result | Decision |
|---|---|---|---|
| Chunking | A0 | E-R@20 0.9429, 회귀 0 | KEEP |
| Retrieval | BM25 | P1 2 / P2 6 (140건 중), 회귀 0 | KEEP |
| stage1_k | 50 | doc miss 2건뿐 | KEEP |
| Selector | column-aware | 계산형 3문항에서 연도·열 정확 매핑 | KEEP |
| Calculator | deterministic | 3문항 무호출 처리, 값 정확 / 기업·반기 차원 미지원 | KEEP (확장 후보) |
| Reranker | none | 도입 근거 없음(P2 6건) | KEEP |
| Dense | none | 동일 | KEEP |
| Prompt | qa-2026-08-31.1 | 형식 위반 6/22 — 프롬프트가 아니라 파서/모델 문제 | FREEZE |

## 6. 질문에 대한 답

1. **답변 품질 개선됐나** — 계산형은 확실히 개선(틀린 계산 → 정확한 값, 호출 0원).
   서술형은 개선 없음: 22회 중 6회가 형식 위반, 9회가 근거 미달로 폐기됐다.
2. **정상 처리 문항 수** — 실질 답변 8문항(LLM 서술 5 + 계산 3), 안전 발췌 17문항,
   빈 답변·오답 유출 0문항.
3. **calculator가 제거한 LLM 호출** — 3문항(Q11, Q12, Q16).
4. **hallucination 차단** — 근거 미달 LLM 답변 9건 전부 차단, 최종 답변 `fabricated` 0건.
5. **가장 큰 병목** — LLM 응답 형식/근거 준수. 22회 중 6회 형식 위반 + 9회 근거 미달 = 15회가
   LLM 답변으로 살아남지 못했다.
6. **병목 위치** — retrieval도 selector도 아니고 **LLM(및 응답 파서)**. 검색은 회귀 0,
   selector는 계산형에서 정확 동작, validator는 차단 목적을 달성했다.
7. **지금 production 수정해야 하나** — 아니다. 다만 `answer`가 list일 때 문자열로 합치는
   파서 보완(2문항 즉시 복구)은 위험이 낮아 우선순위 1순위 후보다.
8. **다음 실험** — (a) 응답 파서 관용도 보완 후 재측정, (b) 호출 간격으로 429 회피,
   (c) calculator에 기업·반기 차원과 단순 증감액 추가.
9. **예상 비용** — 25문항 재측정 1회 약 130원(VAT 포함 143원). 파서·간격만 고치고
   실패했던 8문항만 재측정하면 약 45원.
