# Author Allocation Policy — CURRENT (Turn N4.0.1)

**상태: CURRENT.** 이 문서는 두 작업자(A, B)가 최종 Gold 300을 어떻게 나눠
작성할지의 **정책**만 기록한다. 실제 150개 목록 확정이나 Gold 작성은 이번
Turn에서 하지 않는다 — `domain/evaluation/candidate-pool-builder.mjs`가 만든
Candidate Pool(500건, PROVISIONAL_HEURISTIC)에서 아직 아무 assignment도 특정
작업자에게 배정되지 않았다.

## 숫자

```text
최종 공식 Gold          : 300
  작업자 A              : 150
  작업자 B              : 150

Candidate Pool(500)     : 두 작업자 공통 선택 모집단 (분할하지 않음)
Anchor 120~150          : 두 작업자 합계
  초기 Anchor 배정       : 각자 60~75개 수준
  검증 후 확장           : 각자 최종 150개까지
```

## 배정 규칙

1. **Candidate Pool은 나누지 않는다.** `candidate-pool.v0.1.jsonl`의 500건은
   두 작업자가 함께 선택하는 공통 모집단이다 — Pool 생성 단계에서 A용/B용으로
   미리 분할하지 않는다.
2. **같은 `evaluation_group_id`(=같은 chain component)를 두 작업자에게 나눠
   배정하지 않는다.** 한 component에 속한 모든 assignment는 반드시 같은
   작업자에게 통째로 간다 — [`CHAIN_SAFE_GROUPING_CONTRACT.v1.md`](./CHAIN_SAFE_GROUPING_CONTRACT.v1.md)의
   "같은 component는 같은 split" 규칙과 동일한 이유(한 사건의 질문들이 서로
   다른 작업자의 서로 다른 판단 기준으로 나뉘어 작성되면 안 됨)다.
3. **초기 Anchor 배정은 각자 60~75개**로 시작한다(둘이 합쳐 120~150). 상호검수를
   거쳐 문제가 없으면 각자 150개까지 확장한다.
4. **상대 작업자의 문항을 교차 검수하는 것을 권장한다** (`domain/evaluation/README.md`의
   Two-person review 원칙과 일치 — 작성자와 검수자는 달라야 한다).
5. **작업자 배정 자체도 chain closure 전에는 provisional이다.** Anchor
   상호검수 단계에서 실제 chain이 늦게 발견되면(README.md의 "Late chain
   discovery" 규칙과 동일하게) 해당 component 전체를 재배정할 수 있다 —
   이미 한 작업자가 절반만 작성했더라도, 늦게 발견된 chain이 다른 작업자의
   기존 문항과 겹치면 component 전체를 한쪽으로 통합한다.

## 이번 Turn(N4.0.1)이 하지 않는 것

- 실제 작업자 A/B별 150개 문항 목록을 확정하지 않았다.
- 어떤 assignment에도 `author: "A"` / `author: "B"` 같은 필드를 추가하지 않았다
  (Candidate Pool 스키마에 그런 필드 자체가 없다 — 이 문서는 정책만 기록한다).
- 새 Gold를 작성하지 않았다.
- chain closure를 수행하지 않았다 — 위 규칙 2·5는 chain closure가 끝난 뒤에도
  계속 적용되는 원칙으로 미리 문서화한 것이다.
