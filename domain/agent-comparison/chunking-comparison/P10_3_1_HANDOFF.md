# Turn P10.3.1 — Table Locator 및 Critical Violation 독립 감사 Handoff

## A. Worktree / Branch / Base

```
worktree: /Users/jaewan/Documents/Codex/worktrees/agent-table-locator-audit-v01
branch:   codex/agent-table-locator-audit-v01
base:     dacf1aa402125d46e62892e97aadc3d51d10141b
          (= origin/codex/agent-table-chunking-diagnostic-v01, 확인됨)
```

입력 pin: P10.3 최종 SHA `dacf1aa402125d46e62892e97aadc3d51d10141b`, DEV_TUNE Gold SHA
`7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b` (fetch 후 실제
계산값과 완전 일치 확인).

이번 Turn은 청킹 구현이나 임베딩 실행을 하지 않았다(static test로 강제:
`chunkDocument` 호출 없음, 모델 서버 spawn 없음, `/v1/embeddings` 호출 없음).
P10.3의 입력·결과 파일(`work/p10.3-table-diagnostic/`)은 읽기 전용으로만 참조했고
git status로 미수정 확인했다.

## B. 핵심 발견 — P10.3 resolver의 locator scheme 처리 누락

Gold의 `source_locator`는 실제로 **3가지 서로 다른 형식**을 사용한다(345개
acceptable_sources 전수 조사):

```
CELL_QUALIFIED   "docId/relPath#node=N&row=R&col=C"   260/345 (75.4%) — row/col 명시
NODE_ONLY_HASH   "docId/relPath#node=N"                  6/345 ( 1.7%)
NODE_ONLY_COLON  "docId::relPath::nodeId"                79/345 (22.9%)
```

**P10.3의 resolver(`table-evidence-resolver.mjs`의 `findNodeById`)는 `source_locator`
전체 문자열을 실제 DocumentIR의 `node_id`와 정확히 일치시키는 방식만 사용했다.**
이 방식은 `NODE_ONLY_COLON` 형식(79건)만 만족시킬 수 있다. `CELL_QUALIFIED`(260건,
전체의 75.4%이자 가장 권위 있는 — row/col이 명시적으로 지정된 — locator 형식)와
`NODE_ONLY_HASH`(6건)는 `findNodeById`가 항상 `null`을 반환해 **"non-table" 또는
"unresolvable"로 조용히 오분류**됐다.

이는 P10.3의 "75개 표-kind sources / 49개 TABLE_EVALUATION_ITEM"이 실제로는 전체
표 증거의 극히 일부(23.3%의 sources, 53.3%의 items)만 대표한다는 뜻이다. 실측
교정 결과:

```
                              P10.3 보고값   교정값
table-kind sources:               75          339   (75+260+4-table-kind-of-6)
TABLE_EVALUATION_ITEM:            49           92
```

CELL_QUALIFIED 260건은 예외 없이 전부 실제 DocumentIR의 `kind==="table"` node로
정확히 해석됐고(`node_not_found: 0`), row/col 모두 유효 범위 안에 있었다
(`out_of_range: 0`) — 즉 P10.3이 놓친 이 260건은 결측이 아니라 **가장 신뢰할 수
있는 근거였는데도 전혀 검토되지 않은 데이터**였다.

## C. Stage 1 — Locator 권위 순서 정의

`table-locator-authority.mjs`가 구현한 실제 우선순위:

```
1. source_locator의 document_id/node_id/row/column (CELL_QUALIFIED)
2. extensions.evidence_verification 등 cell-qualified provenance
   -- 이 Gold release 스키마에는 존재하지 않음(345개 source 전수 + 101개 item의
      extensions 객체 전수 조사: acceptable_source는 {document_id, source_locator,
      evidence_span}만 가지며, item-level extensions는 assignment_id,
      chain_component_id, gold_pool_role, authoring_eligibility,
      split_lock_status, artifact_status, verification_note만 포함 — cell 단위
      provenance 없음). 코드는 이 경로를 실제로 구현했지만(향후 호환성), 이번
      데이터에서는 한 번도 발동하지 않음 — 조용히 생략한 것이 아니라 명시적으로
      기록됨.
3. node_id + table 구조 (NODE_ONLY_HASH, rel_path+order_index로 node 해석)
4. evidence_span 텍스트 대조 (NODE_ONLY_COLON, 그리고 NODE_ONLY_HASH의 node
   해석 후)
```

1~2가 존재하면 3~4보다 우선하며, 테스트로 고정했다(동일 텍스트가 여러 셀에 있어도
CELL_QUALIFIED locator가 있으면 그 셀을 그대로 사용, ambiguity 계산 자체를
건너뜀).

## D. Stage 2 — 항목별 원인 분류

**4개 unresolvable source**: 전부 `SOURCE_PARSE_LIMITATION`으로 재분류됐다.
공통 원인: 4건 모두 해당 표 node의 `actual_col_counts`가 행마다 불규칙하다
(예: `[4,4,4,3,3,...]`) — 표 파싱이 열 개수를 일관되게 복원하지 못한 구조적
한계다. word-level 교차 검증(SequenceMatcher)으로도 최적 매칭 행의 단어가
evidence_span 안에 100% 포함되어 있음을 확인했다(순서/인접행 결합 방식 차이로
단순 substring 매칭만 실패) — Gold 오류나 resolver 로직 결함이 아니라 파서의
불규칙 열 구조가 원인이라는 근거다.

**모든 recorded violation (270건 = Fixed 162 + Section 108) 재검증**: 전부
`CHUNK_BOUNDARY_CONTEXT_LOSS`로 분류됐다 — 즉 P10.3이 examine한 45개 항목/615개
cell-check 범위 안에서는 **단 한 건도** Gold ambiguity, resolver bug, 또는
파싱 한계가 원인이 아니었다. 실제로 GOLD_LOCATOR_AMBIGUOUS는 0건이었다(evidence_span
텍스트 매칭에서 tight match가 2개 이상 겹치는 사례가 이 데이터셋에는 없었음).

```
root_cause_distribution (4 unresolvable + 270 violations = 274건 감사):
  SOURCE_PARSE_LIMITATION:      4
  CHUNK_BOUNDARY_CONTEXT_LOSS: 270
  GOLD_LOCATOR_AMBIGUOUS:       0
  GOLD_LOCATOR_UNRESOLVABLE:    0
  RESOLVER_IMPLEMENTATION_BUG:  0
  CHUNK_METADATA_LOSS:          0
  NOT_A_VIOLATION:              0
```

## E. Stage 3 — 전략별 실제 청킹 위반 재집계

```
                         Fixed-512+o64        Section-Aware-Flat
original (P10.3)              162                    108
corrected (chunking-only)     162                    108
excluded (non-chunking)         0                      0

by category (corrected == original, 재분류로 제외된 건 없음):
  row_header_loss:              0                      0
  column_period_header_loss:   76                     31
  unit_loss:                   45                     47
  locator_provenance_loss:     41                     30
```

`table_title_loss`와 `multi_cell_context_loss`는 P10.3이 셀 단위 violation record가
아닌 항목별 집계율로만 저장했으므로(재분류할 개별 root_cause가 없음) P10.3의
값을 그대로 이월했다: table_title_loss Fixed 255/615(41.5%) vs Section 98/615
(15.9%); multi_cell_context_loss 둘 다 0/45(0%).

**해석**: 감사 대상이었던 45개 항목/615개 cell-check 범위 안에서는 P10.3의
원래 수치가 정확했다 — 교정으로 줄어든 것이 없다. 그러나 이 범위 자체가 B절에서
밝혀진 대로 전체 표 증거의 22.1%(sources 기준)/53.3%(items 기준)에 불과하다.

## F. Stage 4 — P10.3 판정 재평가

```
status: ADAPTIVE_TABLE_CHUNKING_CONFIRMED
```

판정 근거(코드 계산, `table-diagnostic-verdict-correction.mjs`):

1. cell determination 불가율 4/75 = 5.3% < 50% rebuild threshold →
   TABLE_DIAGNOSTIC_INVALID_REQUIRES_REBUILD 아님.
2. Fixed 원본 위반 중 제외 비율 0/162 = 0% < 30% threshold →
   ADAPTIVE_DIRECTION_VALID_BUT_METRICS_CORRECTED 아님(수치 자체가 틀리지
   않았음).
3. Fixed 교정 위반 중 CHUNK_METADATA_LOSS 비율 0/162 = 0% < 70% threshold →
   EXISTING_CHUNKERS_REQUIRE_METADATA_FIX_ONLY 아님(진짜 텍스트 경계 손실이지
   metadata 전달 누락이 아님).
4. Fixed 교정 후 162건, Section 교정 후 108건 — 둘 다 0 초과(Section도 완전한
   대안 아님) → **ADAPTIVE_TABLE_CHUNKING_CONFIRMED**.

**중요한 별도 caveat (판정 자체를 바꾸지 않지만 반드시 병기)**: 이 판정은 P10.3이
실제로 examine한 45개 항목(전체 92개 중 53.3%)/75개 source(전체 339개 중 22.1%)
범위 안에서 code로 계산된 것이다. 그 범위 안에서는 위반이 100% 진짜 청킹
결함이었다는 강한 신호지만, 나머지 264개 source(CELL_QUALIFIED 260 +
NODE_ONLY_HASH table-kind 4)에 대해서는 이번 Turn에서 전혀 재검토하지
않았다 — 이를 위해서는 `chunkDocument()`를 다시 호출해야 하는데, 이는 이번
Turn의 명시적 금지 범위("청킹 구현이나 임베딩 실행을 하지 않는다")에 해당한다.
전체 92개 항목에 대한 완전한 재산출은 별도 Turn으로 명시적으로 권고한다.

## G. Stage 5 — P10.4 입력 계약

Adaptive 방향이 유지되므로(`ADAPTIVE_TABLE_CHUNKING_CONFIRMED`)
`adaptive-table-chunking-input-contract.v0.1.json`을 작성했다(설계안만, 구현
없음):

```
필수 필드: document_id, node_id, row, column, table_title, unit,
          column_period_header, row_header, cell_value, source_locator,
          inherited_context_provenance
chunk 형태: atomic_row_chunk (원자적 행 청크),
          multi_row_calculation_context_chunk (다중 행 계산용 context 청크)
불변식: 원문에 없는 header/unit 추론 금지, ambiguous locator 임의 해소 금지,
       동일 숫자만으로 셀 선택 금지, row/column provenance 보존,
       Gold 내용 하드코딩 금지
```

## H. 안전 경계 준수 증거

- DEV_CHECK/HOLDOUT: 미접근 (static test).
- 새 embedding 호출/모델 서버 실행/HCX 호출: 0건 — `spawn(VENV_PYTHON`,
  `local_embedding_server.py`, `/v1/embeddings`, `createEmbeddingAdapter`,
  chat-adapter import 전부 부재 확인(static test).
- 청킹 구현: `chunkDocument` 호출 없음(static test) — P10.3이 이미 만든 chunk
  결과만 참조했다(직접 재실행하지 않음).
- P10.3 입력·결과 파일 수정 금지: `work/p10.3-table-diagnostic/`에 쓰기 호출
  없음(static test) + git status로 미수정 확인.
- Gold 질문·정답·셀 원문: 어떤 출력 파일에도 없음. `audit_item_id`는
  `sha256(question_id)`의 앞 16자 해시(익명화, question_id 원문 자체를 노출하지
  않음), `node_id_hash`도 동일하게 해시 처리.
- production/PostgreSQL: 변경 없음.

## I. 검증

```
npm run test:p10.3.1-table-locator-audit  -> 34/34 pass
npm run schema:validate                   -> PASS, validated_pairs: 28
npm run typecheck                         -> clean
git diff --check                          -> clean
```

실행하지 않음: `npm run verify:contracts`, 전체 `test:domain`, headless Chrome,
PostgreSQL 통합 테스트, HCX 테스트, 전체 build.

## J. 산출물

```
work/p10.3.1-table-locator-audit/table-locator-authority-policy.v0.1.json
work/p10.3.1-table-locator-audit/table-locator-root-cause-audit.v0.1.json
work/p10.3.1-table-locator-audit/corrected-table-critical-violations.v0.1.json
work/p10.3.1-table-locator-audit/table-diagnostic-corrected-verdict.v0.1.json
work/p10.3.1-table-locator-audit/adaptive-table-chunking-input-contract.v0.1.json
```

Gold 질문·정답·셀 원문은 어디에도 기록하지 않았다.

## K. 알려진 한계 / 권고 Follow-up

- 이번 감사는 P10.3이 examine한 45개 항목/75개 source 범위로 한정된다. 전체
  92개 항목/339개 source에 대한 Stage 2 구조 보존 재검사(특히 260개
  CELL_QUALIFIED source — 가장 신뢰할 수 있는 근거였는데 한 번도 검토되지 않은
  데이터)는 `chunkDocument()` 재실행이 필요해 이번 Turn의 범위를 벗어난다.
  별도 Turn(가칭 P10.3.2)으로 권고한다 — 우선순위 높음: 92개 항목의 실제
  critical violation 수는 45개 항목 기준 162/108보다 훨씬 클 가능성이 높다
  (표본이 절반 미만이었으므로).
- P10.4 입력 계약은 설계안일 뿐이며 구현되지 않았다.

## L. Commit / Push

커밋/push SHA는 최종 사용자 보고에 기록한다(이 문서는 커밋 전 스냅샷).
