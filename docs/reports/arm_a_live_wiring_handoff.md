# Arm A live wiring — handoff (Turn A-PLUS-QA-LIVE-WIRING-V1)

Base: `codex/a-plus-qa-adapter-v01` @ `acb5104`. Branch: `codex/a-plus-qa-live-wiring-v01`.
Scope: `arm_a_adapter.ArmAFrozenResultsRetriever`(RetrieverAdapter Protocol)를 `answer_api`의
실제 서빙 경로에 연결. 성능평가·Gold·judge34·101문항·DEV_CHECK/HOLDOUT·실 LLM은 실행하지 않았다.

## 1. `build_serving_retriever()` tuple 계약 (확인)

`retriever_adapter.build_serving_retriever(arm) -> (retriever, store, arm, pins)`.
`retriever`는 qa_agent가 소비하는 CorpusRetriever 모양이어야 한다:

| 멤버 | qa_agent 사용처 |
|---|---|
| `conditions(question) -> QueryConditions` | `qa_agent.py:1842` (필수) |
| `retrieve(question, conditions=None, *, k=None) -> list[RetrievedChunk]` | `:1860`, `:1916` (필수) |
| `docs_by_id: Mapping[str, dict]` | `:988`, `:1955` (getattr, 없으면 `{}`) |
| `statement_scopes(doc_id)` | `:1872` (hasattr 검사, soft) |
| `document_index`, `_rcept_dt` | `:989-990`, `:1667` (getattr, 없으면 해당 기능 건너뜀) |

`store`는 `readiness().pins`·`len()`만 쓴다. `pins`는 캐시 키(qa_service가 pins 해시)에 들어간다.

## 2. 브리지 — `src/dart_detective/arm_a_serving_bridge.py` (신규)

- `ArmAServingRetriever(adapter, base)`: `retrieve()`만 A(adapter.search → RetrievedChunk 변환),
  `conditions/docs_by_id/statement_scopes/document_index/_rcept_dt`는 base(기존 CorpusRetriever +
  NodeStore, `build_line_window_retriever`)에 위임. 검색 순위는 A, 원문 읽기·조건 추출은 기존 코어.
- 변환 규칙: rank·score·doc_id·chunk_id·node_index는 A값 그대로. `metadata.provenance`에
  `node_indices` 전체·`chunk_text_sha256`·`score_type`·`row/col`·`locator`(A 원문 표기)·
  question_id/arm/segment/config_sha256/code_sha256 보존. 문서 메타(corp_name·rcept_dt·doc_group…)는
  base의 문서 색인(`_metadata_of`)에서 붙임. `metadata.arm="A"`, `metadata.retrieval_backend`.
- `build_arm_a_serving_retriever(*, text_resolver, results_path=None, gold_questions_path=None,
  base_factory=build_line_window_retriever, **paths) -> (retriever, store, "A", pins)`.
  pins: `strategy=fixed_512_chunk`, `dense=present`, `retrieval_backend`, `arm_a_adapter_version`,
  `arm_a_results_sha256`(파일 해시), `arm_a_mode`, `arm_a_n_questions`, `text_resolver_configured`,
  `arm_ready`.

## 3. `answer_api` — retrieval_backend 선택 (수정: 이 파일만)

- `configure(*, retrieval_backend=None, text_resolver=None, **backend_options)`: 백엔드·A 경로의
  text_resolver·옵션(results_path/gold_questions_path/base_factory/…) 주입. 인자 없이 호출 = env 기본.
- 선택 순서: `configure()` 인자 > env `DART_QA_RETRIEVAL_BACKEND` > `DEFAULT`.
  - `DEFAULT`(기본): 기존 `build_serving_retriever(os.environ.get("DART_QA_ARM", "D"))` 그대로 — 호출
    인자·pins·readiness pins 불변.
  - `ARM_A_FIXED_RRF`: `arm_a_serving_bridge.build_arm_a_serving_retriever(text_resolver=…, **options)`.
  - 그 외 값: `ValueError`(readiness는 `ready=False`, mode=degraded).
- `readiness()`: `retrieval_backend` 필드 추가. pins에 `arm_ready=False`(A 경로에서 resolver 미주입)면
  `ready=False`, `error="retrieval_backend not ready: TEXT_RESOLUTION_REQUIRED"`.
- `_error_wire`/meta: 예외에 `code` 속성이 있으면 trace `operations[0].code`·`meta.error_code`에 기록.

## 4/5. text_resolver 전달·fail-closed

`configure(text_resolver=fn)` → `build_arm_a_serving_retriever(text_resolver=fn)` →
`ArmAFrozenResultsRetriever(text_resolver=fn)`. 검증은 adapter가 한다(sha256 대조, 빈 문자열 거부).
브리지는 resolver 미주입 시 search 전에, adapter 오류(`TextResolutionRequiredError`·
`TextIntegrityMismatchError`) 시 그 자리에서 `TextResolutionRequired(code="TEXT_RESOLUTION_REQUIRED")`를
낸다. answer_ex는 계약대로 예외 대신 5-string 오류 wire(`retrieved_context=""`, `meta.cacheable=False`,
`meta.error_code="TEXT_RESOLUTION_REQUIRED"`)를 돌려준다. 빈 본문으로 진행하는 경로는 없다
(`retrieved_chunk_from_arm_a`도 빈 text를 거부).

Gold 101문항 밖의 질문은 adapter의 frozen replay 한계로 `UnknownQuestionForFrozenArmA`
(code `UNKNOWN_QUESTION_FOR_FROZEN_ARM_A`) — 라이브 검색이 아니므로 추측하지 않는다.

## 6. multi-node 보존

`node_indices` 전체가 `RetrievedChunk.metadata.provenance.node_indices`에 남고 `to_dict()`(state
`retrieval`)까지 간다. `node_index`(primary)는 그대로 `RetrievedChunk.node_index`.

## 7/8. 테스트 — `tests/agents/test_arm_a_serving_bridge.py` (11개, 전부 합성)

- 기본 경로 회귀: env 없음/`DART_QA_ARM=B`/`DART_QA_RETRIEVAL_BACKEND=DEFAULT`에서
  `build_serving_retriever`가 종전과 같은 인자로 불리고 A 브리지는 호출되지 않음; 기본 경로 readiness
  pins에 브리지 키 없음(캐시 키 불변). `test_arm_a_adapter.py`의 byte-hash 핀은 answer_api.py만 갱신
  (retriever_adapter/qa_agent/validator/corpus_retriever는 base와 byte 동일 — 실측 sha256).
- 브리지 변환·provenance·readiness pins·fail-closed(resolver 없음/sha 불일치/빈 문자열/미지 질문/
  results_path 없음)·smoke(합성 A 결과 1문항 → `qa_agent.answer_question` state → `answer_ex` 5-string).

실행: `PYTHONPATH=src PYTHONIOENCODING=utf-8 .venv/bin/python -m pytest tests -q` → 883 passed,
7 skipped, 26 errors(원본 corpus 폴더 없는 환경의 contract/parsing fixture — base acb5104에서도 동일).

## 운영 배선(다음 작업자)

```python
from dart_detective import answer_api
answer_api.configure(retrieval_backend="ARM_A_FIXED_RRF",
                     text_resolver=<DocumentIR 기반 resolver>,
                     results_path="<A.results.jsonl>",            # 또는 env ARM_A_RESULTS_PATH
                     gold_questions_path=None)                      # 기본 data/eval/phase1_devtune_gold.v0.1.jsonl
```
resolver는 아직 없다(adapter handoff와 동일). 없으면 `/ready`가 false로 드러나고 모든 답이
TEXT_RESOLUTION_REQUIRED 오류 wire다 — 조용히 D로 바뀌지 않는다.

## 상태

`A_PLUS_QA_LIVE_WIRING_IMPLEMENTED` — 성능·안전성 판정 없음.
