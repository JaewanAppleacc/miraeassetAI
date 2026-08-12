# Evaluation Harness

배포 Agent의 HTTP API(`GET /answer`)를 블랙박스로 호출하는 독립 평가 실행기다. Agent 내부
Flow/모듈은 어디에서도 import하지 않는다.

```bash
node scripts/run-evaluation-harness.mjs path/to/config.json
node --test tests/evaluation-harness.test.mjs
```

## GET /answer 공식 Wire 계약 (주최측 API 공지 반영)

경로는 고정이다. 인증 헤더는 요구하지 않는다.

```text
GET /answer?question_id=Q-001&question=평가질의
```

- `question_id`, `question`은 각각 정확히 1개, 문자열, 공백이 아닌 값이어야 한다. 누락·빈
  값·중복은 `400`이다.
- 실제 공개 Endpoint URL은 **아직 배포되지 않았다 — TODO**. 이 문서와 config 예시의
  `base_url`은 항상 로컬/테스트 서버를 가리키며, 가짜 프로덕션 주소를 넣지 않는다.

응답은 항상 다음 5개 문자열 필드만 가진 JSON이다(`domain/interfaces/
answer-wire-response.schema.json`, `additionalProperties: false`):

```json
{
  "question_id": "Q-001",
  "question": "평가질의",
  "retrieved_context": "[]",
  "think_trace": "{\"execution_mode\":\"EARLY_EXIT\",\"operations\":[],\"calculation\":{},\"validation\":{}}",
  "answer": "..."
}
```

`retrieved_context`와 `think_trace`는 내부 FinalResponse의 배열/객체를 **JSON.stringify한
문자열**이다 — 배열이나 객체가 아니라 문자열 그 자체가 wire 값이다. 호출자는 반드시
`JSON.parse()`로 복원해야 한다. 이 인코딩 방식은 고정이며 바뀌지 않는다.
`domain/runtime/answer-wire-response.mjs`의 `toAnswerWireResponse`/`fromAnswerWireResponse`가
유일한 변환 지점이다. `think_trace`에는 구조화된 필드(execution_mode/operations/
calculation/validation)만 들어가며, 숨겨진 chain-of-thought·시스템 프롬프트·비밀값·raw
`execution_trace`는 절대 포함되지 않는다.

HTTP 상태 코드:

| 상태 | 의미 |
|---|---|
| `200` | 정상 응답, 정보한계, Policy Guard 거부, 정상 EARLY_EXIT — 모두 "유효한 응답이 생성됨" |
| `400` | `question_id`/`question` 파라미터 오류 |
| `503` | 이 handler 자체의 내부 deadline(290초) 초과, 또는 runner의 일시적 throw/rejection |

malformed runner response나 request-question mismatch처럼 재시도로 해결되지 않는 계약
결함은 `200`의 safe EARLY_EXIT으로 남는다(`503`으로 승격하지 않는다) — 재시도가 의미
있는 실패(타임아웃/일시 오류)와, 재시도해도 절대 고쳐지지 않는 계약 결함을 상태 코드
레벨에서 구분한다.

타임아웃/재시도(공식 호출 시뮬레이션 기준):

- 공식 클라이언트 타임아웃: **300초**
- 이 handler 자체의 내부 deadline: **290초**(`DEFAULT_TIMEOUT_MS`) — 클라이언트가
  타임아웃하기 전에 항상 먼저 `503`으로 안전하게 반환하기 위한 여유
- 타임아웃 또는 HTTP 5xx만 최대 **2회 재시도**(총 3회 시도). 4xx, 2xx 계약 오류, question
  echo mismatch는 재시도하지 않는다. 모든 재시도는 동일한 `question_id`/`question`을
  보낸다

## 계약 소스

Gold 검증(`gold-loader.mjs`), Answer Wire Response 검증(`harness-runner.mjs`), Usage
Ledger 예약(`harness-runner.mjs`)은 전부 이 저장소의 현재 코드를 직접 import한다 — 번들된
복사본이 아니다.

- `domain/contracts.mjs`
- `domain/runtime/evaluation-usage-ledger.mjs`
- `domain/runtime/answer-wire-response.mjs` (`domain/interfaces/answer-wire-response.schema.json`가 검증)
- `domain/evaluation/evaluation-gold.v0.2.schema.json` (`domain/contracts.mjs`가 검증)

내부 `domain/runtime/final-response-validator.mjs`는 이 Harness가 실제 wire body에 직접
적용하지 않는다 — 그 스키마는 내부 FinalResponse(배열/객체) 모양이고, wire body는 항상
5개 문자열 필드이기 때문이다. `harness-runner.mjs`는 `validateAnswerWireResponse()`로 wire
모양을 확인한 뒤 `fromAnswerWireResponseSafe()`로 JSON 문자열을 복원해 기존 metric 채점
입력 형식(내부 FinalResponse 모양)으로 변환한다. 문자열 파싱이 실패하면 예외를 던지지
않고 `response_usable=false`로 기록한다.

## Config

`scripts/run-evaluation-harness.mjs <config.json>`가 받는 JSON 필드:

| 필드 | 필수 | 설명 |
|---|---|---|
| `base_url` / `answer_path` / `question_parameter` | 항상 | `GET {base_url}{answer_path}?{question_parameter}=...&{question_id_parameter}=...` |
| `question_id_parameter` | 선택(기본 `"question_id"`) | Gold의 `question_id`를 실어 보내는 query parameter 이름 |
| `gold_path` / `result_path` / `summary_path` | 항상 | 서로 다른 경로여야 하며 `lifecycle_path`/`ledger_path`와도 겹칠 수 없다 |
| `split` | 항상 | `SANDBOX`/`DEV_TUNE`/`DEV_CHECK`/`HOLDOUT` |
| `run_purpose` | 항상 | `domain/contracts.mjs`의 `RUN_PURPOSES`, `RUN_PURPOSE_TO_SPLITS`로 `split`과의 조합을 검증 |
| `timeout_ms` / `concurrency` | 항상 | 양의 정수. 공식 시뮬레이션 값은 `timeout_ms=300000`, `concurrency=1` |
| `retries` | 선택(기본 `2`) | 음수·정수가 아닌 값은 거부. 타임아웃 또는 HTTP 5xx만 재시도 대상이며, 총 시도 횟수는 `1 + retries`다 |
| `configuration_sha256` | 항상 | 64자리 소문자 hex |
| `git_commit` | 항상 | 40자리 소문자 hex(전체 SHA) |
| `lifecycle_path` / `ledger_path` | `SANDBOX`/`DEV_CHECK`/`HOLDOUT`에서 필수, 그 외 split도 둘 중 하나만 주면 거부 | `lifecycle_path`는 문항별 `EvaluationSplitLifecycle` 객체의 JSON 배열이며 `assignment_id`는 `question_id` 또는 `evaluation_group_id`로 조회 가능해야 한다 |
| `sandbox_allowlist` | 선택 | `split="SANDBOX"`일 때만 의미 있음 — 아래 "SANDBOX 신뢰 경계" 참고. **독립 승인 권한이 아니라 필터다** |
| `headers_env_prefix` | 선택 | 이 prefix로 시작하는 환경변수만 요청 header로 사용한다(`_` → `-`). config 파일 자체에 비밀 header를 넣지 않는다. 별도 인증 헤더의 기본값은 없다 |
| `run_id` | 선택 | 생략 시 무작위 생성 |
| `lock_timeout_ms` | 선택(기본 5000) | ledger를 쓰는 모든 실행의 cross-process exclusive lock 대기 상한 — 아래 참고 |

재시도는 새로운 평가 노출(exposure)이나 run으로 세지 않는다 — Usage Ledger 예약은
assignment당 정확히 한 번만 수행되고(HTTP 재시도 횟수와 무관), 실제 결과
artifact(`result_path`)의 각 레코드에는 `attempt_count`와 각 시도의 `{attempt, http_status,
timed_out}`만 기록된다. 질문 원문이나 secret은 이 재시도 기록에도, 다른 오류 로그에도
중복 노출되지 않는다.

## SANDBOX 신뢰 경계

`split="SANDBOX"`는 Gold 파일의 레코드를 암묵적으로 로드하지 않는다. **SANDBOX 실행
자격은 오직 검증된, 아직 확정되지 않은(provisional) Split Lifecycle 레코드에서만
나온다** — `domain/runtime/evaluation-usage-ledger.mjs`의 `canUseSplit`이 이미 강제하는
규칙과 정확히 같다: "PROVISIONAL_UNTIL_CHAIN_CLOSURE 상태인 배정은 `assigned_split`과
무관하게 SANDBOX로만 실행할 수 있다. 한 번 잠기면(LOCKED_BY_CHAIN/LOCKED_BY_COVERAGE)
`assigned_split`이 절대적이 되고 SANDBOX는 더 이상 쓸 수 없다."

1. `lifecycle_path`의 각 레코드는 `domain/contracts.mjs`의
   `validateEvaluationSplitLifecycle`로 먼저 검증한다. `assigned_split`은
   `EvaluationSplitLifecycle` 계약상 `DEV_TUNE`/`DEV_CHECK`/`HOLDOUT`만 유효한
   값이다(`SANDBOX`는 유효한 `assigned_split` 값이 아니며, 그렇게 적힌 레코드는
   검증에서 거부되고 아무 자격도 부여하지 않는다).
2. 검증을 통과한 레코드 중 `split_lock_status === "PROVISIONAL_UNTIL_CHAIN_CLOSURE"`인
   문항만 SANDBOX 실행 후보가 된다. `LOCKED_BY_CHAIN`/`LOCKED_BY_COVERAGE`인 문항은 —
   그 문항의 진짜 `assigned_split`이 무엇이든 — SANDBOX 후보에서 제외된다.
3. `sandbox_allowlist`는 이 후보 집합을 **좁히기만** 한다. 이미 후보가 아닌 문항의
   `question_id`를 allowlist에 넣어도(예: 잠긴 HOLDOUT/DEV_CHECK 문항) 절대 로드되지
   않는다 — allowlist는 독립적인 승인 권한이 아니다.

위 세 조건 중 하나라도 충족하지 못하면(lifecycle 자체가 없거나, 검증에 실패하거나,
PROVISIONAL이 아니거나) SANDBOX는 **0건**을 로드한다 — "판단할 수 없으면 전부 허용"이
아니라 "판단할 수 없으면 전부 거부"다. `gold-loader.mjs`의
`loadGold(path, split, { sandboxAllowlist, lifecycle })`가 이 로직을 담당한다.

SANDBOX도 이제 `lifecycle_path`·`ledger_path`가 config 단계에서 필수이며, 실제 HTTP
호출 전에 `canUseSplit`/`appendUsageEvent`/durable append를 거쳐야 한다 —
DEV_CHECK/HOLDOUT과 동일한 예약 순서(아래 "Usage Ledger 예약 순서" 참고)를 따르고,
프로세스 간 exclusive lock(아래 참고)도 동일하게 적용된다.

문항에 대응하는 lifecycle 레코드가 아예 없으면 그 문항은 조용히 SANDBOX 대상에서
제외된다(기존 fail-closed 정책). 그러나 레코드가 **존재하는데** `validateEvaluationSplitLifecycle`
검증에 실패하면(스키마 위반, 손상된 파일 등) `loadGold`는 조용히 0건으로 처리하지 않고
**명시적 에러를 던져 전체 로드를 중단한다** — "찾을 수 없음"과 "찾았는데 망가짐"은 서로
다른 사실이고, 후자를 전자처럼 취급하면 운영자가 눈치채지 못한 채 SANDBOX 집합이
조용히 비거나 줄어들 수 있기 때문이다.

## response_usable 게이트

각 문항의 metric은 다음 세 조건을 모두 만족할 때만 계산된다.

```text
response_usable = (HTTP 2xx) AND (FinalResponse가 스키마에 유효함) AND (response.question이 요청한 질문과 정확히 일치)
```

셋 중 하나라도 거짓이면 `metric_results`는 빈 객체이고, 그 문항은 항상
`summary.failed_question_ids`에 포함된다. 예를 들어 HTTP 500이 우연히 스키마상 유효한
FinalResponse 본문을 실어 보내거나, HTTP 200이 다른 질문에 대한(그러나 스키마상 유효한)
답을 실어 보내는 경우 — 둘 다 metric이 계산되지 않고 실패로 집계된다.
`results[i].response_usable`에 boolean으로 기록된다.

## Usage Ledger 예약 순서와 durability

`lifecycle_path`가 있으면(=`DEV_CHECK`/`HOLDOUT`이거나, 그 외 split에서 운영자가 명시적으로
지정한 경우) 문항마다 다음 순서를 지킨다.

1. `canUseSplit` + `appendUsageEvent`로 노출 예약 이벤트를 만든다(`runOutcome`은 항상
   `"FAILURE"` — 아래 "알려진 한계" 참고).
2. `domain/evaluation-harness/durable-ledger.mjs`의 `appendEventLineDurable`로 그 이벤트
   한 줄을 `ledger_path`에 append하고 **`fsyncSync`로 강제 flush한다.** (`domain/runtime/
   evaluation-usage-ledger.mjs`의 `appendEventLineAtomic`은 O_APPEND로 한 줄 단위 원자성은
   보장하지만 fsync를 호출하지 않아 durable을 자처할 수 없다 — 이 Harness는 그 함수 대신
   자체 fsync 경로를 쓴다. 이 저장소의 Runtime 코드는 이 작업 범위에서 수정하지 않았다.)
3. 예약이 fsync까지 끝난 뒤에만 `GET /answer`를 호출한다.
4. 예약 자체가 실패하면(예산 소진, lifecycle 불일치 등) 이 문항은 HTTP 요청을 0회 보낸다.

`appendEventLineDurable`은 `writeSync`의 반환 바이트 수를 확인해, 한 번의 호출이
JSONL 한 줄 전체를 쓰지 못하는(short write) 경우에도 남은 바이트를 계속 이어 쓴다.
`writeSync`가 0 이하를 반환하면(예: 디스크 풀 상황에서 예외 없이 0을 반환하는 경우) 그
자리에서 `written`이 늘지 않아 무한 반복할 수 있으므로, 이 경우는 계속 시도하지 않고
즉시 명시적 에러를 던진다 — 이 에러는 HTTP 호출보다 먼저 발생하므로 그 문항은 HTTP
요청을 보내지 않는다. 또한
`ledger_path`가 처음 생성되는 순간(파일이 아직 없던 경우)에는 파일 자체의 fsync에 더해
**부모 디렉터리도 열어서 fsync**한다 — POSIX에서 파일 내용의 durability와 "그 파일명이
디렉터리에 존재한다"는 사실의 durability는 별개이기 때문이다. 이미 존재하는 ledger
파일에 이어 쓸 때는 파일 fsync만 하고 디렉터리는 다시 fsync하지 않는다(새 디렉터리
엔트리가 생기지 않으므로).

동시성(`concurrency`)이 있어도 예약 단계는 내부 직렬 큐로 순서를 보장해, **같은 프로세스
안의** 여러 worker가 동시에 같은 ledger에 append해도 해시 체인이 깨지지 않는다.

### ledger를 쓰는 모든 실행의 cross-process exclusive lock

위 직렬 큐는 한 프로세스 내부의 동시성만 막는다 — 서로 다른 두 `node
scripts/run-evaluation-harness.mjs` 프로세스가 같은 `ledger_path`를 동시에 실행하는 것은
막지 못한다. **`needsExclusiveLock`는 곧 `usesLedger`다** — `split`이 무엇이든(`SANDBOX`
포함) `lifecycle_path`(따라서 `ledger_path`도, config 단계에서 항상 함께 요구된다)를 쓰는
실행이면 예외 없이 이 락이 걸린다. 두 프로세스가 같은 ledger 파일의 같은 hash-chain
꼬리를 동시에 읽고 각자 `previous_log_hash`가 그 꼬리를 가리키는 이벤트를 append하면
단순 중복이 아니라 **체인이 분기**되고, `validateUsageLedger`는 사후에 이를 봉합할 방법이
없다 — DEV_CHECK/HOLDOUT처럼 예산이 제한된 split만이 아니라 SANDBOX나 opt-in DEV_TUNE도
동일하게 이 위험에 노출되므로 예외를 두지 않는다.

`runHarness`는 실행 시작 시 `${ledger_path}.lock` 파일을 `wx`(O_CREAT|O_EXCL) 플래그로
원자적으로 생성해 OS 수준의 상호 배제 락을 걸고, 실행 전체(모든 예약 + 마지막 HTTP
응답까지) 동안 보유한 뒤 정상 종료·예외 종료 관계없이 `finally`에서 반드시
해제한다(`domain/evaluation-harness/durable-ledger.mjs`의
`acquireExclusiveLock`/`releaseExclusiveLock`). 락을 이미 다른 프로세스가 쥐고 있으면
`lock_timeout_ms`(기본 5000ms) 동안 폴링하며 대기하다가, 그래도 얻지 못하면
`LEDGER_LOCK_TIMEOUT` 에러로 **fail-closed**한다 — 이 경우 그 실행은 HTTP 요청을 단 한
건도 보내지 않는다(SANDBOX·DEV_TUNE을 포함해 ledger를 전혀 쓰지 않는 실행은 애초에 락
대상이 아니므로 영향받지 않는다).

죽은 프로세스가 남긴 stale lock은 자동으로 회수하지 않는다(다른 프로세스가 단지 느린
것인지 정말 죽은 것인지 시간만으로는 구분할 수 없기 때문). 다른 Harness 프로세스가 없음을
직접 확인한 뒤 `${ledger_path}.lock` 파일을 수동으로 지워야 한다.

## Summary 필드

`summary.json`에는 더 이상 모호한 단일 `success` 필드가 없다. 대신:

| 필드 | 의미 |
|---|---|
| `api_success` | HTTP 상태가 2xx인 문항 수 |
| `contract_success` | FinalResponse가 스키마에 유효한 문항 수 (HTTP 상태·question 일치와 무관) |
| `response_usable` | 위 `response_usable` 게이트를 통과해 실제로 채점된 문항 수 |
| `metric_pass` / `metric_fail` / `not_scored` / `review_required` | `response_usable`인 문항들의 `metric_results` 안 모든 개별 metric 결과를 상태별로 합산한 값. "채점되지 않음(NOT_SCORED)"과 "사람 판단 필요(REVIEW_REQUIRED)"를 "성공"으로 오독할 수 없다 |
| `reservation_failures` / `question_echo_mismatches` / `timeouts` / `http_errors` / `contract_errors` | 기존 진단 필드, 변경 없음 |

## 알려진 한계

- **Usage Event 스키마에는 "예약됨(pending)" outcome이 없다.** `runOutcome`은 `SUCCESS`/
  `FAILURE`뿐이고 ledger는 append-only(이벤트 수정·같은 run_id+assignment_id 중복 append
  모두 금지)라, HTTP 호출 전에 미리 적어 둔 예약 이벤트를 나중에 진짜 결과로 "갱신"할 방법이
  없다. 그래서 예약은 항상 `FAILURE`로 기록하고, 실제 HTTP 상태·계약 검증·metric 채점 같은
  진짜 결과는 완전히 별도 파일(`result_path`/`summary_path`)에만 남긴다. 이 모듈 자체의
  정책 문서가 "예산 소비는 최종 outcome과 무관하다"고 명시하므로 이 설계와 모순되지 않는다.
- `open-metric.mjs`의 `claim_coverage`는 항상 `REVIEW_REQUIRED`다 — 자유서술 claim의
  paraphrase 일치를 블랙박스 문자열 비교로 판정하지 않는다.
- `requested_format`은 현재 Gold 스키마에 형식 요구사항 필드가 없어 항상 `NOT_SCORED`다.
- cross-process lock은 파일시스템이 `O_EXCL`을 원자적으로 지원하는 로컬/POSIX 볼륨을
  전제한다. 네트워크 파일시스템(NFS 등)에서는 `O_EXCL` 원자성이 항상 보장되지 않으므로,
  `ledger_path`는 로컬 디스크에 두는 것을 권장한다.
