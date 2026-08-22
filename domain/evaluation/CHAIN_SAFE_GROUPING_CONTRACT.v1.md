# Chain-Safe Grouping Contract (Turn N4.0, 용어 정정 N4.0.1)

**상태: CURRENT.** 이 문서는 Candidate Pool/Anchor/Gold 전 단계에 적용되는 계약이다.
파일명은 Turn N4.0의 원래 감사 이력(재현된 결함, counterexample, 알고리즘)을
보존하기 위해 유지한다. **N4.0.1에서 수정한 것은 표현 수준이다** — 아래 알고리즘
자체는 N4.0과 동일하고 새로 무언가를 "확정"하지 않았다.

## 지금 실제로 보장되는 것과 보장되지 않는 것 (가장 먼저 읽을 것)

```text
grouping_status        : PROVISIONAL_HEURISTIC
relation_basis         : TOP_CANDIDATE_PENDING_REVIEW
leakage_report_scope   : CURRENT_PROVISIONAL_GRAPH_ONLY
official_split_eligible: false
chain_closure_required : true
```

- **보장되는 것**: 같은 connected component(현재 PENDING 후보 그래프 기준)에
  속한 모든 assignment는 코드상 반드시 같은 `evaluation_group_id`와 같은
  `planned_split`을 받는다. 이 순서(그룹 먼저, split 나중)는 실제로 강제되며
  `computeLeakageReport`로 매 실행마다 실측 검증한다.
- **보장되지 않는 것**: AMENDS 1,004건·TERMINATES 20건 후보는 전부
  `review_status: PENDING`이다(사람이 CONFIRMED/REJECTED로 검수한 적이 없다).
  또한 builder는 각 source 문서의 후보 중 **최고 점수 1개만** provisional
  edge로 쓴다(아래 "edge 정책" 참고) — 나머지 낮은 점수 후보는 이번 그래프에
  전혀 반영되지 않는다. 따라서 이 문서와 코드의 어떤 결과도 다음처럼
  표현하지 않는다: "chain closure 완료", "실제 chain-safe split 확정",
  "genuine chain이 절대 분리되지 않음", "leakage 0이 공식적으로 증명됨".
  정확한 표현은 "현재 PROVISIONAL 후보 그래프 안에서 leakage 0건"이다.

`domain/evaluation/README.md`의 "Split before authoring" 절이 이미 이 원칙을
개념적으로 선언하고 있다 — 이 문서는 그 원칙을 실제 코드(`domain/postgres`가
아니라 `domain/evaluation/candidate-pool-builder.mjs`)로 구현하면서 발견한 실제
결함과, 그 결함을 고친 구체적 알고리즘을 기록한다.

## 원칙 (변경 없음, 재확인)

질문을 먼저 만든 뒤 무작위/개별 분할하지 않는다. 평가 그룹은 다음을 모두 고려한
connected component여야 하며, 같은 component의 질문은 반드시 같은 split에
배정한다.

- 동일 document_id
- AMENDS / TERMINATES / CONFIRMS
- 동일 원계약·사건 identity
- 정정 전·후 문서
- 같은 periodic 비교에 함께 사용된 두 기간 문서
- cross-company 비교에 함께 사용된 양쪽 anchor

## 실제 재현된 결함 (`scripts/build-evaluation-authoring-queue.mjs`)

기존 150문항 작성 큐 스크립트는 각 assignment의 `group_key`를 다음과 같이
계산한다.

```js
group: `major:${row.doc_id}`                    // major (원본·정정 공통)
group: `exchange-correction:${row.doc_id}`       // exchange 정정
group: `exchange-termination:${row.doc_id}`      // exchange 해지
group: `holding:${row.doc_id}`                   // holding (원본·정정 공통)
```

**모두 그 문서 자신의 `doc_id`만 사용하며, 그 문서가 AMENDS/TERMINATES하는
대상 문서를 전혀 참조하지 않는다.** 이후 `quotaSelect`+`splitMatrices` 단계는
"correction" 태그와 "narrative"(원본) 태그를 **서로 다른, 독립적인** 후보군으로
취급해 각각 별도의 stable-hash 정렬·slice로 `planned_split`을 배정한다 — 두
태그 사이에 아무 연결이 없다.

### 실제 counterexample (실제 문서 ID, 실제 corpus)

실제 corpus manifest와 실제 `work/domain-seed/relation-review-queue.jsonl`(AMENDS
1,004건 후보)을 대조한 결과:

```text
source_document_id: major_20241118000171  ([기재정정]주요사항보고서, 삼성전자)
relation_type:       AMENDS
target_document_id:  major_20241115000375  (주요사항보고서, 삼성전자, 원본)
candidate score:      0.45 (relation-review-queue.jsonl, review_status=PENDING)

기존 스크립트 기준:
  major_20241118000171 -> group_key "major:major_20241118000171" (tag: correction_chain)
  major_20241115000375 -> group_key "major:major_20241115000375" (tag: narrative)
```

두 group_key는 완전히 다른 문자열이고, 완전히 다른 selection/split 경로를 거친다.
실제로 `major_20241115000375`는 현재 150문항 큐에서 DEV_TUNE으로 선택됐지만
(`author_0221b9572d87d63d8da6ed6e`), `major_20241118000171`은 이번 quota(8건)에
선택되지 않았다 — 즉 이번 특정 실행에서는 우연히 두 문서가 동시에 선택되지
않아 실제 leakage로 드러나지 않았을 뿐, **메커니즘 자체는 leakage를 막는
어떤 장치도 갖고 있지 않다.**

메커니즘 결함을 corpus 전체 규모로 정량화하기 위해 실제 manifest와 실제
relation-review-queue.jsonl 전체를 대조했다:

```text
AMENDS/TERMINATES 후보 중, source와 target이 모두 group-assignable(즉 둘 다
150문항류 스크립트가 group_key를 만들 수 있는 문서)이고 두 group_key가
서로 다른 실제 쌍: 4,750쌍
```

즉 4,750개의 실제 문서 쌍이 "둘 다 선택되면 다른 split으로 갈 수 있는" 상태다.
Candidate Pool을 150건에서 300~500건으로 넓히면 이런 쌍이 동시에 선택될 확률은
크게 증가한다 — 이번 Turn이 새 알고리즘을 요구하는 실질적 이유다.

## 수정: `domain/evaluation/candidate-pool-builder.mjs`

기존 150문항 큐 파일(`work/domain-seed/evaluation-authoring-queue.jsonl`,
`scripts/build-evaluation-authoring-queue.mjs`)은 **덮어쓰지 않았다** — Seed
배선·회귀에 계속 쓰이는 별도 산출물로 그대로 둔다. 대신 완전히 새 파일에
connected-component 기반 알고리즘을 구현했다.

1. **Union-Find 그래프**를 문서 단위로 만든다. 두 종류의 edge:
   - **co-anchoring**: 한 assignment의 `anchor_document_ids`에 함께 들어간
     문서들(periodic 두 기간, cross-company 양쪽 anchor는 이 규칙으로 자동
     연결된다).
   - **relation candidate**: `relation-review-queue.jsonl`의 AMENDS/TERMINATES/
     CONFIRMS 후보. source와 가장 높은 score의 target 하나를 연결한다(아래
     "edge 정책" 참고).
2. **evaluation_group_id는 connected component 단위**로만 부여한다. 같은
   component에 속한 모든 assignment는 자동으로 같은 `evaluation_group_id`를
   갖는다 — 문서 단위 `group_key`(사람이 읽는 설명 문자열)는 그대로 남기되,
   split 배정에는 전혀 쓰이지 않는다.
3. **Pool 선택과 split 배정 모두 component(그룹) 단위**로만 이뤄진다 — 한
   component의 assignment 일부만 포함/제외하거나, 서로 다른 split으로 나누는
   경로가 코드에 없다(`selectCandidatePool`/`assignProvisionalSplits`).
4. `computeLeakageReport`가 이를 실측으로 검증한다 —
   `CHAIN_COMPONENT_SPLIT_LEAKAGE`, `DOCUMENT_SPLIT_LEAKAGE`,
   `CROSS_DOCUMENT_ANCHORS_NOT_CO_GROUPED` 등.

### edge 정책: 최고 점수 후보 1개만 (측정 후 결정)

`relation-review-queue.jsonl`의 각 source 문서는 평균 2~4개의 GUESS된 target
후보를 가지며, 최고 점수(0.45) 외 대부분은 `within_30_days`처럼 약한 신호
하나만으로 스코어링된 낮은 점수(0.2)다. 실제로 측정한 결과:

```text
모든 후보를 union(가장 보수적)   : component 153개, 최대 크기 109문서
최고 점수 후보 1개만 union       : component 1,114개, 최대 크기 33문서
```

모든 후보를 union하면 corpus 상당 부분이 소수의 거대 component로 뭉쳐 300~500
규모의 Pool 자체가 불가능해진다(실측: 793~1,022건까지 부풀어 targetMax 500을
초과). 최고 점수 후보 1개만 사용해도 실제 AMENDS/TERMINATES/CONFIRMS 후보를
**하나도 버리지 않으며**(모든 source가 여전히 최소 1개의 edge를 갖는다),
component 크기가 corpus 규모에 맞게 억제된다. `topCandidateOnly: false`
옵션으로 언제든 완전 보수적 모드로 되돌릴 수 있다(예: chain 실사 완료 후
정밀도가 중요해지는 단계).

### 임계 slice 표본 부족 방어: `criticalTagFloors`

Union-Find 자체는 (현재 PENDING 후보 그래프 안에서) 일관적이지만, 1,710~2,583개의 component 중 상위 300~500건만
stable-hash 순으로 뽑으면 표본이 드문 slice(예: TERMINATES 후보는 corpus
전체에 20건뿐)가 우연히 전부 탈락할 수 있다. `selectCandidatePool`은 회사·
문서 ID가 아니라 **태그** 기준으로 최소 포함 개수(`criticalTagFloors`)를
먼저 보장한 뒤 일반 채우기를 진행한다 — 특정 회사나 질문을 겨냥한 분기가
아니라, "이 slice가 corpus에 실제로 존재하면 Pool에서 사라지지 않는다"는
일반 규칙이다. 부족하면(floor보다 실제 표본이 적으면) 인위적으로 채우지 않고
`critical_tag_shortfalls`로 정직하게 보고한다.

## PROVISIONAL_UNTIL_CHAIN_CLOSURE lifecycle (변경 없음, 재확인)

이번 Turn에서 생성한 Candidate Pool의 모든 anchor-보유 assignment는
`split_lock_status: PROVISIONAL_UNTIL_CHAIN_CLOSURE`다. anchor가 없는 coverage
질문만 `LOCKED_BY_COVERAGE`다. `LOCKED_BY_CHAIN`은 이번 Turn에서 어디에도
등장하지 않는다 — 실제 사람 관계 검수(AMENDS/TERMINATES/CONFIRMS 후보의
review_status가 PENDING에서 CONFIRMED/REJECTED로 바뀌는 것) 전에는 절대
사용하지 않는다.

```text
chain closure 전 (지금, N4.0.1 포함):
  - planned_split은 참고용 provisional
  - split_lock_status = PROVISIONAL_UNTIL_CHAIN_CLOSURE
  - grouping_status = PROVISIONAL_HEURISTIC
  - relation_basis = TOP_CANDIDATE_PENDING_REVIEW
  - leakage_report_scope = CURRENT_PROVISIONAL_GRAPH_ONLY
  - official_split_eligible = false
  - chain_closure_required = true
  - DEV_CHECK/HOLDOUT 공식 실행 금지 (domain/evaluation/README.md의 기존
    Usage freeze 규칙이 그대로 적용된다 -- 이 Turn이 바꾸지 않았다)
  - SANDBOX만 조기 확인에 사용 가능, 모델 선택 지표에 미포함

chain closure 후 (아직 이번 Turn에서 수행하지 않음):
  - 사람 검수자가 AMENDS/TERMINATES/CONFIRMS 후보 1,024건을 하나씩
    CONFIRMED/REJECTED로 판정
  - connected component를 CONFIRMED 관계만으로 다시 계산(현재의
    TOP_CANDIDATE_PENDING_REVIEW 그래프를 그대로 승격하지 않는다)
  - computeLeakageReport를 그 재계산된 그래프에 다시 실행해 leakage 0 확인
  - 그때만 split_lock_status를 LOCKED_BY_CHAIN으로, official_split_eligible를
    true로 전환할 수 있다
```

## 이 문서가 하지 않는 것

- `work/domain-seed/evaluation-authoring-queue.jsonl`(기존 150건)을 재생성하거나
  덮어쓰지 않았다.
- chain closure(실제 사람 관계 검수)를 수행하지 않았다 — `LOCKED_BY_CHAIN`으로
  전환된 assignment는 없다.
- 새 Fact/Evidence/Event/Relation을 저작하지 않았다 — 오직 기존 candidate 관계
  큐(1,004+20건, 이미 존재)만 읽었다.
