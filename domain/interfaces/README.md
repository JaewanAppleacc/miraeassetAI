# Team Interface Contract v0.1

## A → B: DocumentIR

담당자 A가 파싱 성공 여부와 함께 제목·문단·표·원문 위치를 전달합니다. B는 원본
파일을 다시 임의 파싱하지 않고 이 계약을 통해 Fact/Event/Evidence를 생성합니다.
`FAILED` 파일이 포함될 수 있으며, B는 이를 값 없음으로 해석하지 않습니다.

## B → C: Semantic Bundle

담당자 B가 의미가 부여된 Fact/Event/Relation/Evidence를 전달합니다. C는
`verification_status=VERIFIED`만 정답 경로에 사용할 수 있고 candidate 성능은 별도
실험으로 측정합니다. v0.2부터 Event와 Relation도 필드 단위로 검증하며 선언되지
않은 필드는 거부합니다. 문서유형별 가변 정보는 임의 최상위 필드가 아니라
`attributes`에 저장합니다.

## B → C: Verified Fact Coverage Snapshot

`fact-coverage-snapshot.schema.json`은 특정 시점에 어떤 Fact slot이 사람 검수를
통과했는지 고정합니다. C는 route policy 판정에 이 snapshot만 사용하며 런타임
시스템의 자기 보고를 신뢰하지 않습니다. `WITHHELD`, `NOT_APPLICABLE`,
`CONFLICTING_VERIFIED_FACTS`도 단순 미발견과 구분합니다.

## C-owned experiment run

`experiment-run.schema.json`의 동일한 `experiment_round_id`에 속하는 A/B 실행은
`corpus_snapshot_id`, `parser_version`, `gold_revision`,
`fact_coverage_snapshot_id`를 동일하게 고정해야 합니다. 중간에 Fact coverage가
갱신되면 기존 라운드에 섞지 않고 새 round를 만듭니다.

## Agent → Evaluation Harness: FinalResponse

`final-response.schema.json`은 `domain/runtime/agent-runtime.mjs`의
`createSerializer()`가 반환하는 `final_response`(question/retrieved_context/
think_trace/answer) 형식을 Agent와 외부 Evaluation Harness가 함께 쓰는 단일
기계 계약으로 고정합니다. `execution_trace`는 이 스키마에 포함되지 않습니다 —
`runAgentFlow`의 반환값에서 `final_response`와 나란히 있는 별도 필드입니다.
Harness는 자체적인 수동 응답 검증 규칙을 새로 만들지 않고
`domain/runtime/final-response-validator.mjs`의 `validateFinalResponse()`(또는
이 스키마 파일 자체)를 그대로 사용해야 합니다. `createSerializer()`의 정상
출력과 `SAFE_RESPONSE_FALLBACK`은 모두 이 스키마를 만족하도록 Runtime에 직접
연결돼 있습니다(`tests/final-response-validator.test.mjs`,
`tests/agent-runtime.test.mjs` 참고).

## Agent → External Caller: Answer Wire Response (organizer API notice)

`answer-wire-response.schema.json`은 `GET /answer`가 외부에 반환하는 실제 HTTP wire body를
고정합니다 — `question_id`/`question`/`retrieved_context`/`think_trace`/`answer` 5개
문자열 필드뿐이며 `additionalProperties: false`입니다. 이것은 `final-response.schema.json`
(내부, `retrieved_context`는 배열·`think_trace`는 객체)과 **다른 스키마**입니다. 내부
Runtime Host와 AgentFlow는 여전히 `final-response.schema.json` 모양의 FinalResponse를
주고받으며, 이번 변경은 FROZEN v1.1 내부 계약이 아니라 이 외부 wire 경계만 바꿉니다.

`domain/runtime/answer-wire-response.mjs`가 두 모양을 잇는 유일한 변환 지점입니다.

- `toAnswerWireResponse(questionId, finalResponse)`: 내부 FinalResponse → wire body.
  `retrieved_context`/`think_trace`는 항상 `JSON.stringify()`로 인코딩합니다 — 이 인코딩
  방식은 고정이며 호출자가 선택할 수 없습니다.
- `fromAnswerWireResponse(wire)` / `fromAnswerWireResponseSafe(wire)`: wire body → 내부
  FinalResponse 모양(Evaluation Harness의 기존 metric 채점 입력 형식). `JSON.parse()` 실패는
  `fromAnswerWireResponseSafe`에서 예외 없이 `{ ok: false }`로 처리됩니다.
- `question_id`는 요청 경계(query parameter)가 정본입니다. FinalResponse에는 애초에
  `question_id` 필드가 없으므로 runner/Flow가 이를 자가 선언할 방법이 없습니다.

`domain/runtime/final-response-validator.mjs`의 `validateFinalResponse()`를 이 외부 wire
body에 직접 적용하지 않습니다 — 항상 실패합니다(모양이 다름). wire body 자체를 검증할
때는 `domain/runtime/answer-wire-response.mjs`의 `validateAnswerWireResponse()`/
`isValidAnswerWireResponse()`를 사용합니다. 자세한 HTTP 상태 코드·타임아웃·재시도 정책은
`domain/evaluation-harness/README.md`를 참고하세요.

## Compatibility

- minor field 추가는 `schema_version`의 minor 증가와 함께 허용합니다.
- 필드 삭제·의미 변경은 major 증가 없이는 금지합니다.
- 모든 artifact는 `corpus_snapshot_id`, producer/parser version을 기록합니다.
- ID를 다른 팀이 재생성하지 않고 `domain/contracts.mjs` 구현을 사용합니다.
- Gold와 Semantic Bundle의 최상위 객체는 `additionalProperties=false`입니다. 확장
  정보는 명시된 `extensions`, `attributes`, `metadata` 안에서만 허용합니다.

## C-owned evaluation usage ledger

`evaluation-authoring-queue.jsonl`은 재생성 가능한 불변 계획 파일이므로
`first_used_at`이나 `tuning_locked` 같은 가변 상태를 기록하지 않습니다. 담당자 C는
각 실행 직전에 `evaluation-usage-event.schema.json` 형식의 append-only event를
별도 ledger에 기록합니다.

공식 실행기는 `LOCKED_BY_CHAIN` 또는 `LOCKED_BY_COVERAGE`만 DEV_TUNE/DEV_CHECK/
HOLDOUT에 사용할 수 있습니다. provisional 질문을 조기 실험할 필요가 있으면
`usage_kind=SANDBOX`, `executed_split=SANDBOX`로만 실행하며 그 결과를 공식 지표나
모델 선택에 사용할 수 없습니다.
