# Turn P10.3.2 — Corrected Locator 기반 전체 표 문항 재감사 Handoff

## A. Worktree / Branch / Base

```
worktree: /Users/jaewan/Documents/Codex/worktrees/agent-table-full-population-audit-v01
branch:   codex/agent-table-full-population-audit-v01
base:     3962975adb2b65946650f8543c76575d4593a509
          (= origin/codex/agent-table-locator-audit-v01, 확인됨)
```

입력 pin: P10.2 `14adb49`, P10.3 `dacf1aa402125d46e62892e97aadc3d51d10141b`,
P10.3.1 `3962975adb2b65946650f8543c76575d4593a509`, DEV_TUNE Gold 101행,
sha256 `7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b`
(fetch 후 실제 계산값과 완전 일치).

이번 Turn에서는 Adaptive Chunking을 구현하지 않았고 새 임베딩도 수행하지 않았다
(static test로 강제). 실제 청킹(`chunker.mjs`)은 Stage 3에서만 명시적으로
허용되어 실행됐다(count-only가 아닌 실제 실행 — 이번 Turn의 브리핑이 명시적으로
허용).

## B. Corrected table item/source 수

Stage 1~2가 DEV_TUNE 101건 전체를 처음부터 재검사한 결과:

```
전체 평가 항목:          101
table item:                92   (91.1%)
non-table item:             9
고유 table source:        339
전체 table evidence locator 수: 339
```

P10.3.1이 예상한 92 items / 339 sources와 **정확히 일치**한다(억지로 맞춘 것이
아니라 별도의, 확장된 v2 resolver로 처음부터 다시 계산해서 나온 값이며, 테스트로
고정했다).

## C. Locator 형식별 수

```
CELL_QUALIFIED   (docId/relPath#node=N&row=R&col=C):  260 (75.4%)
NODE_ONLY_HASH   (docId/relPath#node=N):                 6 ( 1.7%)
NODE_ONLY_COLON  (docId::relPath::nodeId):              79 (22.9%)
ROW_QUALIFIED    (docId/relPath#node=N&row=R):           0
UNRECOGNIZED:                                            0
```

이번 Turn이 지원 대상으로 명시한 나머지 형식(percent-encoding, `canonical_
source_locator`, `extensions.evidence_verification.{source_node_id,row,column}`,
row-only locator, 별도 `node_id` 필드)은 **345개 source·101개 item의 extensions
객체 전수 조사 결과 모두 실제 데이터에 존재하지 않는다** — 코드는 이들을 모두
실제로 구현했지만(향후 호환성 및 fail-closed 정확성을 위해), 이번 Gold
release에서는 한 번도 발동하지 않는다. 이는 생략이 아니라 명시적으로 검증되고
기록된 부재다(`corrected-table-locator-resolution-report.v0.2.json`의
`formats_verified_absent_from_this_gold_release`).

## D. 기존 49/75 누락 원인

P10.3의 resolver(`table-evidence-resolver.mjs`의 `findNodeById`)는
`source_locator` 전체 문자열을 실제 DocumentIR `node_id`와 정확히 일치시키는
방식만 사용했다 — 이는 `NODE_ONLY_COLON`(79건)만 만족시킨다. 가장 권위 있는
`CELL_QUALIFIED`(260건, 75.4%)와 `NODE_ONLY_HASH`(6건)는 항상 `null`을 반환해
"non-table"로 조용히 오분류됐다. P10.3.1이 이를 발견했고, 이번 Turn은 그 발견을
101건 전체에 대해 처음부터 재검증해 정확히 일치하는 결과(92/339)를 확인했다.

## E. Fixed/Section 전체 구조 보존율 (92 items, 879 cell-check)

```
                          Fixed-512+o64        Section-Aware-Flat
gold_cell_retrievable    871/879 (99.1%)       871/879 (99.1%)
row_header_preserved     825/833 (99.0%)       825/833 (99.0%)
column/period_header     384/466 (82.4%)       429/466 (92.1%)
unit_preserved             31/76 (40.8%)         29/76 (38.2%)
table_title/section_ctx  429/871 (49.3%)       594/871 (68.2%)
ambiguous_numeric_col.   150/704 (21.3%)       150/704 (21.3%)  <- 청킹과 무관
```

period_header과 column_header, table_title과 section_context는 이 corpus/
chunker에서 **동일한 측정 신호**로 수렴한다: `node.period_text`/`unit_text`는
파서가 채운 적이 없고(P10.3에서 이미 실측), Fixed/Section-Flat 청크는
Hierarchical 전략과 달리 별도의 `table_metadata.caption` 필드를 전혀 갖지 않는다
— 두 쌍 모두 같은 code-computed 체크(header_row_indices 공존, `chunk.section_
path` 비어있지 않음)로 귀결되며, 인위적으로 구분을 만들지 않고 이를 명시적으로
공개했다.

row_header_preserved가 이제 100% 미만(99.0%, 8건 위반)인 것은 P10.3의 원래
45-item 표본에서는 0건이었던 것과 대비된다 — 더 큰 표본이 드러낸 실제 현상이다.

## F. Attribution별 critical violation

```
                          Fixed                 Section
LOCATOR_RESOLVES_TO_WRONG_CELL:  55                42
ROW_HEADER_VALUE_MISMATCH:        8                 8
PERIOD_COLUMN_VALUE_MISMATCH:    82                37
UNIT_MISSING_OR_MISCOMBINED:     45                47
MULTI_CELL_CONTEXT_INCOMPLETE:    7                 7
LOCATOR_PROVENANCE_LOST:          0                 0
------------------------------------------------------
TOTAL:                          197               141

attribution:
  CHUNKING_ATTRIBUTABLE:         197 (100%)        141 (100%)
  SOURCE_PARSE_LIMITATION / GOLD_LOCATOR_AMBIGUOUS /
  LOCATOR_PROVENANCE_CONFLICT / RESOLVER_IMPLEMENTATION_BUG:  0
```

전체 92-item population에서도 **100%가 CHUNKING_ATTRIBUTABLE**이다 — Gold
ambiguity, locator 충돌, resolver bug 어느 것도 이 92개 항목 안에서는 한 건도
발견되지 않았다. `LOCATOR_RESOLVES_TO_WRONG_CELL`은 P10.3의 원래 정의
(`locator_misrepresentation`: 어떤 chunk라도 해당 row를 주장하지만 raw_text에
전체 텍스트가 없는 경우)를 그대로 재사용했다 — 더 엄격한 정의(`!gold_cell_
retrievable`)로 바꿨다가, 두 정의가 다른 숫자를 낸다는 것을 발견하고 P10.3과의
공정한 비교를 위해 원래 정의로 되돌렸다(이 과정 자체가 이번 Turn의 검증 과정에서
실제로 일어났다).

`LOCATOR_PROVENANCE_LOST`(신규 violation 유형, "어떤 청크도 이 row를 주장하지
않음")는 **0건**이다 — chunker.mjs의 토큰 윈도잉이 segment의 span을 완전히
누락시키는 경우가 실제로 없다는 것을 코드로 확인한 실측 결과다(윈도우가 segment와
조금이라도 겹치면 항상 그 segment를 포함시키는 구현이기 때문).

## G. 4개 parse-limited source 판정

```
final_status_distribution: { "PARSE_RECOVERY_REQUIRED": 4 }
```

4건 모두 P10.3.1과 동일한 4건이며(NODE_ONLY_COLON scheme, CELL_QUALIFIED 권위
없음), 모두 `actual_col_counts`가 행마다 불규칙(예: `[4,4,4,3,3]`)하고, 최적
매칭 행의 단어가 evidence_span 안에 100% 커버되지만(word coverage ≥0.999)
contiguous substring으로는 매칭되지 않는다(파서의 비정형 열 구조 때문). row/col
없는 locator라 CELL_QUALIFIED 권위로 구제되지 않는다(`row_column_recoverable_
without_parser_fix: false`). 파서나 Gold를 수정하지 않았고, 임의 row/col을
강제하지 않았다 — 4건 모두 `PARSE_RECOVERY_REQUIRED`로 명시했다(파서의 불규칙
열-개수 처리를 고쳐야 재해석 가능).

## H. Corrected table Recall@10 (P10.2 기존 결과만 사용, 새 embedding 0건)

92-item population 기준:

```
kure_v1    x Fixed 0.9000  x Section 0.8630  (delta -0.0370)
bge_m3     x Fixed 0.8828  x Section 0.8630  (delta -0.0198)
pixie_rune x Fixed 0.9036  x Section 0.8793  (delta -0.0243)
```

3개 모델 모두 Fixed가 Section보다 table Recall@10에서 우세하다 — P10.3(49-item)
때와 같은 방향이 92-item population에서도 유지된다. cell-level/row-header-
aware/unit-aware/period-column-aware Recall@10, boilerplate FP rate, 검색-순위
기반 ambiguous numeric collision rate는 `NOT_COMPUTABLE_WITHOUT_RAW_RANKINGS`로
명시했다(P10.2가 원본 랭킹 리스트를 저장하지 않았고, 이를 복구하려면 새
embedding이 필요하므로).

## I. 기존 P10.3 대비 변경 수치

```
                     P10.3 (45-item, 75-source)   P10.3.2 (92-item, 339-source)
Fixed critical viol.            162                          197   (+35, +21.6%)
Section critical viol.          108                          141   (+33, +30.6%)
table item count                 49                           92   (+43)
table-kind source count          75                          339   (+264)
```

Fixed/Section 비율은 162/108=1.500 → 197/141=1.397로 거의 동일한 방향성을
유지한다 — 표본이 2배 가까이 커졌지만 "Fixed가 구조적으로 더 위험하다"는 결론은
바뀌지 않았다.

## J. Superseded artifact 목록

`p10-3-supersession-manifest.v0.1.json` 참조. 다음은 삭제·수정하지 않고 그대로
보존했다(git status로 미수정 확인):

```
work/p10.3-table-diagnostic/table-item-inventory.v0.1.json
work/p10.3-table-diagnostic/table-structure-preservation-report.v0.1.json
work/p10.3-table-diagnostic/table-retrieval-metrics-by-combination.v0.1.json
work/p10.3-table-diagnostic/table-chunking-final-verdict.v0.1.json
work/p10.3.1-table-locator-audit/table-locator-root-cause-audit.v0.1.json
```

## K. 최종 판정

```
status: ADAPTIVE_TABLE_CHUNKING_CONFIRMED_FULL_POPULATION
```

근거(코드 계산, `table-full-population-verdict-rule.mjs`):

1. table item count 92 ≥ 15 최소 표본, determinism 확인됨.
2. Fixed의 chunking-attributable violation 중 metadata-only 비율 0% < 70% —
   `EXISTING_CHUNKER_METADATA_FIX_SUFFICIENT` 아님.
3. Fixed(197)·Section(141) 모두 교정 후에도 실제 chunking-attributable
   violation을 유지(0 초과) — Section도 완전한 대안 아님.
4. parse-limited source 비율 4/339 = 1.18% < 5% materiality threshold —
   `ADAPTIVE_DIRECTION_CONFIRMED_PARSE_RECOVERY_REQUIRED`가 아니라 바로 CONFIRMED.

## L. P10.4 진행 가능 여부

```
p10_4_implementation_eligible:     true
parse_recovery_blocking:           false
unresolved_gold_locator_blocking:  true   (4개 PARSE_RECOVERY_REQUIRED source 존재)
required_exclusions:               ["4 PARSE_RECOVERY_REQUIRED source(s) excluded
                                     from table-aware chunk scoring until parser
                                     recovery"]
```

`adaptive-table-chunking-input-contract.v0.2.json` 작성됨(설계안만, 구현 없음).
필수 필드 13개(document_id, node_id, row, column, row_header, column_header,
period_header, unit, table_title, section_title, cell_value,
canonical_source_locator, inherited_context_provenance), 4종 chunk
(ATOMIC_TABLE_ROW, TABLE_ROW_WITH_HEADERS, MULTI_ROW_CONTEXT,
TABLE_SUMMARY_CONTEXT), 5개 불변식 명시.

## M. 안전 경계 준수 증거

- DEV_CHECK/HOLDOUT: 미접근(static test).
- 새 embedding 호출/모델 로드·다운로드/모델 서버 실행/HCX 호출: 0건(static test +
  Stage 5 출력의 `new_embedding_calls: 0`/`new_model_servers_spawned: 0`).
- 실제 청킹: Stage 3에서만 실행(이번 Turn이 명시적으로 허용), 다른 스크립트는
  `chunkDocument` 호출 없음(static test로 강제).
- P10.2/P10.3/P10.3.1 파일 수정 금지: git status로 3개 결과 디렉터리 전부
  미수정 확인 + static test.
- Gold 질문·정답·evidence span·셀 원문: 모든 산출 JSON에서 부재 확인(static
  test + 정규식 스캔).
- production/PostgreSQL: 변경 없음.

## N. 검증

```
npm run test:p10.3.2-table-full-population-audit  -> 41/41 pass
npm run schema:validate                            -> PASS, validated_pairs: 28
npm run typecheck                                  -> clean
git diff --check                                   -> clean
```

실행하지 않음: `npm run verify:contracts`, 전체 `test:domain`, headless Chrome,
PostgreSQL 통합 테스트, HCX 테스트, 전체 build.

## O. 산출물

```
work/p10.3.2-table-full-population-audit/corrected-table-item-inventory.v0.2.json
work/p10.3.2-table-full-population-audit/corrected-table-locator-resolution-report.v0.2.json
work/p10.3.2-table-full-population-audit/full-population-table-structure-report.v0.2.json
work/p10.3.2-table-full-population-audit/full-population-critical-violations.v0.2.json
work/p10.3.2-table-full-population-audit/parse-limited-source-disposition.v0.1.json
work/p10.3.2-table-full-population-audit/corrected-table-retrieval-metrics.v0.2.json
work/p10.3.2-table-full-population-audit/p10-3-supersession-manifest.v0.1.json
work/p10.3.2-table-full-population-audit/table-full-population-final-verdict.v0.2.json
work/p10.3.2-table-full-population-audit/adaptive-table-chunking-input-contract.v0.2.json
```

Gold 질문·정답·evidence span·셀 원문은 어디에도 기록하지 않았다.

## P. Commit / Push

커밋/push SHA는 최종 사용자 보고에 기록한다(이 문서는 커밋 전 스냅샷).
