# QA 파이프라인 기준선 (baseline)

**기준 커밋: `3d89a97`** — 이 문서의 모든 수치는 그 시점에서 실제로 측정한 값이다.

> **HyperCLOVA X를 붙이지 않은 상태의 기준선이다.** LLM은 한 번도 호출하지 않았고,
> 모든 답변은 결정론적 발췌(fallback) 경로로 나왔다. 크레딧 발급 후 실호출 결과는
> 이 표와 비교해야 하며, 그때 달라지는 것은 **답변 문장**이지 검색 지표가 아니다.

측정 방법:

```bash
python scripts/run_gold25_eval.py --baseline experiments/gold25_retrieval/results_gold25_final.json
python scripts/qa_e2e.py --set all --quiet --out work/qa_e2e_all.json
python -m pytest -q
```

---

## 1. Retrieval (freeze)

| 지표 | 값 |
|---|---|
| E-R@1 | 0.2929 |
| E-R@3 | 0.6214 |
| E-R@5 | 0.6786 |
| E-R@10 | 0.8214 |
| **E-R@20** | **0.9429** |
| **HIT** | **131 / 140** |
| doc_ceiling@20 | 0.9786 |
| P1 (문서 miss) | 3 — Q17 ×2, Q08 ×1 |
| P2 (청크 miss) | 5 — Q08 ×2, Q14 ×2, Q21 ×1 |
| P4 (동일 값 중복) | 1 — Q21 |

설정: `stage1_k=50`, `section_alpha=0.5`, `row_alpha=0.5`, `strategy=line_window`,
`budget_pool=20`, `corp_query=drop`.

이 값이 **회귀 게이트의 기준**이다. `--baseline`을 걸면 하나라도 떨어질 때 exit 1.

관련 커밋: `4f70d08`(모듈 tracked) · `95c6bba`(섹션 규칙 확장) · `acf0be0`(기업명 토큰 제외).

## 2. End-to-End (25문항, LLM 미사용)

| 항목 | 값 |
|---|---|
| 배선 통과 | 25 / 25 |
| Validator 판정 | 전 문항 SUPPORTED |
| gold 근거가 LLM 발췌에 포함 | **127 / 140 (0.907)** |
| gold 근거를 slot으로 지목 | 9 / 140 |
| 검색 후보(top-20 청크)까지의 상한 | 132 / 140 (0.943) |
| 다중 문서 문항 | 19 / 25 (multi 셋 19/19 통과, 문맥 105/118) |
| 시연 셋 | 5 / 5 통과, 문맥 22 / 24 |

`slot으로 지목`이 낮은 것은 자리당 근거 1건 구조 때문이며 보류 항목이다. LLM이 답을
쓰는 재료는 `발췌 포함` 쪽 숫자다.

## 3. Latency (LLM 미사용)

| 구간 | 중앙값 | 최대 |
|---|---|---|
| 전체 | 216 ms | 2,284 ms |
| 검색(Stage 1+2) | 213 ms | 2,280 ms |
| LLM | — (호출 없음) | — |

인덱스 최초 적재는 별도로 수십 초 걸린다(지연 로딩). 시연 전 `/qa` 1회 예열 필요.

## 4. 프롬프트 (freeze)

| 항목 | 값 |
|---|---|
| `PROMPT_VERSION` | `qa-2026-08-29.1` |
| `prompt_fingerprint()` | `7fa9a327526f` |
| LLM 발췌 청크 수 | **16** |
| 프롬프트 크기 | 중앙값 7,775자 · 최대 11,728자 · 25문항 합계 181,090자 |
| 출력 상한 | `maxTokens=2048`, `temperature=0.0` |
| 응답 스키마 | `src/dart_detective/qa_response.schema.json` |

지문은 system 프롬프트 + user 템플릿 + 응답 스키마의 해시다. 셋 중 하나라도 바뀌면
테스트가 실패한다. 바꾸려면 `PROMPT_VERSION`을 올리고 이 문서의 수치를 다시 잡아야 한다.

청크 수는 실측으로 골랐다 — gold 근거 회수 / 문항당 문자수:
`3 → 0.621 (1,386)` · `8 → 0.807 (3,357)` · **`16 → 0.921 (6,077)`** · `20 → 0.943 (7,443)`.

## 5. 안전장치

- 근거 없는 수치·인용은 Validator가 잡아 LLM 답변을 폐기하고 발췌 답변으로 되돌린다
  (`degraded_reason`: `unsupported` / `empty_answer`).
- LLM 실패(HTTP 401/429/500·네트워크·JSON 파싱 실패)는 전부 fallback, API는 200 유지.
- 기업 사전에 없는 이름은 조건으로 잡히지 않아 다른 회사 공시가 근거가 될 수 있다 →
  `warnings: ["corp_unspecified"]` + `evidence_corps`로 표시하고 `uncertainty`에 적는다.
  답변을 막지는 않는다.
- 알려진 한계: Validator가 만/백만/억 환산값을 허용하므로 **단위 오기**는 잡지 못한다.

## 6. 테스트

**543 passed / 1 skipped / 0 failed / 0 collection error** (커밋 `3d89a97` 시점).

| 영역 | 건수 |
|---|---|
| `tests/retrieval` | 100 |
| `tests/evaluation` (gold25 하니스) | 21 |
| `tests/agents` (Agent·API·계약·경계) | 80 |
| `tests/test_evidence_validator.py` | 17 |
| 그 외 (파싱·계약·케이스팩 등) | 나머지 |

`langgraph`·`fastapi`·`httpx`·`jsonschema`를 `.venv`에 설치해 이전의 collection error 3건은 해소됐다.

## 7. 기준선 이후 변경 (수치 불변 확인됨)

`3d89a97` 이후 다음이 추가됐다. Retrieval·E2E·프롬프트 수치는 그대로다 —
gold 25 회귀 delta 전부 0.0000, 25문항 E2E 25/25 유지, 테스트는 551 passed / 1 skipped로 늘었다.

- 기업 안전장치: `evidence_corps`, `warnings`(`corp_unspecified` / `corp_mismatch`)를
  응답에 노출하고 `uncertainty`에 문장으로 적는다. 답변은 막지 않는다.
- 비용/usage: provider가 준 usage 키를 이름 그대로 집계, `stop_reason` 기반 출력 잘림
  감지, `--limit N` / `--qids`로 크레딧을 조금씩 쓰고 실패 문항만 재실행.
- 서버 로그: uvicorn 아래에서도 요청 한 줄 로그가 실제로 남도록 로거 레벨을 직접 설정.

### 시연 리허설 실측 (HTTP 경유, LLM 없음)

| 항목 | 값 |
|---|---|
| 서버 기동 | 3초 |
| 첫 `/qa`(인덱스 적재 포함) | 4.1초 — **시연 전 1회 예열 필수** |
| 예열 후 demo 5문항 | 5/5, 전체 중앙값 235ms · 최대 798ms |
| 빈 질문 | HTTP 422 |
| `/health`, `/qa/health` | 정상, `index_ready` / `loaded` 반영 |

주의: HTTP 응답에는 검색 본문이 없어(스키마 고정) `gold 근거의 LLM 발췌 포함률`은
HTTP 경유로는 측정되지 않는다 — 그 지표는 로컬 실행(`--set all`)으로만 잰다.

## 8. 크레딧 발급 후 다시 잴 것

이 문서의 1·3·4·6은 LLM과 무관하므로 그대로 유지되어야 한다. 새로 측정할 것:

- LLM 호출 성공률 / `degraded` 비율(근거 불일치·빈 답)
- Validator 통과율 (SUPPORTED / PARTIALLY / UNSUPPORTED 분포)
- LLM latency, 실제 `usage` 토큰 수
- 답변 문장 정확도 — `data/eval/gold25_qa.jsonl`의 `expected_answer`가 아직 비어 있어
  (`answer_review_status: needs_human`) 문장 채점은 사람 검수 후에만 가능하다.
