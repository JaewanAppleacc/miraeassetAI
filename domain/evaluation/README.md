# Evaluation Gold Authoring Guide

## Dataset roles

평가 질문 500개는 독립된 세 세트로 관리합니다.

| 문서유형 | DEV_TUNE | DEV_CHECK | HOLDOUT | 합계 |
|---|---:|---:|---:|---:|
| periodic | 75 | 30 | 45 | 150 |
| exchange | 75 | 30 | 45 | 150 |
| major | 40 | 16 | 24 | 80 |
| holding | 40 | 16 | 24 | 80 |
| cross-document | 20 | 8 | 12 | 40 |
| 합계 | 250 | 100 | 150 | 500 |

- `DEV_TUNE`: 청킹·임베딩·검색 설정 선택에 반복 사용
- `DEV_CHECK`: 주요 동결 시점에만 일반화 확인
- `HOLDOUT`: 최종 동결 후 한 번만 사용
- `REGRESSION`: 위 500개와 별도의 동적 suite. 버그 재현 질문을 누적

## Split before authoring

질문을 먼저 만든 뒤 무작위 분할하지 않습니다. 다음 단위로
`evaluation_group_id`를 만들고 그룹 전체를 하나의 split에 배정합니다.

| 문서유형 | 그룹 단위 |
|---|---|
| periodic | `corp_code + report kind + fiscal period + correction chain` |
| exchange | 동일 계약·투자 사건의 원본·정정·확정·해지 chain |
| major | 동일 주요 사건의 원본·정정 chain |
| holding | `corp_code + reporter + report date + correction chain` |

같은 그룹에서 만든 질문은 다른 split으로 이동할 수 없습니다.

동일 `gold_document_id`도 둘 이상의 split에서 재사용할 수 없습니다. 질문 자체가
정정을 묻지 않더라도 anchor 문서가 나중에 AMENDS chain의 원본으로 확인될 수
있으므로, 근거 문서가 있는 모든 draft는 split을
`PROVISIONAL_UNTIL_CHAIN_CLOSURE`로 표시합니다. 관계 검수 후 각 anchor의
`known_chain_ids`를 채우고 문서·chain 누수 검사를 다시 통과한 뒤
`LOCKED_BY_CHAIN`으로 전환합니다. 문서가 없는지 묻는 coverage 질문만
`LOCKED_BY_COVERAGE`를 사용할 수 있습니다.

`holding_within_report_change`는 한 대량보유보고서 내부에 함께 공시된 직전보고와
이번보고의 보유주식수·비율 비교를 뜻합니다. 이는 정정 전/후를 의미하는
`correction_chain`과 구분합니다. 전자는 답변 작성에 relation이 필요하지 않지만,
split 확정에는 다른 문서와 마찬가지로 chain closure가 필요합니다.

## Usage freeze and late chain discovery

작성 큐와 실행 이력은 분리합니다. 작성 큐는 재현 가능한 계획이며, 담당자 C의
Usage Ledger가 assignment가 실제로 언제 어떤 목적으로 사용됐는지 기록하는 유일한
기준입니다.

실행 규칙은 다음과 같습니다.

1. `PROVISIONAL_UNTIL_CHAIN_CLOSURE`는 공식 DEV/HOLDOUT 실행을 거부합니다.
2. 조기 확인은 `SANDBOX`에서만 가능하며 모델 선택 지표에 포함하지 않습니다.
3. DEV_TUNE에 한 번 사용된 assignment는 `tuning_locked`로 간주하고 다른 독립
   split으로 재배치하지 않습니다.
4. 늦게 발견된 chain이 여러 split을 연결하면 전체 chain component를 가장 많이
   노출된 split으로 내립니다: `DEV_TUNE > DEV_CHECK > HOLDOUT` 순으로 오염도가 큽니다.
5. DEV_TUNE과 연결된 기존 HOLDOUT/DEV_CHECK 항목은 해당 set에서 제거하고 같은
   critical slice의 미사용 chain으로 backfill합니다.
6. FINAL_HOLDOUT 사용 후 새 연결이 발견되면 해당 component의 HOLDOUT 결과를
   폐기하고 새 미사용 chain으로 교체해 최종 평가를 다시 수행합니다.

Usage event는 append-only이며 삭제·수정하지 않습니다. 현재 상태인
`first_used_at`, `used_run_ids`, `tuning_locked`는 event를 집계해 계산합니다.

## Required question fields

`example.question.json`을 복사해 작성합니다. 특히 다음을 지킵니다.

1. `gold_chunk_ids`를 만들지 않습니다.
2. 각 slot은 `document_id`, `source_locator`, `evidence_span`을 가집니다.
3. 숫자는 값뿐 아니라 단위·기간·scope·period type·version slot을 둡니다.
4. 사건 질문은 latest version과 termination/confirmation 상태를 별도 slot으로 둡니다.
5. 답할 수 없는 질문도 `expected_answerability`와 reason을 Gold로 만듭니다.
6. Gold v0.2의 `required_fact_slots`는 2인 검수 후 `GOLD_LOCKED`로 잠그고
   canonical SHA-256을 저장합니다. 변경이 필요하면 기존 Gold를 덮어쓰지 않고
   `gold_revision`을 올립니다.
7. `route_policy`는 Fact Coverage Snapshot 상태에 따른 불변 정책입니다. 시스템이
   스스로 보고한 coverage로 경로 허용 범위를 넓힐 수 없습니다.
8. 자유 서술형 추론문은 채점하지 않습니다. route, operation, 선택된 Fact/Event,
   계산 입력·식·결과, validator 결과만 구조적으로 채점합니다.
9. `applicable_fact_coverage_states`에는 해당 질문에서 도달 가능한 상태만 선언하며,
   각 상태는 `route_policy`에 정확히 한 번 매핑되어야 합니다. 전역 9개 상태를 모든
   질문에 복제하지 않습니다. 선언되지 않은 상태가 런타임에 나오면 실행기는 답을
   생성하지 않고 Gold/snapshot 불일치로 실패 처리합니다.
10. `EARLY_EXIT`은 죽은 route가 아니라 ZERO_DOCUMENT, PARSE_BLOCKED,
    OUT_OF_SCOPE, CONFLICTING_VERIFIED_FACTS처럼 검색·계산을 계속하면 안 되는 상태의
    fail-closed 종단입니다.

## Question taxonomy

| 유형 | 필수 검수 항목 |
|---|---|
| `SIMPLE_LOOKUP` | 기업·문서·기간·단일 근거 |
| `NUMERIC_LOOKUP` | 단위, 연결/별도, 분기/누계, 최신 버전 |
| `COMPARISON_CALC` | old/new 양쪽 근거, 식, 0·음수 처리 |
| `EVENT_TRACE` | event/chain, AMENDS/TERMINATES/CONFIRMS, as-of |
| `NARRATIVE_MULTI_DOC` | 주장별 근거 slot과 완결성 |
| `ANSWERABILITY` | ZERO_DOCUMENT/PARSE_FAILED/WITHHELD/N_A/OOS 구분 |
| `POLICY_SAFETY` | 투자권유·미래예측·외부정보 요청 차단 |

## Critical slices

각 독립 split에 다음 slice가 최소 한 번 이상이 아니라, 통계적으로 비교 가능한
수준으로 포함됐는지 카운트합니다.

- 동일 기업 다른 연도 hard negative
- 원본·정정·해지 chain
- 연결/별도
- 분기/누계
- 공시 유보와 유보기한
- 예정/잠정/확정
- 문서 0건
- parse failure
- 기존값 0, 음수, 흑자·적자 전환
- 회사 공식명과 통용명 불일치
- 동일 metric·기간·scope의 해소 불가능한 검수 Fact 충돌

### CONFLICTING_EVIDENCE 운영 규칙

Fact 추출 중 동일 `corp_code × metric_code × period × scope`에 둘 이상의 검수값이
발견되면 먼저 정정 버전, 질문 기준일, 연결/별도, 분기/누계, 단위를 정규화합니다.
이 과정을 거쳐도 authoritative Fact가 둘 이상 남을 때만
`CONFLICTING_VERIFIED_FACTS` 후보로 등록합니다.

- 자연 발생 사례는 `conflicting_evidence` 태그의 Gold로 최소 3~5건 작성합니다.
- 자연 발생 사례가 없다면 충돌을 인위적으로 Gold에 만들지 않습니다.
- 그 경우 `fixtures/conflicting-evidence.question.json`으로 조기 종료와
  `CONFLICTING_EVIDENCE` 매핑을 검증합니다. 이 파일은 실제 Gold 점수에 포함하지 않습니다.
- 충돌 상태를 숫자 하나로 임의 병합하거나 HCX에게 선택시키지 않습니다.

## A/B reproducibility rule

같은 실험 round의 모든 비교 실행은 동일한 `fact_coverage_snapshot_id`를 사용합니다.
Fact 추출이 진전되어 snapshot이 바뀌면 새 round를 시작합니다. 따라서 검색 개선과
Fact coverage 증가가 하나의 점수 변화에 섞이지 않습니다.

## Two-person review

Gold 작성자와 검수자는 달라야 합니다.

### Author

- 원문을 직접 열어 `source_locator`와 span 기록
- Fact/Event/Version slot 작성
- 정답과 answerability 작성

### Reviewer

- manifest 등록 문서인지 확인
- 동일 chain의 모든 관련 공시를 확인
- 정정 전 값을 Gold로 선택하지 않았는지 확인
- 수치·단위·scope·period type을 원문과 대조
- evidence span이 답을 직접 지지하는지 확인
- 외부 지식이 섞이지 않았는지 확인

검수 완료 전 상태의 질문은 DEV나 HOLDOUT에 넣지 않습니다.

## Validation

JSON 객체 한 개, JSON 배열, JSONL을 모두 검수할 수 있습니다.

```bash
npm run eval:validate -- domain/evaluation/example.question.json
npm run eval:validate -- path/to/evaluation.jsonl
```

검수기는 필수 필드, enum, 중복 question ID, `gold_chunk_ids` 사용, 동일 chain의
split leakage를 실패로 처리합니다.

## Parse-blocked authoring

작성 큐를 생성할 때 document-level parse coverage를 함께 전달한다. 필요한 anchor 중
하나라도 `PARSE_FAILED`이면 해당 assignment는 삭제하지 않고 `PARSE_BLOCKED`로
표시한다. 현재 processing snapshot의 정보한계 테스트로 사용하되, PDF parser 등으로
복구되면 새 snapshot에서 evidence Gold를 다시 검수한다.
