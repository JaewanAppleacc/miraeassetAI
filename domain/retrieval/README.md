# Retrieval handoff v0.2

B는 질문, metadata filter, chunk-independent evidence span을 제공한다. C는 같은
요청·결과 형식으로 BM25, Dense, Hybrid/RRF, 조건부 Reranker를 실행한다.

`retrieval-evaluation-seed.v0.1.jsonl`의 5문항은 BM25 smoke test용 초안이다.
아직 `DRAFT_FOR_HUMAN_REVIEW`이며 공식 DEV/HOLDOUT Gold가 아니다.

## raw_text는 검색 context다, citation 원문 보장이 아니다

`raw_text`는 매치된 Chunk의 `Chunk.text`를 변형 없이 반환한다. Chunk 생성 시
만드는 `embed_text`(정규화·확장된 색인 입력)는 인덱싱 전용이며 결과에 절대
반환하지 않는다 — 여기까지는 항상 참이다.

하지만 "Chunk 기준 verbatim"이 "원문 기준 verbatim"을 의미하지는 않는다. C3
`TABLE_ROW` Chunk처럼 `Chunk.text` 자체가 원문 표 셀을 deterministic하게
linearize한 파생 텍스트이거나(`영업이익 | 500 | 백만원` 같은 셀들을 이어붙인
문자열), 앞뒤로 section 제목 같은 구조적 맥락을 합성해 넣은 경우가 있을 수
있다. 이 경우 `raw_text`는 HCX context로는 안전하지만 원문 직접 인용은
아니다. `results[].text_provenance`가 이 관계를 명시한다.

- `SOURCE_VERBATIM`: `raw_text`가 원문 문자열 그대로다.
- `DETERMINISTIC_LINEARIZATION`: `raw_text`가 구조화 원문(표 등)을 재현 가능한
  규칙으로 렌더링한 것이며 원문 그대로의 인용이 아니다.
- `STRUCTURAL_CONTEXT`: `raw_text`에 합성된 맥락(제목, parent 요약 등)이 섞여
  있다.

`text_provenance` 값과 무관하게 **실제 citation의 권위 있는 위치는 항상
`source_spans`**다. `results[].citation_authority`는 `SOURCE_SPANS`로 고정되어
있으며, consumer는 `raw_text`를 인용 근거로 직접 노출하지 말고 `source_spans`
(file_id/rel_path/node_id/row/col)로 원문 위치를 렌더링해야 한다. 서로 다른
점수 체계를 비교할 수 있도록 단일 `score`와 함께 `component_scores`를 반드시
보존한다.

## Hybrid index snapshot composite manifest

`index_snapshot_id`는 request/result에서는 여전히 불투명한 문자열이지만, 그
문자열이 가리키는 실체는 `index-snapshot-manifest.schema.json`으로 고정한다.
Hybrid 인덱스는 LEXICAL/DENSE/RERANKER 컴포넌트가 각자 다른 backend·버전·
embedding 차원·정규화를 가질 수 있으므로 단일 버전 문자열로는 재현성을 보장할
수 없다. 이 manifest가 그 조합을 명시적으로 기록하는 단일 출처다. `corpus_snapshots`,
`fact_coverage_snapshots`와 같은 패턴으로, request/result는 ID만 참조하고 실제
구성은 이 manifest에서 조회한다.

## Request/Result 런타임 invariant

JSON Schema는 필드 모양만 검사한다. 다음은 `domain/contracts.mjs`의
`validateRetrievalResult`, `validateRetrievalRequestResultPair`,
`validateIndexSnapshotManifest`가 추가로 강제하는 규칙이다.

- `results[].score_type`과 `component_scores`의 null 여부는 `retrieval_method`에
  종속된다. 예: `HYBRID_RRF`는 `score_type=RRF`이며 `bm25`·`dense`·`rrf`가 모두
  non-null이어야 한다(블렌드의 상류 입력을 감사할 수 있도록).
- `rank`는 1부터 연속이며 중복이 없고, `score`는 rank 순서대로 비증가해야 한다.
- `results.length`는 `top_k`를 넘지 않는다.
- 같은 질의의 request/result 쌍은 `corpus_snapshot_id`, `chunking_config_id`,
  `index_snapshot_id`, `top_k`가 동일해야 하며 `applied_filters`는
  `metadata_filters`와 정확히 일치해야 한다(느슨하게 적용하지 않는다).
- `parent_chunk_id`는 자기 자신(`chunk_id`)을 가리킬 수 없다.
- Index snapshot manifest는 `component_role`을 중복 등록할 수 없고, `DENSE`
  컴포넌트는 `embedding_model_id`가 있어야 하며, `hybrid_combination`이 있으면
  `LEXICAL`과 `DENSE`가 모두 있어야 한다.

## Child 적중과 Parent context

C1~C3처럼 parent-child 청킹을 쓰는 전략에서는 검색이 child(예: `TABLE_ROW`,
문단 하위 조각)를 맞히더라도 답변에는 parent 맥락이 필요할 수 있다.
`results[].chunk_type`과 `results[].parent_chunk_id`가 이를 표현한다.
결과 payload에 parent 텍스트를 통째로 복제하지 않는다 — `parent_chunk_id`는
참조일 뿐이며, 실제 parent 텍스트는 C의 Chunk Store에서 그 ID로 조회한다.
`parent_chunk_id`가 `null`이면 해당 chunk는 최상위(parent 없음)다.

## Evaluation seed 상태

5개 seed는 `gold_status=DRAFT_FOR_HUMAN_REVIEW`로 유지한다. 사람 검수 전에는
공식 DEV/HOLDOUT Gold로 승격하지 않는다.

## 버전 정책: additive upgrade, 엄밀한 backward-compat 아님

`retrieval-request.schema.json`은 변경하지 않았다(여전히 `0.1.0`).
`retrieval-result.schema.json`은 `chunk_type`/`parent_chunk_id`/
`text_provenance`/`citation_authority`를 새 필수 필드로 추가하며 `0.2.0`으로
승격했다. 기존 v0.1 Result 페이로드는 v0.2 스키마를 통과하지 못한다 — 이건
"backward-compatible한 minor 변경"이 아니라 필드가 늘어난 **versioned additive
upgrade**다.

C가 아직 v0.1 Result를 실제로 생성·소비한 적이 없으므로(현재 `work/`
아래에 있는 건 chunk 생성 파이프라인이 참고용으로 복사해 둔 스키마 사본일
뿐, 실제 Result 페이로드가 아니다) 호환 Adapter는 만들지 않았다. 나중에 실제
v0.1 consumer가 생기면 `retrieval-result.v0.1.schema.json`을 별도 보존하고
Loader에 v0.1→v0.2 변환을 추가하는 것을 검토한다. 그 전까지 C 구현은 v0.2를
기준으로 시작하면 된다.

