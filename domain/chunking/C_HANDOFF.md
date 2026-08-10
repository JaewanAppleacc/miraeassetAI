# B → C Chunking / Retrieval handoff v0.1

## 전달 범위

B는 누적 설계에 따라 다음을 제공한다.

- 공통 Chunk 계약과 추적 가능한 `source_spans`
- 비교할 청킹 전략 3종과 고정 설정
- A의 대표 DocumentIR 11건으로 생성한 전략별 Chunk JSONL
- 검색 요청·결과 계약
- 청킹 전략에 독립적인 근거 위치를 가진 스모크 질의 5건

C는 이 계약 위에서 BM25를 먼저 구현하고, 같은 결과 형식으로 Dense와
Hybrid/RRF를 연결한다. Reranker는 성능 게이트를 통과한 경우에만 추가한다.

## 전략

| 역할 | config ID | 설명 |
|---|---|---|
| 단순 기준선 | `fixed-token-512-o64.v0.1.0` | 512 token, overlap 64 |
| 비교군 | `section-aware-flat-512-o64.v0.1.0` | 섹션 경계를 보존한 flat chunk |
| 주력 후보 | `doctype-hier-parent-child-table-dual.v0.2.0` | 문서유형별 parent-child, 표 whole/row 이중 표현, 보조행 독립 색인 제외 |

`paragraph`, `table-whole`, `table-row`는 독립 전략이 아니라 주력 전략의
chunk type이다. 정확한 파라미터는 `strategy-configs.v0.1.json`만을 기준으로 한다.

## 산출물 위치

Git 추적 계약:

- `domain/chunking/chunk.schema.json`
- `domain/chunking/strategy-configs.v0.1.json`
- `domain/retrieval/retrieval-request.schema.json`
- `domain/retrieval/retrieval-result.schema.json`
- `domain/retrieval/retrieval-evaluation-seed.v0.1.jsonl`

로컬 전달 패키지:

- `work/chunk-handoff/chunk-handoff-manifest.json`
- `work/chunk-handoff/*.jsonl`
- 같은 폴더에 복사된 관련 schema/config

`work/`는 Git에서 제외되므로 C에게 폴더를 별도 전달하거나 아래 명령으로
동일 산출물을 재생성해야 한다.

## 재생성

```bash
node scripts/generate-representative-chunks.mjs \
  --representative work/a-parser-repo/data/artifacts/handoff/representative_documents.jsonl \
  --documents work/domain-seed/documents.jsonl \
  --a-handoff-manifest work/a-parser-repo/data/artifacts/handoff/a_handoff_manifest.json \
  --output-dir work/chunk-handoff \
  --target-corpus-snapshot-id corpus_04750795e1a2d5c3 \
  --created-at 2026-08-04T05:30:00.000Z
```

```bash
npm run schema:validate
npm run test:domain
node scripts/validate-chunk-handoff.mjs \
  --chunk-dir work/chunk-handoff \
  --evaluation-seed domain/retrieval/retrieval-evaluation-seed.v0.1.jsonl
```

## 대표 표본 결과

| 전략 | 전체 Chunk | 검색 대상 Chunk | 근거 위치 보존 |
|---|---:|---:|---:|
| fixed | 2,081 | 2,068 | 5/5 |
| section-aware flat | 2,357 | 2,344 | 5/5 |
| hierarchical parent-child | 12,294 | 7,222 | 5/5 |

주력 후보는 아직 최종 승자가 아니다. 대표 표본에서도 청크 수가 기준선보다
크므로, 전체 임베딩 전에 반복 섹션 fingerprint 기반 대표화와 chunk-budget
보고서를 통과해야 한다. 품질 개선 없이 청크 수·지연만 증가하면 채택하지 않는다.

## 전체 corpus dry-run 결과

전수 4,204건의 실제 chunker dry-run을 완료했다. 상세 판정은
`FULL_CORPUS_BUDGET_DECISION.md`와 전달 패키지의
`full-corpus-chunk-budget.json`을 참조한다.

- Fixed 검색 청크: 442,549
- Section-aware Flat: 516,806
- Hierarchical v0.2: 1,516,186
- 세 전략의 전체 embed token은 약 2.39~2.42억으로 비슷하지만 Hierarchical은
  호출·인덱스 행이 기준선의 3.43배다.
- 따라서 전량 임베딩 전에 BM25로 청킹 후보를 줄이는 것이 필수다.

## 구현 경계

- `raw_text`: 답변 인용 근거
- `embed_text`: lexical/dense 색인 입력
- `document_id + source_spans`: 청킹 전략과 무관한 근본 Gold
- `chunk_id`: 전략별 파생 ID
- fallback 청크: 감사 목적으로만 생성하며 검색·Fact 승격 금지
- `periodic_20260619000667`, `periodic_20240514001522`: PDF viewer가 비어 있어 청크 생성 금지
- source ID/locator는 결정론적으로 설계됐지만 전수 2회 재실행 hash 비교는 아직 미실시
- 스모크 질의 5건: 인터페이스 확인용 초안이며 공식 DEV/HOLDOUT Gold가 아님
- BM25/Dense/RRF의 실제 색인, 점수, latency 측정은 C의 실행기 책임

Snapshot 해석은 다음으로 고정한다.

- 검색 요청·결과·인덱스의 `corpus_snapshot_id`: `corpus_04750795e1a2d5c3`
- 원천 A DocumentIR의 `source_corpus_snapshot_id`: `snap_7484a10220422056`
- source snapshot은 각 Chunk의 `source_document_ir`와 index manifest provenance에
  보존하고 검색 결과의 주 snapshot ID를 대체하지 않는다.

첫 BM25 연결 시험은 `top_k=10`, Recall@1/5/10, MRR@10으로 실행한다. 다만 현재
5문항은 인터페이스·근거 보존 smoke set이며 모델 선택용 Gold가 아니다. 세 전략이
동일 설정에서 끝까지 실행되는지 확인한 뒤, 확정 DEV-TUNE에서 채택 판단을 한다.

Smoke metric의 relevant 판정은 단순히 `expected_document_ids`가 같은 경우가 아니라,
반환 Chunk의 `source_spans`가 질의의 `required_evidence_spans`와 겹치는 경우로 한다.

- Evidence Span Recall@1/5/10: 필요한 span 중 top-k Chunk가 덮은 비율
- MRR@10: 첫 evidence-overlap Chunk 순위의 reciprocal rank
- Document Recall@k: 진단용 보조 지표로만 기록

같은 문서의 무관한 Chunk는 relevant로 채점하지 않는다.

동일 A/B 라운드에서는 corpus, parser, chunk config, Fact Coverage snapshot을
고정해야 한다. 검색 결과는 단일 score뿐 아니라 원래의 component score와 적용
filter를 모두 보존한다.
