# A2 Scope Validator V1 — Amendment (Pre-registration Freeze)

## 0. Status

이 문서는 A2 Scope Validator 구현에 착수하기 **전에** 작성되었다. 작성 시점까지
Claude Code는 다음을 열람하지 않았다:

- `A.results.jsonl` / `A.run.json` (실제 A 검색 결과)
- `alternate-node-sensitivity-v1-result.json`
- Gold 값, Gold locator, acceptable_sources
- critical packet 원문 (u-... packet ID 포함 어떤 개별 packet 내용도)

이 문서는 아래 "현재 확정 사실"(작업 지시자가 제공한 요약 수치)과 프로젝트 공통 계약
(`CLAUDE.md`)만을 근거로 작성한다. 이 Amendment가 별도 commit으로 완료되기 전에는
실제 DEV_TUNE 결과·Gold·critical packet을 열지 않는다.

## 1. 입력으로 주어진 확정 사실 (검증 없이 그대로 인용)

- A Recall@10 = 0.8217로 4-arm 중 최고, 그러나 critical 2건 존재
- critical 2건 모두 연결/별도(consolidated/separate) scope 혼동
- 현재 선정 상태: `NO_SELECTION_BLOCKED`
- 기존 A 결과, KURE vector, BM25 index는 불변으로 재사용한다

## 2. A2 = 무엇인가

A2는 새로운 검색이 아니다. A2는 다음의 합성이다.

```text
A2 = frozen A top-20 (변경 없음)
   + Evidence Scope Validator (신규, 순수 함수)
   + stable refill (validator가 REJECT/UNRESOLVED로 걸러낸 자리를 채우는
     결정론적 재정렬, 신규 검색 아님)
```

## 3. 동결 항목 (본 커밋 이후 재논의 없이 구현 기간 내내 고정)

1. **검색·임베딩·랭킹 재실행 없음.** A의 top-20 원본 순서와 원본 스코어는
   validator의 입력으로만 사용하고 재계산하지 않는다.
2. **packet-ID / question-ID / company-ID 예외 금지.** validator 로직 어디에도
   특정 ID를 분기 조건으로 하드코딩하지 않는다. 실제 critical packet을 이후에
   열람하더라도, 그 packet이 통과하도록 규칙을 맞추는 어떠한 특례 분기도 추가하지
   않는다.
3. **Gold 값·Gold locator를 런타임 판단에 사용 금지.** validator는 Gold를 import,
   조회, 참조하지 않는다. validator의 판정 근거는 오직 (a) 질문에서 도출된 frozen
   conditions, (b) 검색 결과 근거(retrieval item)가 실제로 가리키는 node/table의
   scope·기간·단위·행/열 문맥뿐이다.
4. **결과를 본 뒤 규칙 변경 금지.** 실제 critical 2건이나 DEV_TUNE 결과를 열람한
   이후, 그 결과에 맞춰 validator의 판정 규칙(REJECT/PASS/UNRESOLVED 조건)을
   수정하지 않는다. 규칙에 결함이 발견되면 별도 후속 turn/amendment로 보고하고,
   본 turn 안에서 결과를 보고 규칙을 소급 조정하지 않는다.
5. **불명확하면 PASS가 아니라 UNRESOLVED.** scope/기간/단위/행·열 중 질문이 요구하는
   핵심 dimension을 근거에서 확정할 수 없으면 REJECT도 PASS도 아닌 UNRESOLVED를
   반환한다. UNRESOLVED는 A2 최종 top-k 채택에서 제외한다(= fail-closed).
6. **A 원본 결과 불변.** `A.results.jsonl`, `A.run.json` 등 A 원본 산출물은 어떤
   방식으로도 수정하지 않는다. A2의 산출물은 별도 파일로 새로 생성한다.
7. **실제 DEV_TUNE 재채점은 본 turn에서 하지 않는다.** 이 turn의 산출물은 validator
   모듈과 합성 fixture 테스트뿐이며, DEV_TUNE 150 문항에 대한 실행/재채점은
   수행하지 않는다.

## 4. Validator가 사용할 수 있는 것 / 없는 것

사용 가능:

- 질문에서 이미 도출된 frozen conditions(연결/별도 요구, 기간 요구, 단위 요구 등)
- 검색 결과 item이 실제로 지시하는 node/table의 표 제목·행명·열 기간·단위 표기 등
  "검색 근거의 실제 문맥"
- 결정론적 단위 환산표(원/천원/백만원 등 고정 배율)

사용 불가:

- Gold answer, Gold evidence, Gold acceptable_sources
- 특정 packet/question/company ID 기반 분기
- 특정 수치나 문자열의 하드코딩된 예외 목록
- retrieval/embedding/ranking 재실행 또는 그 결과에 대한 근사치 추정

## 5. 다음 단계 (본 turn 범위)

Section B~D에 정의된 `validateEvidenceDimensions` 순수 함수와 합성 fixture 기반
테스트만 구현한다. 이 Amendment commit 완료 후에 비로소 다음을 순서대로 연다:

1. `ALTERNATE_NODE_SENSITIVITY_V1_RESULT.md` / `..._AMENDMENT.md` (선행 turn 결과 요약)
2. `domain/agent-comparison/four-arm-ac/official/alternate-node-sensitivity-policy.v1.json`
3. 기존 source locator / provenance 필드 스키마(구현 정합성 확인용, 의미 변경 없음)

이 세 문서를 여는 목적은 오직 (a) 기존 source_locator/provenance 필드 이름과
스키마를 그대로 재사용하기 위함, (b) 이전 turn의 policy 표현 방식을 참고하기
위함이며, 이 열람이 위 3항(결과를 본 뒤 규칙 변경 금지)을 무효화하지 않는다 —
즉 이 문서들을 읽은 뒤에도 Section 3의 6개 동결 항목은 그대로 유지한다.
