# 내 Agent를 팀 평가 하니스에 붙이는 법

실제로 붙여서 25문항 채점까지 받아본 절차다(2026-08-31). 걸렸던 곳을 전부 적었다 —
이거 없이 하면 같은 데서 막힌다.

---

## 0. 준비물

| 필요한 것 | 비고 |
|---|---|
| Node.js | 하니스가 ESM 스크립트다 |
| `ajv`, `ajv-formats` | **이 둘뿐이다.** Next·React·drizzle 전부 불필요 |
| Gold v0.2 jsonl | seed 25문항: 릴리스 번들 안 / seed 밖 18문항: `data/eval/newq_gold.v0.2.jsonl` |
| 내 Agent 서버 | `GET /answer` 지원 필요 |

```bash
npm install ajv@8 ajv-formats@3 --no-save
```

> WSL 경로(`\\wsl.localhost\...`)에서 npm이 실패하면 하니스를 Windows 로컬 폴더로
> 복사해서 실행한다. npm이 UNC 경로에서 cwd를 못 잡는다.

---

## 1. 응답 계약 — 문자열 5개

```
GET /answer?question_id=...&question=...
->
{
  "question_id": "...",       // 요청이 준 값 그대로 (요청 경계가 권위다)
  "question": "...",
  "retrieved_context": "[...]",   // 배열을 JSON.stringify한 "문자열"
  "think_trace": "{...}",         // 오브젝트를 JSON.stringify한 "문자열"
  "answer": "..."
}
```

`retrieved_context`와 `think_trace`는 **문자열이다.** 배열/오브젝트로 보내면 계약 위반.

---

## 2. 여기서 막힌다 — 실제로 걸린 것 4개

### ① `execution_mode`는 4개 값만 허용

```
STRUCTURED | RETRIEVAL | BOTH | EARLY_EXIT
```

**계약 문서에 안 적혀 있다.** 우리 경로 이름을 그대로 넣었더니 25건 전부
`contract_errors`가 났다(`/think_trace/execution_mode must be equal to one of the allowed values`).
검색으로 답하면 `RETRIEVAL`, 근거를 못 찾았으면 `EARLY_EXIT`.

### ② `source_locator` 형식이 정해져 있다

```
{doc_id}/{접수번호}.xml#node={노드번호}
예) exchange_20230428800439/20230428800439.xml#node=0
```

Gold의 `acceptable_sources`가 이 형식이라, **문서 id와 인용문이 맞아도 위치 표기가
다르면 근거로 인정되지 않는다.** 우리는 이걸 맞추자 evidence가 0 PASS → 5 PASS로 올랐다.
접수번호는 doc_id 뒤쪽에 그대로 들어 있다.

### ③ 숫자는 `think_trace.calculation.result` **안쪽**만 읽는다

```js
// closed-metric.mjs
const calc = response?.think_trace?.calculation ?? {};
return calc.result !== undefined ? calc.result : calc.value;
```

최상위에 `contract_amount`를 늘어놔도 **안 읽는다.** `result`를 오브젝트로 만들어
그 안에 필드를 넣어야 한다.

```json
"calculation": { "result": { "contract_amount": 635384978972 } }
```

그리고 **답변 문장에서 숫자를 긁지 않는다** — 일부러 그렇게 설계돼 있다("2025년 매출은
100억원"에서 첫 숫자는 연도라서). 구조화해서 안 주면 `NOT_SCORED`다.

### ④ `retrieved_context`의 인용문은 **정확히 같아야** 한다

Gold의 `evidence_span`은 값 하나(`"635,384,978,972"`)인 경우가 많다. 줄 전체를 인용하면
불일치다. 우리는 줄 전체와 값만 담은 항목을 **둘 다** 실었다 — 둘 다 원문에서 온 것이라
지어낸 게 아니다.

---

## 3. 설정 파일

손으로 sha256 채우지 말고 생성기를 쓴다.

```bash
python scripts/make_harness_config.py \
    --gold run/newq_gold.jsonl \
    --base-url http://127.0.0.1:8000 \
    --out run/config.json
```

**split과 run_purpose 조합 주의**

| split | run_purpose | lifecycle·ledger 필요 |
|---|---|---|
| **DEV_TUNE** | **FLOW_SELECTION** | **불필요** ← 이걸로 시작 |
| DEV_CHECK | CRITICAL_REGRESSION_CHECK | 필요 |
| HOLDOUT | FINAL_HOLDOUT_EVALUATION | 필요 |
| SANDBOX | SANDBOX_EXPLORATION | 필요 |

`lifecycle_path`/`ledger_path` 없이 돌리려면 **DEV_TUNE + FLOW_SELECTION**이다.

---

## 4. 실행

```bash
# 1) 내 서버 띄우기
python -m uvicorn dart_detective.api:app --host 127.0.0.1 --port 8000

# 2) 하니스 실행
node scripts/run-evaluation-harness.mjs run/config.json
```

---

## 5. 결과 읽는 법

```json
{
  "api_success": 25,        // HTTP가 성공했나
  "contract_success": 25,   // 응답이 계약을 지켰나  <- 여기가 0이면 형식 문제
  "response_usable": 25,
  "metric_pass": 36, "metric_fail": 65, "not_scored": 43
}
```

- `contract_success`가 0이면 **성능 이전에 형식 문제**다. `results.jsonl`의
  `contract_errors`를 보면 어디가 틀렸는지 정확히 알려준다.
- `not_scored` 사유도 문항별로 적혀 있다:
  `no structured field in think_trace.calculation`,
  `no matching route_policy for the actual execution_mode` 등.
- 지표는 `answerability` / `evidence:*` / `value` / `unit` / `groundedness` /
  `temporal_requirements` / `claim_coverage`로 나뉜다.

---

## 6. 우리 실측 (참고용, LLM 없이)

| | seed 25문항 | seed 밖 18문항 |
|---|---|---|
| 계약 통과 | 25/25 | 18/18 |
| metric_pass | 36 | 47 |
| latency p50 | 375ms | 642ms |

같은 config로 각자 서버만 바꿔 돌리면 **바로 비교가 된다.**

---

## 7. 관련 파일

| 파일 | 내용 |
|---|---|
| `src/dart_detective/answer_wire.py` | 내부 상태 -> wire 5필드 변환(참고 구현) |
| `tests/agents/test_answer_wire.py` | 계약 준수 테스트 24건 |
| `scripts/make_harness_config.py` | config 생성기 |
| `data/eval/newq_gold.v0.2.jsonl` | seed 밖 평가셋 18문항 |
| `docs/reports/team_harness_first_run.md` | 1~3차 실행 기록과 수치 |

---

## 부록: 이 저장소에 들어 있는 것 (릴리스 번들 안 뒤져도 됨)

| 파일 | 내용 |
|---|---|
| `data/eval/seed_gold.v0.17.jsonl` | seed 25문항 Gold v0.2 (팀 릴리스 번들에서 그대로 복사) |
| `data/eval/newq_gold.v0.2.jsonl` | seed 밖 24문항 |
| `tests/fixtures/team_contracts/*.schema.json` | 공식 wire·내부 응답 스키마 원본 사본 — `tests/agents/test_team_contract_schemas.py`가 우리 응답을 이 원본으로 검증한다. 팀이 스키마를 바꾸면 사본을 갱신하는 순간 테스트가 이탈을 잡는다 |
