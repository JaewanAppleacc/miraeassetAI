# DART 공시 QA — 최종 실험 감사 (Release Audit)

작성 2026-08-31 · LLM API 호출 **0회**(`DART_DETECTIVE_LLM=off`) · Gold25 원본 무수정 ·
production 코드 무수정 · 커밋 없음.

모든 수치는 `experiments/` 아래 기존 결과 파일에서 가져왔다. 파일이 남아 있지 않은 값은
"세션 기록(파일 미보존)"으로 따로 표시했고 실측과 섞지 않았다.

---

## 1. Executive Summary

- 이번 감사에서 새로 실행한 것: 전체 테스트, Gold25 retrieval 회귀, 산출물 대조. **API 호출 없음.**
- 결과: **598 passed / 1 skipped**, retrieval delta **전 구간 +0.0000**,
  `PROMPT_VERSION=qa-2026-08-31.1`, fingerprint `21fcb1a14ff8` — 전부 기대값과 일치.
- 실험 전체를 통틀어 **baseline(A0 + BM25 + k=50)을 이긴 조합은 없었다.** 청킹 6종, Kiwi 형태소
  BM25, bge-m3 reranker, stage1_k 4종 모두 동률이거나 하락이었다.
- 실제 개선은 검색이 아니라 **검색 이후 계층**에서 나왔다: column-aware selector(Phase 8),
  deterministic calculator(Phase 9), parser/normalization/retry 복구(Phase 11).
- 사용자에게 나간 답변 중 **fabricated(근거 없는 숫자) = 0건**. Phase 10/11 전 구간에서 확인.
- 중요한 감사 발견: **Phase 8·9·11의 production 코드가 아직 커밋되지 않았다.**
  HEAD(`62f5c06`)의 `PROMPT_VERSION`은 `qa-2026-08-29.1`이고 calculator·column-aware
  selector·balanced JSON parser·answer 정규화·429 재시도가 없다. 지금 배포하면 Phase 7 시점
  코드가 나간다.

---

## 2. Final Architecture

```
질문
 └ 조건 추출(기업/기간)  extract_conditions
 └ Stage 1  DocumentIndex  BM25 + 하드필터(기업/기간), stage1_k=50, 기업명 토큰 drop
 └ Stage 2  ChunkIndex     BM25(음절 bigram) + 섹션 라우팅 α=0.5 + row-label 신호
 └ Selector  slot(지표_연도) 매칭 · 표 머리글 기반 연도→열 매핑 (column-aware)
 └ Calculator  계산형이면 코드가 산술 수행 (Decimal, ROUND_HALF_UP) → LLM 호출 생략
 └ LLM  HCX-005, 상위 16청크 문맥, PROMPT_VERSION qa-2026-08-31.1 / fp 21fcb1a14ff8
        · 응답 파싱: balanced JSON object 추출 · answer 리스트 기계적 정규화 · 429 1회 재시도
 └ Validator  quote / number(source·derived 구분) / period / 추론 검사
 └ 실패 시 fallback: 원문 발췌 답변 (빈 답변을 내보내지 않는다)
```

---

## 3. Retrieval Experiments

조건: **Stage 1 실제 후보 문서**(top-70 캐시 756건). 출처 `retrieval_experiment_matrix.json`,
`retrieval_models.json`.

| variant | 청킹 | 검색 | reranker | E-R@20 | Δ | HIT | P1 | P2 | P4 | latency median | 판정 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | A0 line_window | BM25 | no | 0.7429 | — | 104 | 3 | 22 | 11 | 1,441ms | **KEEP** |
| B1-A0 | A0 | BM25+Kiwi | no | 0.6857 | −0.0572 | 96 | 3 | 23 | 18 | 25,209ms | REJECT |
| B1-A1 | A1 | BM25+Kiwi | no | 0.5857 | −0.1572 | 82 | 3 | 36 | 19 | 1,098ms | REJECT |
| D-rerank50 | A0 | BM25 | bge-m3 top-50 | 0.7286 | −0.0143 | 102 | 3 | 23 | 12 | 76,589ms | REJECT |

- **Kiwi 형태소 분절이 오히려 하락.** 현행 토크나이저가 음절 bigram이라 조사 변형에 이미 강하고,
  형태소 경계가 표의 항목명과 어긋난다.
- **Reranker는 성능도 못 올리고 latency가 53배.** 문항당 중앙값 76.6초.
- **Dense 전면 검색 미실행**: bge-m3 CPU 실측 3.2 chunks/s, 문항당 청크 12,706개 → variant당 수 시간.
  GPU·faiss 없음. (`retrieval_models.json` `dense_note`)
- **Hybrid(RRF) 미실행**: 결합 대상인 dense 쪽 점수를 만들 수 없어 성립하지 않는다.

---

## 4. Chunking Experiments

출처 `chunking_variants.json` (같은 실제 후보 문서 조건).

| variant | E-R@1 | E-R@5 | E-R@20 | Δ@20 | HIT | P2 | latency median | 판정 |
|---|---|---|---|---|---|---|---|---|
| A0 production line_window | 0.1500 | 0.5143 | **0.7429** | — | 104 | 22 | 1,441ms | **KEEP** |
| A1 paragraph | 0.2071 | 0.4571 | 0.7357 | −0.0072 | 103 | 25 | 1,167ms | REJECT |
| A2 heading+paragraph | 0.2000 | 0.4857 | 0.7357 | −0.0072 | 103 | 24 | 1,224ms | REJECT |
| A3 table row | 0.0714 | 0.1500 | 0.3143 | −0.4286 | 44 | 61 | 2,446ms | REJECT |
| A4 heading+table row | 0.0857 | 0.2071 | 0.3500 | −0.3929 | 49 | 59 | 3,376ms | REJECT |
| A5 window small(6/4) | 0.1429 | 0.3643 | 0.6071 | −0.1358 | 85 | 35 | 1,678ms | REJECT |
| A5 window large(20/14) | 0.1857 | 0.4786 | 0.7214 | −0.0215 | 101 | 24 | 1,300ms | REJECT |

A1/A2는 @1이 A0보다 높지만(0.207/0.200 vs 0.150) @20에서 뒤진다. Agent 관점 지표
(`agent_view.json`)에서도 A0의 `LLM_CONTEXT_RECALL@16 = 0.7214`가 기준이며, 문맥 16청크로
자를 때 A0가 불리해지지 않는다.

---

## 5. Stage1-k Sweep

출처 `results_stage1_k_sweep_v2.json`(gold 문서 캐시 조건), `..._v2_realdocs.json`(실제 후보 조건).

| k | @20 (gold 캐시) | HIT/P1/P2/P4 | @20 (실제 후보) | HIT/P1/P2/P4 | 판정 |
|---|---|---|---|---|---|
| 50 | 0.9429 | 131/3/5/1 | **0.7429** | 104/3/22/11 | **KEEP** |
| 55 | 0.9500 | 133/1/5/1 | 0.7429 | 104/1/24/11 | 미채택 |
| 60 | 0.9500 | 133/1/5/1 | 0.7429 | 104/1/24/11 | 미채택 |
| 70 | 0.9500 | 133/1/5/1 | 0.7357 | 103/1/24/12 | REJECT |

k를 올리면 낙관 조건에서만 Q17 문서 miss 1건이 회복되고(+0.0071), 실제 후보 조건에서는
**개선이 사라지며 k=70은 Q19가 악화**된다. 후보 문서가 늘어난 만큼 Stage 2 청크도 늘어
(12,706 → 12,793) 노이즈가 상쇄한다. k=50 유지.

---

## 6. Selector Fix (Phase 8)

문제: 계산형 질문에서 slot이 표의 **연도 열**을 잘못 잡았다.
수정: 표 머리글에서 기간 열을 읽어 `지표_연도` slot을 해당 열 값에 매핑(`period_columns`/`value_at`),
요청 연도가 표 기간에 없으면 그 청크를 건너뛴다. dedup 키는 `(chunk_id, line, column)`.

| 항목 | before | after |
|---|---|---|
| Q12 slot 매핑 | 연도/열 혼동 | 4개 slot 전부 정확한 문서·열 (매출액 59,254,361 / 61,118,127, 영업이익 2,295,284 / 3,357,456) |
| Q12 validator | PARTIAL | SUPPORTED |
| Gold25 retrieval | — | delta +0.0000 |

판정 **KEEP**. 검색을 건드리지 않고 selector만 고쳤으므로 retrieval 회귀 없음.

---

## 7. Deterministic Calculator (Phase 9)

| 항목 | LLM 계산 | 코드 계산 |
|---|---|---|
| Q12 매출액 증가율 | 2.95% (오답) | **3.15%** |
| Q12 영업이익 증가율 | 46.67% (오답) | **46.28%** |
| Validator 통과 | 불가(원문에 없는 숫자) | derived로 분리해 통과 |
| API 비용 | 호출 필요 | **호출 0회** |

Phase 10 all-25에서 계산이 성립한 문항은 3건(Q11, Q12, Q16) — 전부 LLM 호출 없이 처리됐다.
계산 조건(같은 지표의 연도 2개, 기준값≠0, 단위 일치, 비교 표현 존재)을 만족하지 못하면 계산하지
않는다. 단위 테스트 18건. 판정 **KEEP**.

한계: slot에 기업 차원이 없어 두 기업 비교(Q16)는 한쪽만 계산된다. 반기/분기 열(Q10)과
단순 증감액형(Q04·Q20)도 미지원.

---

## 8. LLM Reliability / Failure Recovery

출처 `phase10_gold25_e2e.json`, `phase11_failure_recovery.json`.

| 단계 | 관측 | 비용(실측) |
|---|---|---|
| prompt freeze 이전 Q12 | 평문/스키마 위반 응답으로 파싱 실패 (세션 기록, 로그 파일 미보존) | 세션 기록 |
| prompt 강화 후 Q12 | JSON 계약 회복. 다만 LLM 산술이 틀림(2.95%/46.67%) | 세션 기록 |
| Phase 9 Q12 | 계산 성립 → **API 호출 0회**, SUPPORTED | 0원 |
| Phase 10 all-25 | 호출 22회 · 답변 채택 5 · JSON 실패 4 · 형식 위반 2 · 429 2 · degraded 9 · fallback 20 | 130.12원 |
| Phase 11 recovery | 대상 5문항 1회씩 · **3문항 복구**(Q06, Q10, Q21) · Q24·Q25는 파서만 복구되고 validator가 차단 | 38.89원 |

Phase 11 수정 3종(answer 정규화 / balanced JSON 추출 / 429 1회 재시도) 전부 **KEEP**.
합격 기준(회귀 0, fabricated 0, 차단력 유지, 1건 이상 복구, latency 정상, 무한 retry 없음) 충족.

---

## 9. Failure Taxonomy

| 유형 | 발생 | 원인 | 현재 대응 | 잔존 | fabricated 유출 가능성 |
|---|---|---|---|---|---|
| A. Retrieval miss | 있음 — evidence 140건 중 P1 2 / P2 6 (Phase 10 측정, gold 캐시 조건) | 문서가 Stage 1 밖(P1) 또는 청크 랭킹 밖(P2) | 없음 — 여러 라운드에서 baseline 초과 조합을 못 찾음 | **남음** | 없음(답을 못 할 뿐) |
| B. Evidence/selector mapping | Phase 8 이전 발생, 이후 해소 | 표 연도 열 혼동 | column-aware 매핑, 불확실하면 값 미제공 | 계산형 일부(기업 차원·반기) | 없음 |
| C. Deterministic calculation | 5문항에서 **미발동**(Q04·Q10·Q13·Q16·Q20) | slot이 `지표_연도` 형태가 아니거나 기업/반기 차원 부재 | 미발동 시 계산하지 않음 → LLM 계산은 validator가 차단 | **남음** | 없음 |
| D. LLM output format | 6/22 (JSON 실패 4 + answer=list 2) | 모델이 스키마를 안 지킴 | Phase 11: 리스트 정규화·balanced 추출로 3건 복구. 내부가 깨진 JSON은 실패 유지 | **남음**(Q02·Q19·Q23) | 없음(fallback) |
| E. LLM reasoning / hallucination | 9건 (근거 없는 수치·오독) | 모델 오류 | validator가 답변 폐기 후 원문 발췌로 대체 | 남음(모델 특성) | **차단됨** |
| F. Validator rejection | 과잉 거부 의심 2건(Q08·Q17) | 공백 차이 등으로 quote 대조 실패, "정보 부족" 답변도 거부 | 완화하지 않음(차단력 우선) | **남음** | 없음 |
| G. API failure / 429 | Phase 10에서 2건 | 호출 속도 제한 | 429만 1회 재시도 + 실행 간격 | 남음(외부 요인) | 없음 |
| H. Parser/normalization | Phase 10에서 6건 | 위 D와 동일 원인의 처리 실패 | Phase 11에서 복구 경로 추가 | 일부 남음 | 없음 |

**fabricated final answer = 0건.** 근거: Phase 10 25문항 전부 `numbers_grounded.fabricated = []`,
Phase 11 5문항도 동일(`fabricated_final: 0`). 근거 미달 LLM 답변 9건은 전량 폐기되어
사용자에게 나가지 않았다.

---

## 10. Cost

**실측(usage 로그가 파일로 남아 있는 것)**

| 구간 | 호출 | input | output | VAT 별도 | VAT 포함 | 출처 |
|---|---|---|---|---|---|---|
| Phase 7 | 0 | 0 | 0 | 0원 | 0원 | LLM 금지 라운드 |
| Phase 9 (Q12) | 0 | 0 | 0 | 0원 | 0원 | 계산 성립으로 호출 생략 |
| Phase 10 | 22 | 83,593 | 5,125 | 130.12원 | 143.13원 | `phase10_gold25_e2e.json` |
| Phase 11 | 5 | 22,561 | 2,138 | 38.89원 | 42.78원 | `phase11_failure_recovery.json` |
| **실측 합계** | **27** | **106,154** | **7,263** | **169.01원** | **185.91원** | |

**세션 기록(로그 파일 미보존 — 실측과 구분)**: 시연 5문항 31.9원, Q01 재현 6.9원,
Q12 프로브 3회 27.4원 ≈ **65원(VAT 별도)**. Phase 8의 Q12 단일 호출도 여기 포함된다.

**총계**: 약 **234.01원(VAT 별도) / 257.41원(포함)**.
예산 3,000원 대비 사용률 **약 7.8%(별도) / 8.6%(포함)**. 이번 감사 추가 비용 **0원**.

---

## 11. Regression / Safety Gate

| 항목 | 기대값 | 이번 감사 실측 | 판정 |
|---|---|---|---|
| pytest (`DART_DETECTIVE_LLM=off`) | 598 passed / 1 skipped | **598 passed / 1 skipped** | PASS |
| E-R@1 / @3 / @5 / @10 / @20 | delta +0.0000 | 0.2929 / 0.6214 / 0.6786 / 0.8214 / 0.9429, **전 구간 +0.0000** | PASS |
| PROMPT_VERSION | qa-2026-08-31.1 | qa-2026-08-31.1 | PASS |
| prompt fingerprint | 21fcb1a14ff8 | 21fcb1a14ff8 | PASS |
| Gold25 원본 | 무변경 | `data/eval/gold25.jsonl` 25행, evidence 140행 — git 변경 없음 | PASS |
| production 검색 로직 | 무변경 | `src/dart_corpus/retrieval/` diff는 CRLF 줄바꿈 노이즈뿐(`--ignore-all-space` 결과 공백) | PASS |

---

## 12. Production Recommendation

### KEEP (유지·적용)

| component | 현재 결정 | production(HEAD) 반영 여부 | 근거 |
|---|---|---|---|
| chunking | A0 line_window | 반영됨 | A1~A5 전부 동률 또는 하락 (최대 −0.4286) |
| retrieval | BM25 (음절 bigram) | 반영됨 | Kiwi −0.0572, rerank −0.0143 |
| stage1_k | 50 | 반영됨 | 실제 후보 조건에서 55·60 동률, 70 하락 |
| 섹션 라우팅/기업 토큰 drop | 14차·15차 반영 | 반영됨(`95c6bba`, `acf0be0`) | 회귀 0으로 채택 완료 |
| selector | column-aware | **미반영 — 커밋 필요** | Q12 4 slot 정확 매핑, 회귀 0 |
| calculator | deterministic | **미반영 — 커밋 필요** | LLM 산술 오답 제거, 3문항 호출 0회 |
| validator | source/derived/unsupported 분리 | **미반영 — 커밋 필요** | fabricated 0 유지, 차단 9건 |
| parser | balanced JSON object | **미반영 — 커밋 필요** | Q24 파싱 복구, 모호·손상은 실패 유지 |
| answer normalization | dict/list 기계적 정규화 | **미반영 — 커밋 필요** | Q06 복구, Q25는 validator가 차단 |
| retry | 429만 최대 1회 | **미반영 — 커밋 필요** | Q10·Q21 정상 응답 |
| prompt | qa-2026-08-31.1 / 21fcb1a14ff8 | **미반영 — HEAD는 qa-2026-08-29.1** | freeze 대상 버전이 커밋되지 않음 |

### REJECT (실험했으나 적용하지 않음)

Kiwi 형태소 BM25 · bge-m3 reranker(top-50) · 청킹 A1/A2/A3/A4/A5 · stage1_k 55/60/70 ·
validator 완화 · 평문→JSON 강제 변환 · 429 외 오류 재시도.

### EXPERIMENTAL / NOT MEASURED

dense 전면 검색(CPU 3.2 chunks/s로 실행 불가) · hybrid RRF(dense 점수 부재로 성립 불가) ·
reranker 다른 모델·top-100 · 전체 코퍼스 4,204문서 운영(추정 청크 1,237,894개, 캐시 726MB) ·
추가 Agent(query planner / 별도 reranker / answer critic).

### KNOWN LIMITATIONS

1. 실제 후보 문서 조건의 E-R@20은 **0.7429**다. 자주 인용되는 0.9429는 gold 문서만 Stage 2에
   넣은 낙관 조건이며 절대 성능이 아니다.
2. 서술형 문항에서 LLM 답변이 살아남는 비율이 낮다 — Phase 10 기준 22회 중 5회.
   나머지는 형식 위반·근거 미달로 원문 발췌 fallback.
3. calculator에 기업·반기 차원이 없다(Q16 한쪽만 계산, Q10·Q04·Q13·Q20 미발동).
4. validator 과잉 거부 의심 2건(Q08·Q17).
5. gold 라벨 자체의 모호성: `gold_audit_report.json` 기준 VALID 64 / AMBIGUOUS 60 /
   WEAK_LABEL 14 / INVALID_CANDIDATE 2 (gold는 수정하지 않았다).
6. 전체 코퍼스 운영은 미검증 — 현재는 top-50 후보 캐시(756문서, 130.6MB) 범위에서만 측정.
7. **Phase 8·9·11 코드가 커밋되지 않아 HEAD 기준 배포는 Phase 7 상태다.**

### FINAL RECOMMENDATION

> "현재 환경에서 baseline을 이긴 retrieval/chunking/reranker 조합은 발견되지 않았으며,
> production은 A0 + BM25 + k=50 + column-aware selector + deterministic calculator +
> validator + 현재 prompt/parser/normalization/retry 구성을 유지한다."

**데이터와 일치한다.** 검증:
검색 후보 10종 전부 Δ@20 ≤ 0 (`retrieval_experiment_matrix.json`), stage1_k 55/60은 실제 조건에서
동률·70은 하락(`results_stage1_k_sweep_v2_realdocs.json`), selector·calculator·parser·normalization·
retry는 각각 회귀 0으로 개선이 확인됨(Phase 8/9/11 보고서).
단, "유지"가 성립하려면 Phase 8·9·11 변경을 **커밋해야 한다** — 현재 그 구성은 작업 트리에만 있다.

---

## 13. Reproducibility / Artifact List

| 산출물 | 내용 |
|---|---|
| `src/dart_corpus/evaluation/gold25.py` | 공통 평가 하니스(지표 정의 고정, 커밋됨) |
| `scripts/run_gold25_eval.py` | 회귀 실행기, `--baseline`으로 하락 시 exit 1 |
| `experiments/gold25_retrieval/results_gold25_final.json` | retrieval 기준선 |
| `experiments/reports/chunking_variants.json` | 청킹 A0~A5 |
| `experiments/reports/retrieval_models.json` | BM25 / Kiwi |
| `experiments/reports/rerank_bge-m3_top50_A0_rerank.json` | reranker |
| `experiments/reports/retrieval_experiment_matrix.json` | 검색 실험 통합 매트릭스 |
| `experiments/gold25_retrieval/results_stage1_k_sweep_v2*.json` | stage1_k 스윕(두 조건) |
| `experiments/reports/agent_view.json` | Agent 관점 문맥 recall |
| `experiments/reports/gold_audit_report.json` | gold 라벨 검수(수정 없음) |
| `experiments/reports/full_corpus_feasibility.json` | 전체 코퍼스 규모 추정 |
| `experiments/reports/phase10_gold25_e2e.json` / `phase10_retrieval.json` | all-25 E2E, verdict |
| `experiments/reports/phase11_failure_recovery.json` / `phase11_replay*.json` | 복구 실험, 무호출 재현 |
| `experiments/reports/final_experiment_audit.md` | 이 문서 |

재현 순서:
```
DART_DETECTIVE_LLM=off .venv/bin/python -m pytest -q
DART_DETECTIVE_LLM=off .venv/bin/python scripts/run_gold25_eval.py \
    --baseline experiments/gold25_retrieval/results_gold25_final.json
```
