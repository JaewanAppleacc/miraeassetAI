# Turn P10 — Controlled 3-way chunking comparison handoff

이 문서는 Turn P10(`codex/agent-chunking-comparison-v01`)의 산출물 요약이다.
숫자와 판정 상세는 `work/p10-chunking-comparison/*.json`(로컬 생성물, git 제외)을
참조한다. 이 문서는 그 결과의 요약이며, 원본 수치의 대체가 아니다.

## 범위 고지 (반드시 먼저 읽을 것)

이 worktree에는 전체 4,204건 corpus 원문이 materialize되어 있지 않다
(`domain/adapters/a-document-ir-reader.mjs`의 자체 주석 참조: "the full corpus
... was never materialized in this repo"). 실행 가능한 실제 표본은
`domain/releases/bundles/seed-release-v0.20-r3.candidate`의 canonical
DocumentIR(base 54건 + delta 14건 = 68건) 중, `VERIFIED_FACT`로 corp_code가
resolve되는 **45개 문서**로 제한했다(23건은 corp_code를 실제 데이터로 resolve할
수 없어 제외 — placeholder 값을 부여하지 않음).

이미 완료된 전체 corpus(4,204건) dry-run 수치는 `domain/chunking/
FULL_CORPUS_BUDGET_DECISION.md` / `C_HANDOFF.md`를 인용하며, 이번 Turn에서
재실행하지 않았다.

## A. 세 전략의 정확한 계약

| 전략 | chunking_config_id | 근거 |
|---|---|---|
| FIXED_512_OVERLAP | `fixed-token-512-o64.v0.1.0` | `domain/chunking/strategy-configs.v0.1.json`에서 그대로 재사용(수정 없음) |
| SECTION_AWARE_FLAT | `section-aware-flat-512-o64.v0.1.0` | 위와 동일하게 그대로 재사용 |
| DOCUMENT_TYPE_HIERARCHICAL_PARENT_CHILD_TABLE_DUAL | `doctype-hier-parent-child-table-dual.v0.2.0-p10-parent1536` | 기존 frozen PRIMARY 설정(parent_max_tokens=1024)을 **직접 수정하지 않고**, `parent_max_tokens`만 1536으로 override한 P10 전용 변형. 나머지 파라미터(child 384/overlap 48/table_row 256·8행)는 동일. `experiment_id: p10-chunking-comparison-v01`로 기록됨 (`domain/agent-comparison/chunking-comparison/p10-manifest.mjs`). |

세 전략 모두 동일한 real chunker(`domain/chunking/chunker.mjs`, 미수정)를 통과한다.
이 worktree의 실제 DocumentIR 표본은 B의 canonical 형식(`blocks[]`,
`header_rows`/`body_rows` 분리)이며 chunker가 요구하는 형식(`nodes[]`,
`normalized_rows`+`header_row_indices`)과 다르다. 이 gap을 메우기 위해 새
adapter(`b-canonical-to-chunker-input.mjs`)를 작성했다. 표 행은
`header_rows ++ body_rows`(header-first) 순서로 재구성하며, 각 그룹 내부의 셀
값은 절대 변경하지 않는다 — 이 재구성은 문서화된 결정론적 변환이지 원문 조작이
아니다. `doc_subtype`/`report_name`/`filer_name`/`is_correction`은 이 번들에서
실제로 resolve할 수 없어 `null`/보수적 기본값(`false`, 미검증으로 표기)으로
남겼다 — 임의로 만들어내지 않았다.

## B. E1 corpus-only 통계 (45개 실제 문서, 3전략 각각)

전체 JSON: `work/p10-chunking-comparison/corpus-only-stats.v01.json`

| 지표 | Fixed | Section-Flat | Hierarchical(P10, parent=1536) |
|---|---:|---:|---:|
| 전체 chunk | 10,541 | 11,548 | 49,283 |
| 검색 대상 chunk | 10,541 | 11,548 | 32,560 |
| unique content_sha256 | 10,539 | 11,279 | 35,942 |
| exact 중복률 | 0.019% | 2.33% | 27.07% |
| chunk/문서 p50/p90/p99/max | 3/770/2198/2198 | 4/841/2281/2281 | 14/3692/8756/8756 |
| token p50/p95/max | 512/512/512 | 512/512/512 | 127/726/1536 |
| chunk_type rollup (table/title_or_event/paragraph/fallback) | 0/0/10541/0 | 0/0/11548/0 | 42884/2237/4162/0 |
| parent 수 / child 수 / 평균 fan-out | 0/0/– | 0/0/– | 2,295/46,988/20.47 |
| node-level source coverage | 99.97% | 99.97% | 99.97% |
| locator/provenance 위반 | 0 | 0 | 0 |
| 예상 embedding 호출 (unique embed_text) | 10,539 | 11,445 | 30,210 |
| 예상 vector storage (BGE-M3, 1024×4B) | 41.2 MiB | 44.7 MiB | 118.0 MiB |
| build time | 2,554 ms | 1,689 ms | 3,746 ms |
| peak RSS | 1.29 GiB | 1.64 GiB | 1.68 GiB |
| 결정론적 재빌드(2회 rerun sha 일치) | ✅ | ✅ | ✅ |

주의: N=45로 작아 p90/p99가 사실상 최대 1건(가장 큰 문서)에 좌우된다 —
전체 corpus 비율(4,204건 기준 FULL_CORPUS_BUDGET_DECISION.md의 hierarchical
3.43배)과 방향은 일치하지만, 이 표의 절대 percentile은 소표본 아티팩트로 해석
주의가 필요하다.

## C. E2 bounded retrieval smoke

전체 JSON: `work/p10-chunking-comparison/bounded-retrieval-smoke.v01.json`
(3전략 모두 완료 후 생성됨; 실행 중에는 `bounded-retrieval-smoke.IN_PROGRESS.v01.json`에
전략별 부분 결과가 누적되어 kill/timeout 발생 시에도 이미 끝난 전략의 결과는
보존된다 — 실제로 이 실행 중간에 일시적 OS 파일권한 장애가 있었으나 이 체크포인트
덕분에 전략 1(fixed) 결과 유실 없이 재개했다).

- 질의셋: v0.20-r3 VERIFIED Evidence/Fact 98건(`domain/agent-comparison/
  embedding-calibration/dataset.mjs`, 미수정). sha256 재계산값이 pinned
  `EXPECTED_DATASET_SHA256`와 일치함을 확인 후에만 진행(fail-closed).
- bounded 문서 = 98개 질의의 source_document_id ∩ resolvable 45개 문서 = 45개
  전체(자기 일치).
- corp_code metadata filter를 top_k 이전에 적용, 그 다음 BM25 top-20 후보를
  생성, 후보의 embed_text만 실제 BGE-M3(로컬, Turn P9의 task-owned venv/모델
  캐시 재사용, 재다운로드 없음)로 임베딩 → cosine dense rerank → RRF.
- 실제 임베딩 호출은 in-memory content-addressed 캐시로 중복 제거(같은
  embed_text가 여러 질의의 후보로 재등장해도 1회만 호출).
- 이 결과는 연결/회귀 확인용이며 자기검색 성격이 있다(같은 98건이 이 worktree의
  DocumentIR 표본 자체를 선별하는 데도 쓰였다). **최종 청킹 품질 판정이나
  final_selection으로 사용하지 않는다.**

### 결과 (98/98 질의 모두 평가됨, 3전략 동일 조건 확인됨)

manifest 일치 확인: 세 전략 모두 `dataset_item_count=98`,
`dataset_sha256=9848b30c8704b647eeab6820cd0f89473f2d659da9aae72c5a4eb9f58f0b28b0`(동일),
`bounded_document_count=45`(동일), `bm25_candidate_funnel_size_per_query=20`(동일),
`embedding_candidate`=BGE-M3 동일 revision, `top_k_values_reference=[1,5,10,20]`(동일).
`queries_evaluated=98`, `queries_skipped_no_candidates=0` — 세 전략 모두.

| 지표 | Fixed | Section-Flat | Hierarchical(P10) |
|---|---:|---:|---:|
| BM25 Recall@1/5/10/20 | 0.602/0.847/0.929/0.969 | 0.531/0.847/0.939/0.969 | 0.561/0.929/0.959/1.000 |
| BM25 MRR | 0.722 | 0.678 | 0.716 |
| Dense Recall@1/5/10/20 | 0.286/0.531/0.724/0.969 | 0.265/0.520/0.704/0.969 | 0.265/0.469/0.643/1.000 |
| Dense MRR | 0.406 | 0.404 | 0.387 |
| RRF Recall@1/5/10/20 | 0.408/0.735/0.867/0.969 | 0.367/0.745/0.878/0.969 | 0.398/0.745/0.908/1.000 |
| RRF MRR | 0.563 | 0.541 | 0.565 |
| corp_code filter accuracy | 1.0 | 1.0 | 1.0 |
| BM25 latency p50/p95 (ms) | 92/1,199 | 77/1,130 | 91/773 |
| Dense latency p50/p95 (ms, 쿼리당 embedding round-trip 포함) | 7,011/46,439 | 13,849/62,605 | 3,616/50,937 |
| 실제 embedding HTTP 호출(캐시 적용 후) | 938 | 966 | 1,101 |
| smoke wall time | 19.5분 | 34.3분 | 18.1분 |

**해석상 반드시 지킬 제약:**

- Dense가 BM25보다 전반적으로 낮은 이유는, 질의문 자체가 원문에서 그대로 발췌한
  quoted_text이기 때문에 어휘 일치(BM25)가 구조적으로 유리한 self-selection
  스모크이기 때문이다 — 이는 BGE-M3의 실제 dense 품질 결론이 아니다.
- Hierarchical이 세 전략 중 RRF Recall@10/MRR에서 근소하게 앞섰지만
  (0.908 vs 0.878/0.867), 이는 최종 청킹 품질 판정이 아니다: 같은 98건이 이
  worktree DocumentIR 표본 자체를 선별하는 데도 쓰였고(self-selection), N=45
  문서·98 질의로 표본이 작으며, Gold가 아닌 self-supervised 판정(evidence
  source_node_id 겹침, 일부 문서-수준 fallback)이다.
- **최종 청킹 winner를 선언하지 않는다.** Gold 207 GREEN 이후 DEV_TUNE/DEV_CHECK
  결과로만 provisional selection을 낼 수 있다(§G).
- `FULL_CORPUS_CHUNKING_VALIDATED`, `FINAL_CHUNKING_SELECTED` 등의 상태를 어디에도
  기록하지 않는다 — 이 문서와 JSON report 전체에 해당 문자열이 없음을 확인함.

## D. Gold 207 통합 게이트

`scripts/p10-gold-gate-check.mjs` (read-only, Gold 질문/정답 파일을 절대 열지
않음 — 파일 존재/스크립트 등록 여부만 확인):

- `tests/gold-300-owner-review-v0.2-v04201.test.mjs`: 이 저장소에 존재하지 않음
- AUTHOR_A Gold v0.2 120/120 validator: 이 저장소에 존재하지 않음 (AUTHOR_A/
  AUTHOR_B는 `domain/evaluation/anchor-allocation-builder.mjs`의 저자-배정
  role로만 존재, Gold pass/fail validator 아님)
- AUTHOR_B 87/87: 존재하지 않음
- "Gold 207" 통합 validator: 존재하지 않음
- canonical Owner decision SHA pin: 존재하지 않음
- N4.24 / `BLOCKED_AUTHOR_A_SCHEMA_INCOMPATIBLE`: 이 저장소에 해당 milestone
  자체가 존재하지 않음

→ **gate_status: RED**. `CLAUDE.md` §14("아직 완료되지 않음")도 확정 Seed Gold
20~30개와 300건 DEV/DEV_CHECK/HOLDOUT split이 아직 완료되지 않았음을 독립적으로
확인해준다.

**결론: `CHUNKING_COMPARISON_READY_PENDING_VALIDATED_DEV_GOLD`.**
DEV_TUNE/DEV_CHECK/HOLDOUT 파일은 이번 Turn에서 한 번도 열지 않았다
(`tests/p10-gold-gate-and-safety.test.mjs`가 정적으로 재확인). 최종 청킹
winner는 선정하지 않는다.

## E. 다음 단계

Gold 207/DEV_TUNE 101/DEV_CHECK 47이 검증된 이후에만:

1. 이 Turn의 P10_STRATEGIES/P10_EMBEDDING_CANDIDATE 매니페스트를 그대로 재사용해
   DEV_TUNE 101건으로 파라미터를 재검토한다(고정 후 DEV_CHECK 47건은 정확히
   1회만 사용).
2. 승자 청킹 1개가 정해지면, 동일 청킹으로 KURE-v1/BGE-M3/PIXIE-Rune 실제 DEV
   비교를 수행한다(§19 순서).
