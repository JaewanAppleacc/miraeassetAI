# 심사위원 모드 — DEV_TUNE 101 전수 평가 (2026-09-03 밤, 실 HCX)

전제: 이 101문항이 실제 평가 문항이라고 가정하고, 평가자가 받는 5필드 응답만 보고 채점했다.

## 총평 (채점 축별)

| 축 | 결과 | 판정 |
|---|---|---|
| 5필드 계약·근거 표시 | 위반 0 · 접수번호 표시 96/101 | 통과 |
| 정보한계 대응 | 답변가능성 98/101 (오판 3) | 강함 |
| 근거 기반(환각) | 원문에 없는 값으로 나간 답 0 · 검증 실패 답 0 | 강함 |
| **정확성(값)** | **완전 32 · 부분 37 · 미포함 23 / 92** | **가장 약함 — 개선 1순위** |
| 근거 완전성 | 필수 슬롯 전부 실린 문항 33/101 | 약함 — 정확성과 같은 뿌리 |

## 값 손실은 어디서 나나 (92문항 원인 분해)

| 원인 | 건수 | 뜻 | 고칠 곳 |
|---|---|---|---|
| 정상(완전) | 32 | — | — |
| **선택손실** | **28** | 정답 줄이 검색 상위20에 **있는데** 근거 선택이 안 실음 | match_evidence·MAX_EVIDENCE(5) — 검색 재실험 불필요, 에이전트 층 수정 |
| 검색손실 | 19 | 상위20에 아예 없음(21~200위) | Stage 2 순위 — 4-arm 승자 확정 후 후보 폭 조정 |
| 추출손실 | 13 | 근거는 완비됐는데 값이 답 문장에 없음 | FC 프롬프트·claim 조립(요구 항목별 claim 강제) |

## 유형별

| 유형 | 완전 | 선택손실 | 검색손실 | 추출손실 |
|---|---|---|---|---|
| COMPARISON_CALC | 5 | 5 | 0 | 2 |
| EVENT_TRACE | 1 | 1 | 2 | 1 |
| NARRATIVE_MULTI_DOC | 11 | 0 | 1 | 8 |
| NUMERIC_LOOKUP | 15 | 22 | 16 | 2 |

LLM 경로 실패 19건 내역: claim 전멸/검증 폐기 13 · 템플릿 폴백 3 · JSON 파싱 실패 3. 간헐 40009는 0(2중 안전망 흡수).

## 개선 우선순위 (기대 효과 순)

1. **근거 선택 개선(선택손실 28건)** — 정답이 이미 검색돼 있는데 버려진다. MAX_EVIDENCE 상향(5→8),
   다중 슬롯 문항의 슬롯별 라인 할당, 슬롯 매치 청크의 LLM 문맥 승격. 검색 실험과 무관해 지금 바로 가능.
   상한 +28문항 → 완전 32→최대 60.
2. **추출손실 13건 + 서술 빈약 11건** — FC 프롬프트에 '요구 항목마다 claim 하나' 강제, 서술형 조립 보강.
3. **claim 전멸 13건** — 전멸 시 JSON 경로 1회 재시도(지금은 바로 템플릿).
4. **검색손실 19건** — 4-arm 승자 확정 후 후보 폭·row-label 부스트 조정(승자 코어에 종속이라 마지막).
5. 답변가능성 오판 3건(유보 계열) — 유보 감지 규칙 미세 조정.

## 문항별 결함 목록 (101)

| ID | 유형 | 값 | 슬롯 | 원인 | 태그 |
|---|---|---|---|---|---|
| 6cd77c | NUMERIC_LOOK | partial | 0/2 | 선택손실 | RETRIEVAL_MISS LLM_PATH_FAILED |
| 1755a8 | NARRATIVE_MU | full | 1/2 | 정상 | RETRIEVAL_MISS |
| ecdd59 | NUMERIC_LOOK | full | 1/1 | 정상 | - |
| 00959c | COMPARISON_C | full | 1/2 | 정상 | RETRIEVAL_MISS |
| 181d97 | COMPARISON_C | full | 2/2 | 정상 | - |
| e16a33 | NUMERIC_LOOK | full | 1/1 | 정상 | - |
| ae3945 | COMPARISON_C | full | 1/2 | 정상 | RETRIEVAL_MISS |
| 8ec8fc | COMPARISON_C | zero | 1/2 | 선택손실 | RETRIEVAL_MISS |
| c01cde | NUMERIC_LOOK | zero | 0/2 | 선택손실 | RETRIEVAL_MISS |
| 592dbf | NUMERIC_LOOK | full | 1/1 | 정상 | - |
| ab7806 | NUMERIC_LOOK | full | 1/2 | 정상 | RETRIEVAL_MISS |
| de32fb | NUMERIC_LOOK | full | 1/1 | 정상 | - |
| 16d67e | NUMERIC_LOOK | zero | 1/2 | 검색손실 | RETRIEVAL_MISS |
| 588b5d | NUMERIC_LOOK | zero | 0/2 | 선택손실 | RETRIEVAL_MISS |
| 1e614a | ANSWERABILIT | na | 0/1 | - | RETRIEVAL_MISS |
| e3c71e | NUMERIC_LOOK | partial | 0/2 | 선택손실 | RETRIEVAL_MISS LLM_PATH_FAILED |
| 6c4edf | NUMERIC_LOOK | zero | 0/2 | 검색손실 | RETRIEVAL_MISS |
| 421b89 | NARRATIVE_MU | full | 0/1 | 정상 | RETRIEVAL_MISS NARRATIVE_THIN |
| 802e4c | COMPARISON_C | full | 1/2 | 정상 | RETRIEVAL_MISS NARRATIVE_THIN |
| b364b5 | NUMERIC_LOOK | full | 1/1 | 정상 | - |
| aa14ad | EVENT_TRACE | full | 1/1 | 정상 | NARRATIVE_THIN |
| 20281b | ANSWERABILIT | na | 0/1 | - | RETRIEVAL_MISS |
| 1c536f | NARRATIVE_MU | full | 0/1 | 정상 | RETRIEVAL_MISS |
| 606bb2 | NUMERIC_LOOK | full | 1/1 | 정상 | - |
| 947a98 | NUMERIC_LOOK | full | 0/2 | 정상 | RETRIEVAL_MISS LLM_PATH_FAILED |
| 03e280 | NUMERIC_LOOK | zero | 0/2 | 선택손실 | RETRIEVAL_MISS LLM_PATH_FAILED |
| 4d7ea6 | NUMERIC_LOOK | full | 1/2 | 정상 | RETRIEVAL_MISS LLM_PATH_FAILED |
| 24e656 | NARRATIVE_MU | full | 1/1 | 정상 | NARRATIVE_THIN |
| eba8b5 | ANSWERABILIT | na | 0/1 | - | RETRIEVAL_MISS |
| 2df4f1 | COMPARISON_C | zero | 0/2 | 선택손실 | RETRIEVAL_MISS |
| 71ebb7 | COMPARISON_C | full | 0/2 | 정상 | RETRIEVAL_MISS |
| 1cdbe0 | NARRATIVE_MU | zero | 1/1 | 추출손실 | VALUE_NOT_EXTRACTED NARRATIVE_THIN |
| 704c83 | NUMERIC_LOOK | full | 1/2 | 정상 | RETRIEVAL_MISS LLM_PATH_FAILED |
| 0f1aaa | NARRATIVE_MU | full | 1/1 | 정상 | NARRATIVE_THIN |
| 0814f0 | NUMERIC_LOOK | zero | 0/2 | 선택손실 | RETRIEVAL_MISS |
| 7b9dd4 | NARRATIVE_MU | full | 1/1 | 정상 | ANSWERABILITY_WRONG LLM_PATH_FAILED |
| 170e80 | COMPARISON_C | zero | 1/2 | 선택손실 | RETRIEVAL_MISS |
| faaa3c | NUMERIC_LOOK | zero | 0/2 | 검색손실 | RETRIEVAL_MISS |
| ded4db | NARRATIVE_MU | full | 1/1 | 정상 | LLM_PATH_FAILED |
| 157819 | NUMERIC_LOOK | full | 0/2 | 정상 | RETRIEVAL_MISS LLM_PATH_FAILED |
| 071043 | NARRATIVE_MU | full | 1/2 | 정상 | RETRIEVAL_MISS |
| 14a65a | NARRATIVE_MU | zero | 1/2 | 검색손실 | RETRIEVAL_MISS NARRATIVE_THIN |
| cfeeb7 | NARRATIVE_MU | full | 1/2 | - | RETRIEVAL_MISS |
| 64bf74 | NARRATIVE_MU | full | 1/1 | 정상 | NARRATIVE_THIN |
| e9a348 | NUMERIC_LOOK | partial | 2/2 | 추출손실 | VALUE_NOT_EXTRACTED |
| 9c7a62 | NUMERIC_LOOK | full | 1/1 | 정상 | - |
| 3df555 | NUMERIC_LOOK | full | 1/1 | 정상 | LLM_PATH_FAILED |
| a84caa | ANSWERABILIT | na | 0/1 | - | RETRIEVAL_MISS |
| fd2cc4 | NUMERIC_LOOK | zero | 0/2 | 선택손실 | RETRIEVAL_MISS |
| 015c34 | NARRATIVE_MU | full | 2/2 | 정상 | - |
| 7b5358 | NUMERIC_LOOK | full | 1/2 | 정상 | RETRIEVAL_MISS LLM_PATH_FAILED |
| a57a3b | NARRATIVE_MU | full | 1/1 | 정상 | - |
| 40322d | NARRATIVE_MU | full | 1/1 | - | ANSWERABILITY_WRONG LLM_PATH_FAILED |
| 589096 | NUMERIC_LOOK | partial | 0/4 | 선택손실 | RETRIEVAL_MISS |
| 44167a | NARRATIVE_MU | partial | 3/3 | 추출손실 | VALUE_NOT_EXTRACTED LLM_PATH_FAILED |
| 2a533d | NUMERIC_LOOK | partial | 0/5 | 검색손실 | RETRIEVAL_MISS |
| 22edda | NUMERIC_LOOK | partial | 0/5 | 검색손실 | RETRIEVAL_MISS |
| 6a6f84 | COMPARISON_C | zero | 0/4 | 선택손실 | RETRIEVAL_MISS |
| 9ae50c | EVENT_TRACE | partial | 3/4 | 선택손실 | RETRIEVAL_MISS LLM_PATH_FAILED |
| 616fc0 | NUMERIC_LOOK | partial | 0/5 | 선택손실 | RETRIEVAL_MISS LLM_PATH_FAILED |
| c7e8a2 | NUMERIC_LOOK | zero | 0/5 | 검색손실 | RETRIEVAL_MISS |
| 68f632 | EVENT_TRACE | partial | 5/5 | 추출손실 | VALUE_NOT_EXTRACTED |
| 7a5eaa | NUMERIC_LOOK | full | 4/4 | 정상 | - |
| e549bb | NUMERIC_LOOK | partial | 0/5 | - | ANSWERABILITY_WRONG RETRIEVAL_MISS |
| c79279 | NUMERIC_LOOK | partial | 0/5 | 검색손실 | RETRIEVAL_MISS |
| 228ae2 | NUMERIC_LOOK | zero | 2/4 | 선택손실 | RETRIEVAL_MISS |
| 806459 | NUMERIC_LOOK | partial | 4/6 | 선택손실 | RETRIEVAL_MISS |
| 76bfca | NUMERIC_LOOK | zero | 0/4 | 검색손실 | RETRIEVAL_MISS |
| ca19df | EVENT_TRACE | zero | 0/5 | 검색손실 | RETRIEVAL_MISS NARRATIVE_THIN |
| 207e74 | COMPARISON_C | partial | 4/4 | 추출손실 | VALUE_NOT_EXTRACTED |
| bbb527 | NUMERIC_LOOK | partial | 3/4 | 검색손실 | RETRIEVAL_MISS LLM_PATH_FAILED |
| c3056a | COMPARISON_C | partial | 2/4 | 선택손실 | RETRIEVAL_MISS |
| e22cbb | NUMERIC_LOOK | partial | 0/5 | 검색손실 | RETRIEVAL_MISS |
| a59fd6 | NUMERIC_LOOK | partial | 0/4 | 검색손실 | RETRIEVAL_MISS |
| 56d9d2 | NARRATIVE_MU | partial | 4/4 | 추출손실 | VALUE_NOT_EXTRACTED |
| 3bd978 | NUMERIC_LOOK | partial | 2/4 | 선택손실 | RETRIEVAL_MISS |
| 13f0bd | NARRATIVE_MU | partial | 4/4 | 추출손실 | VALUE_NOT_EXTRACTED |
| fad1bd | NUMERIC_LOOK | partial | 0/4 | 선택손실 | RETRIEVAL_MISS |
| b92f60 | NUMERIC_LOOK | partial | 5/5 | 추출손실 | VALUE_NOT_EXTRACTED |
| 2232c8 | NARRATIVE_MU | partial | 4/4 | 추출손실 | VALUE_NOT_EXTRACTED |
| a6b787 | NUMERIC_LOOK | zero | 0/6 | 검색손실 | RETRIEVAL_MISS |
| d072bf | NUMERIC_LOOK | zero | 0/5 | 검색손실 | RETRIEVAL_MISS |
| 8e6ea1 | NUMERIC_LOOK | partial | 2/4 | 선택손실 | RETRIEVAL_MISS LLM_PATH_FAILED |
| f8aa63 | NUMERIC_LOOK | partial | 3/5 | 선택손실 | RETRIEVAL_MISS |
| 9b933e | NUMERIC_LOOK | partial | 2/4 | 선택손실 | RETRIEVAL_MISS |
| 7d8edf | COMPARISON_C | partial | 4/4 | 추출손실 | VALUE_NOT_EXTRACTED |
| 4e7461 | NUMERIC_LOOK | partial | 5/6 | 검색손실 | RETRIEVAL_MISS |
| 405cad | NUMERIC_LOOK | partial | 3/4 | 선택손실 | RETRIEVAL_MISS |
| 83ab1a | NARRATIVE_MU | partial | 3/3 | 추출손실 | VALUE_NOT_EXTRACTED NARRATIVE_THIN |
| 5d82c1 | NARRATIVE_MU | zero | 3/3 | 추출손실 | VALUE_NOT_EXTRACTED NARRATIVE_THIN |
| 5f4b4a | NUMERIC_LOOK | partial | 2/4 | 선택손실 | RETRIEVAL_MISS |
| f3efeb | NUMERIC_LOOK | full | 4/4 | - | - |
| 6bd524 | EVENT_TRACE | zero | 0/2 | 검색손실 | RETRIEVAL_MISS |
| f7508b | NARRATIVE_MU | partial | 3/3 | 추출손실 | VALUE_NOT_EXTRACTED |
| 5cb6cd | NUMERIC_LOOK | partial | 3/4 | 선택손실 | RETRIEVAL_MISS |
| ab5044 | ANSWERABILIT | partial | 0/0 | - | - |
| d0cbe0 | NUMERIC_LOOK | partial | 0/5 | 검색손실 | RETRIEVAL_MISS |
| c60c83 | NUMERIC_LOOK | partial | 3/4 | 선택손실 | RETRIEVAL_MISS LLM_PATH_FAILED |
| 67d683 | NUMERIC_LOOK | partial | 3/5 | 선택손실 | RETRIEVAL_MISS |
| fcce62 | NUMERIC_LOOK | zero | 3/4 | 검색손실 | RETRIEVAL_MISS |
| 4f6655 | NUMERIC_LOOK | partial | 3/5 | 선택손실 | RETRIEVAL_MISS LLM_PATH_FAILED |