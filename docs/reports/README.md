# 공시 QA — 팀 공유 자료

이 폴더는 팀원에게 공유하려고 `experiments/reports/`(리포에 안 올라감)에서 복사해 온 것이다.
원본은 로컬 실험 폴더에 있고, 여기 있는 건 그 시점의 사본이다.

## 먼저 볼 것

| 순서 | 파일 | 내용 |
|---|---|---|
| 1 | [`final_experiment_audit.md`](final_experiment_audit.md) | **전체 감사 보고서.** 이거 하나면 전체 파악됨 (14개 절) |
| 2 | [`../diagrams/dart_qa_architecture.svg`](../diagrams/dart_qa_architecture.svg) | 구조도 한 장 — 파싱·청킹·검색·Agent·평가 루프·미채택 실험 |
| 3 | [`phase10_gold25_report.md`](phase10_gold25_report.md) | 25문항 실제 호출 결과 + 최종 의사결정표 |
| 4 | [`phase10_failure_analysis.md`](phase10_failure_analysis.md) | 실패 25건을 8가지 유형으로 분류 |
| 5 | [`phase11_failure_recovery.md`](phase11_failure_recovery.md) | 복구 가능한 실패만 고친 라운드 |
| 6 | [`retrieval_experiment_report.md`](retrieval_experiment_report.md) | 검색 실험 라운드 (청킹·BM25·리랭커) |
| 7 | [`phase7_report.md`](phase7_report.md) | 개선 가능성 검증 (Agent 관점 재평가) |

`data/` 아래는 위 보고서의 원본 수치 JSON이다. 숫자를 직접 확인하고 싶을 때 본다.

## 세 줄 요약

1. 검색 성능을 올리려고 **10가지 방법을 다 시도했지만 전부 기존 방식보다 같거나 나빴다.**
2. 실제 개선은 검색 다음 단계에서 나왔다 — 표에서 연도 열 제대로 찾기, 계산을 코드가 하기, 깨진 응답 살리기.
3. 25문항 실제 호출 결과 **지어낸 숫자 0건 · 빈 답변 0건.** 근거 없는 LLM 답변 9건은 전부 차단됐다.

## 헷갈리기 쉬운 것 두 개

**① 숫자 0.9429 vs 0.7429**
`0.9429`는 **정답 문서를 미리 넣어두고** 잰 낙관 조건이고, `0.7429`가 **실제로 검색해서 고른 문서**로 잰 값이다.
대외 자료에는 `0.7429`를 쓴다. 섞어 쓰면 발표에서 사고 난다.

**② gold25는 학습 데이터가 아니다**
파싱·인덱스는 공시 4,204건 전체에 같은 규칙으로 돌렸고, gold25 25문항은 그 결과를 **채점할 때만** 쓴다.
모델 학습·파인튜닝은 한 번도 하지 않았다. 고친 건 사람이 판단해서 바꾼 코드 규칙이다.

## 직접 돌려보려면

원문 데이터(`data/3.공시/corpus/`)가 있어야 한다. 큰 파일은 리포에 없어서 각자 만들어야 한다.

```bash
# 1. 인덱스 생성 (원문 필요)
python scripts/build_retrieval_doc_index.py      # -> doc_index.jsonl (107MB)
python scripts/extract_evidence_documents.py     # -> evidence_documents.jsonl (27MB)

# 2. 전체 테스트 (LLM 호출 없음)
DART_DETECTIVE_LLM=off pytest -q                 # 598 passed / 1 skipped

# 3. 검색 회귀 확인 (LLM 호출 없음)
DART_DETECTIVE_LLM=off python scripts/run_gold25_eval.py \
    --baseline docs/reports/data/results_gold25_final.json
```

API 키는 코드에 없다. 실제 LLM 호출을 하려면 `.env`에 `CLOVA_API_KEY`를 넣어야 하고,
`.env`는 git에 올라가지 않는다.

## 코드에서 볼 곳

```
src/dart_corpus/retrieval/document_index.py    1단계 검색 (문서 고르기)
src/dart_corpus/retrieval/chunk_index.py       2단계 검색 (조각 순위)
src/dart_corpus/evaluation/gold25.py           채점 기준 (지표 정의 고정)
src/dart_detective/agents/qa_agent.py          Agent 본체 · 연도 열 매핑
src/dart_detective/agents/calculator.py        결정론적 계산
src/dart_detective/agents/validator.py         근거 검증 (지어낸 숫자 차단)
src/dart_detective/llm.py                      HyperCLOVA X 어댑터 · JSON 파서 · 재시도
src/dart_detective/qa_service.py               POST /qa
```

## 아직 안 정한 것 (회의 안건)

1. 데모에 어떤 질문을 보여줄까 — 계산형·단건은 강하고, 여러 문서를 엮는 서술형은 발췌로 떨어질 확률이 높다
2. 서술형 답변 품질을 더 올릴까 — 프롬프트를 손대면 지금까지 측정치와 비교가 끊긴다
3. 계산기를 넓힐까 — 두 회사 비교·반기 비교 지원 시 4~5문항 개선, API 비용 0
4. 대외 숫자를 무엇으로 통일할까 — `0.7429` 권장
5. **정답 근거 140건 중 애매한 60건 검수** — 원문을 가진 팀원의 도움이 필요한 부분
