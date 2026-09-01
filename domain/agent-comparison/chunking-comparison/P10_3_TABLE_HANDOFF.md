# Turn P10.3-TABLE — Fixed 512 표 처리 독립 진단 Handoff

## A. Worktree / Branch / Base

```
worktree: /Users/jaewan/Documents/Codex/worktrees/agent-table-chunking-diagnostic-v01
branch:   codex/agent-table-chunking-diagnostic-v01
base:     14adb49  (P10.2 최종 push SHA, origin/codex/agent-chunking-embedding-grid-v01)
```

시작 조건은 `scripts/p10.3-table-verify-start-conditions.mjs`로 fail-closed 검증했다
(`work/p10.3-table-diagnostic/start-condition-verification.v0.1.json`, `gate_status: "GREEN"`).

입력 pin:

```
P10.1 최종 SHA:    35fd52e (feat: select chunking strategy with authorized DEV_TUNE)
P10.1.1 최종 SHA:  7288055 (fix: evaluate hierarchical chunking with parent-aware retrieval)
P10.2 최종 push SHA: 14adb49 (fix: correct P10.2 interaction verdict)
DEV_TUNE:          101건, dev-tune-gold.v0.1.jsonl
                    sha256 = 7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b
                    (실제 fetch·계산값과 완전히 일치, gate GREEN)
P10.2 조합:        6/6 complete (stage2-grid-results.v0.1.json 확인)
Hierarchical:      제외 유지 (P10_STRATEGIES에서 document-type-hierarchical-parent-child
                    필터링, static test로 강제)
```

## B. Stage 1 — 실제 표 평가 항목 식별

기계적 분류(질문 문구/question_type 이름을 전혀 사용하지 않음): Gold의 각
`acceptable_sources[].source_locator`를 실제 DocumentIR node로 해석(`node.kind`)하고,
`evidence_span`을 해당 표 node의 `normalized_rows` grid에 텍스트 대조(tight/broad
매칭)해 row/column을 역추적했다.

```
DEV_TUNE 항목:              101
TABLE_EVALUATION_ITEM:      49  (48.5%)
비-TABLE 항목:               52
표-kind acceptable_sources:  75  (전체 345 sources 중)
  resolved:                  71
  unresolvable(4/75, 5.3%):   4  -- evidence_span이 표 어느 행에서도 발견되지 않음
                                    (fail-closed으로 unresolved 처리, 임의 추정 없음)
```

태그 분포 (표 항목 49개 기준, 중복 허용):

```
ROW_HEADER_VALUE:                45
MULTI_COLUMN_COMPARISON:         45
MULTI_ROW_CALCULATION:           32
CROSS_TABLE:                     18
CROSS_DOCUMENT_TABLE:             8
COLUMN_PERIOD_VALUE:              7
UNIT_SENSITIVE:                   1
SINGLE_CELL_LOOKUP:               0
TABLE_WITH_REPEATED_BOILERPLATE:  0
```

실측 특이사항 (모두 code로 검증됨, 임의 판단 아님):

- **SINGLE_CELL_LOOKUP = 0**: 이 Gold 세트의 표 관련 `evidence_span`은 중앙값
  538자(59~2,476자)로, 값 하나만 단독 인용한 사례가 없다. 항상 행 레이블(항목명)
  이상을 함께 인용하므로 구조적으로 "완전히 고립된 단일 셀" 인용이 존재하지 않는다.
- **UNIT_SENSITIVE = 1**: `node.unit_text`/`node.period_text`는 이 코퍼스 파서가
  **한 번도** 채운 적이 없다(372문서 bounded corpus 32,449개 표 node 전수 조사,
  0/32,449). 단위는 "(단위: 백만원)" 형태의 별도 행으로만 존재하며, 그런 행을
  가진 표가 실제로 매우 드물다(표-kind source 75개 중 2개만 단위 선언 행 보유).
- **TABLE_WITH_REPEATED_BOILERPLATE = 0**: 표-kind source가 걸린 75개 표 node의
  중복행 비율은 최대 4.3%(threshold 15% 미달) — 이 샘플에는 유의미한 반복
  boilerplate 표가 없었다(실측, 태그 정의 자체는 유지).

## C. Stage 2 — Fixed/Section 구조 보존 검사 (실제 chunker.mjs, 임베딩 0회)

`domain/chunking/chunker.mjs`(무수정, `chunkFixed`/`chunkSectionFlat` 그대로 재사용)를
372문서 bounded evaluation corpus 전체에 실행해 실제 청크를 만들고, Stage 1이 해석한
표 셀 615개(45개 표 항목 × 평균 다중 행)를 **span의 주장이 아니라 raw_text의 실제
텍스트 포함 여부**로 검증했다. 결정론(같은 스크립트 재실행 시 critical_violation_count
및 totals 완전 동일)을 실측으로 확인했다.

```
                          Fixed-512+o64        Section-Aware-Flat
gold_cell_retrievable    615/615 (100%)        615/615 (100%)
row_header_preserved     594/594 (100%)        594/594 (100%)
column_header_preserved  346/422 (82.0%)       391/422 (92.7%)
unit_preserved            27/72  (37.5%)        25/72  (34.7%)
table_title_preserved    360/615 (58.5%)       517/615 (84.1%)
locator_misrepresentation     41                    30
ambiguous_numeric_collision  126/565 (22.3%)   126/565 (22.3%)  <- 청킹과 무관, 표 자체 속성
multi_cell_colocation_ok  45/45 (100%)          45/45 (100%)

critical violations
  LOCATOR_RESOLVES_TO_WRONG_CELL:   41   vs   30
  PERIOD_COLUMN_VALUE_MISMATCH:     76   vs   31
  UNIT_MISSING_OR_MISCOMBINED:      45   vs   47
  ROW_HEADER_VALUE_MISMATCH:         0   vs    0
  ------------------------------------------------
  TOTAL:                           162   vs  108
```

핵심 발견: **Fixed-512는 gold cell 자체는 100% 복원 가능하지만(즉 "완전히 잃어버리는"
경우는 없음), 그 셀이 속한 기간/열 헤더(PERIOD_COLUMN_VALUE_MISMATCH, 76 vs 31 —
2.5배)와 섹션/표제 문맥(table_title_preserved 58.5% vs 84.1%)을 Section-Flat보다
훨씬 자주 분리한다.** 이는 chunkFixed가 파일 전체를 섹션 경계 없이 순차 윈도우로
자르는 반면, chunkSectionFlat은 표의 모든 행을 그 표가 속한 섹션 안에서만
윈도우잉하기 때문이다(코드 레벨에서 직접 확인). row_header_preserved는 두 전략
모두 100%인데, 이는 chunker.mjs가 표의 한 행 전체를 하나의 원자적 segment로
다루므로 행 레이블(col 0)과 그 행의 값이 서로 다른 청크로 갈라지는 경우가
근본적으로 드물기 때문이다.

ambiguous_numeric_collision(126/565, 22.3%)은 두 전략에서 **완전히 동일**하다 —
이는 청킹 방식이 아니라 표 자체의 데이터 속성(같은 숫자가 다른 행/열에 반복)이므로
당연한 결과이며, 코드 구현이 청킹-무관 항목을 올바르게 청킹-무관으로 계산했다는
교차검증이기도 하다.

## D. Stage 3 — P10.2 결과 표 전용 재채점 (부분적, 실제 데이터, 새 embedding 0회)

**투명하게 공개하는 제약**: P10.2의 `stage2-per-item-results.v0.1.jsonl`은 항목별
**스칼라 집계값**(`evidence_slot_coverage_fraction_at_k`, `reciprocal_rank`,
`ndcg_at_10`)만 저장하며, 실제로 각 순위에 어떤 청크가 반환됐는지의 원본 랭킹
리스트는 저장되지 않았다(`scripts/p10.2-stage2-embedding-grid.mjs`의
`computeItemMetrics(item, rankedChunks)` 호출 시점에만 존재했고 디스크에 남지 않음
— 코드를 직접 읽어 확인). 이를 복구하려면 새 임베딩 호출이 필요하므로(밀집 벡터가
없으면 dense/rrf 랭킹 재현 불가), 이번 Turn의 금지 사항과 정면으로 충돌한다.
따라서 이 Turn 자체의 fail-closed 트리거 "P10.2 cache/ranking 결과 누락"에 해당하는
**하위 지표만** 선별적으로 `NOT_COMPUTABLE`로 표시했다(TABLE_DIAGNOSTIC_INCONCLUSIVE로
전체를 중단하지 않은 이유는 Stage 5 판정에 실제로 필요한 입력 — table Recall@10,
multi-cell completeness — 은 기존 항목별 집계에서 그대로 계산 가능했기 때문이다).

**계산됨 (실제 데이터, 표 항목 49개로 필터링)**:

```
combo                            table_recall@10   
kure_v1   x Fixed                0.9286
kure_v1   x Section-Flat         0.8980
bge_m3    x Fixed                0.8980
bge_m3    x Section-Flat         0.8980
pixie_rune x Fixed               0.9286
pixie_rune x Section-Flat        0.9184
```

table Recall@5/20, table MRR, table nDCG@10, multi_cell_complete_evidence_recall_at_10도
같은 방식으로 6개 조합 전부 계산해 `table-retrieval-metrics-by-combination.v0.1.json`에
기록했다.

**계산 불가 (명시적으로 disclosed, 대체값 없음)**: cell-level Recall@10,
row-header-aware Recall@10, unit-aware Recall@10, period-column-aware Recall@10,
table boilerplate false-positive rate, ambiguous numeric collision rate(검색 순위
버전). 이유는 각 필드에 `not_computable.reason`으로 동일하게 기록했다.

## E. Stage 4 — 청킹×임베딩 interaction

```
model_recall_deltas (section_minus_fixed)
  kure_v1:    -0.0306  (fixed_wins, tolerance 밖)
  bge_m3:      0.0000  (tie)
  pixie_rune: -0.0102  (fixed_wins, tolerance 밖)

any_model_where_section_recall_wins:  false
any_model_where_fixed_recall_wins:    true
material_recall_interaction:          false   (3모델 모두 Fixed 동률 또는 우세,
                                                 진짜 방향 반전 없음)
chunking_structural_advantage:        SECTION (critical_violation: Fixed 162 > Section 108)
retrieval_succeeded_but_context_preservation_failed: true
```

**"검색은 성공했지만 문맥 보존에는 실패한 경우"가 실제로 관측됐다**: 검색
지표(table Recall@10)만 보면 Fixed가 모든 모델에서 동률 이상이라 문제없어
보이지만, Stage 2의 구조 검사는 Fixed가 그 반환된 청크 안에서 기간/열 헤더를
Section보다 2.5배 더 자주 놓친다는 것을 보여준다 — 즉 "정답이 담긴 문서/노드는
찾아오지만, 그 청크 텍스트만으로는 올바른 기간에 값을 귀속시키기 어려운" 케이스가
Fixed에서 유의하게 더 많다. 이는 청킹 구조 차이(문맥 보존)이며 임베딩 모델의
검색 능력 차이가 아니다(P10.2에서 이미 확정된 kure_v1 최종 선정과는 별개 축).

## F. 일반 문서 결과와 표 결과의 충돌

P10.2는 macro recall@10 기준 Fixed를 최종 선정했다(kure_v1 × Fixed, 0.868 vs
Section 0.834, 전 모델에서 Fixed 우세). 표 항목만 본 Stage 3의 table Recall@10도
Fixed가 동률 이상이므로 **검색 지표 자체는 충돌하지 않는다**. 충돌은 검색과 구조
보존 "사이"에서 발생한다: Fixed가 검색은 이기거나 비기지만, 그 표 근거의 구조적
신뢰성(critical violation)은 Section보다 유의하게 나쁘다.

## G. Stage 5 — 최종 판정

```
status: ADAPTIVE_TABLE_CHUNKING_REQUIRED
```

판정 근거(코드가 계산한 reason_trail 그대로):

1. `FIXED_512_TABLE_SAFE` 미충족 — Fixed critical_violations=162(요구: 0),
   misattribution=121(요구: 0). 검색(recall_never_behind=true)과 multi-cell
   completeness(동등)는 조건을 만족했지만 critical violation 조건에서 즉시 탈락.
2. `SECTION_FLAT_PREFERRED_FOR_TABLES` 미충족 — Section이 0.03 이상 margin으로
   이긴 모델 0개, Fixed에만 violation이 있는 것도 아님(Section도 108건 보유).
3. `ADAPTIVE_TABLE_CHUNKING_REQUIRED` 충족 — 일반 문서는 P10.2에서 이미 Fixed
   우세로 확정, 표 문서는 구조 보존에서 Section이 명확히 우세(162 > 108, 특히
   기간/열 헤더 보존 82.0% vs 92.7%)하지만 검색 우위로 이어지지 않아 단일 청킹
   전략으로 두 요구사항을 동시에 만족시키지 못한다.

**"판정이 불확실하면 Fixed를 자동 승인하지 않는다"** 원칙을 코드 레벨에서 강제했다
(`table-chunking-verdict-rule.mjs`: FIXED_SAFE는 critical_violation===0을 반드시
요구하는 명시적 분기이며, 함수의 마지막 도달 가능 분기는 항상 INCONCLUSIVE이지
FIXED_SAFE가 아님 — static test로 고정).

## H. Adaptive 설계안 (이번 Turn에서 구현하지 않음, 설계만)

```
PARAGRAPH/TITLE  -> fixed-token-512-o64.v0.1.0 (변경 없음)
TABLE/TABLE_ROW  -> 표 제목·단위·행·열 문맥을 보존하는 table-aware chunk
                    (구체 설계는 별도 Turn)
결합             -> 동일 문서 내 두 결과를 공통 retrieval ranker에서 결합
```

## I. 안전 경계 준수 증거

- DEV_CHECK/HOLDOUT: 어떤 P10.3 모듈/스크립트도 해당 경로를 `readFile`하지 않음
  (`tests/p10.3-safety-and-composition.test.mjs`의 static grep 테스트로 고정).
- HCX/Agent 답변 생성: 어떤 P10.3 파일도 chat/completion adapter를 import하지 않음
  (static test).
- 새 embedding 호출: Stage 2/3/4-5 어디에도 `spawn(VENV_PYTHON`,
  `local_embedding_server.py`, `/v1/embeddings`, `createEmbeddingAdapter` 참조가
  없음(static test) + Stage 3 결과 파일 자체에 `new_embedding_calls: 0`,
  `new_model_servers_spawned: 0` 기록.
- P10.2 worktree 미수정: 이번 Turn의 모든 `writeFile` 호출은
  `agent-chunking-embedding-grid-v01` 경로를 대상으로 하지 않음(static test).
  P10.2의 `stage2-grid-results.v0.1.json`/`stage2-per-item-results.v0.1.jsonl`은
  절대 경로로 읽기만 했다.
- Gold 질문·정답·evidence 원문: 어떤 결과 JSON도 `question`/`expected_answer`
  필드나 `evidence_span` 텍스트를 포함하지 않음(코드 레벨에서 애초에 그 필드를
  객체 리터럴에 할당하지 않도록 작성 + static test).
- Hierarchical 제외: `P10_STRATEGIES.filter(s => s.strategy_name !==
  "document-type-hierarchical-parent-child")`로 2개 전략만 사용, static test로
  고정. P10.1.1의 기존 결과 파일은 전혀 건드리지 않았다.

## J. 검증

```
npm run test:p10.3-table-diagnostic  -> 60/60 pass
npm run schema:validate              -> PASS, validated_pairs: 28
npm run typecheck                    -> clean (no output)
git diff --check                     -> clean
```

실행하지 않음(이번 Turn의 명시적 제외 범위): `npm run verify:contracts`,
전체 `test:domain`, headless Chrome, PostgreSQL 통합 테스트, HCX 테스트, 전체 build.

## K. 산출물

```
work/p10.3-table-diagnostic/table-item-inventory.v0.1.json
work/p10.3-table-diagnostic/table-structure-preservation-report.v0.1.json
work/p10.3-table-diagnostic/table-retrieval-metrics-by-combination.v0.1.json
work/p10.3-table-diagnostic/table-chunking-interaction-report.v0.1.json
work/p10.3-table-diagnostic/table-chunking-final-verdict.v0.1.json
work/p10.3-table-diagnostic/start-condition-verification.v0.1.json
work/p10.3-table-diagnostic/input-pin-manifest.v0.1.json
```

Gold 질문 원문·expected answer 원문·evidence span 원문·원본 표 셀 내용·embedding
vector·모델 cache는 어디에도 기록하지 않았다.

## L. 알려진 한계

- Stage 3의 cell-level/row-header-aware/unit-aware/period-column-aware Recall@10과
  boilerplate false-positive rate, 검색-순위 기반 ambiguous numeric collision
  rate는 P10.2 원본 실행이 랭킹 리스트를 영속화하지 않아 계산할 수 없었다(D절
  참조). 이 데이터가 필요하다면 P10.2 Stage 2를 랭킹 리스트를 함께 저장하도록
  수정한 뒤 재실행해야 하며, 이는 새로운 임베딩 호출을 수반하므로 별도 Turn의
  범위다.
- UNIT_SENSITIVE/단위 보존 검사는 이 코퍼스의 파서가 `unit_text`를 전혀 채우지
  않는다는 실측 사실 위에서, cell 텍스트 자체의 "(단위: ...)" 패턴 탐지에
  의존한다 — 원문에 단위가 헤더 셀에 병합돼 있거나 표 캡션에만 있는 경우는
  현재 탐지되지 않을 수 있다.
- Adaptive 설계안은 이름 그대로 설계일 뿐이며 구현되지 않았다.

## M. Commit / Push

아래 커밋 SHA와 push 결과를 최종 사용자 보고에 포함한다(이 문서 자체는 커밋 전
스냅샷이므로 SHA는 최종 보고 메시지 참조).
