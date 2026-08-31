# 팀 평가 하니스로 우리 시스템을 처음 채점했다

측정 2026-08-31 · LLM 호출 0회(`DART_DETECTIVE_LLM=off`) · 비용 0원

## 무엇을 했나

팀 공통 기반의 평가 하니스(`domain/evaluation-harness/`)는 `GET /answer`를 **블랙박스로**
호출해 채점한다. 우리 시스템은 `POST /qa`라서 그동안 이 하니스로 잴 수 없었다.
어댑터를 붙여 같은 자로 재본 첫 기록이다.

파이프라인은 건드리지 않았다 — 검색·근거 선택·계산·검증 그대로, 응답 포맷만 변환했다.

## 결과

| 항목 | 값 |
|---|---|
| API 성공 | **25/25** |
| 계약 통과(contract_success) | **25/25** |
| 응답 사용 가능 | **25/25** |
| metric_pass / fail / not_scored | 34 / 63 / 47 |
| answerability | **12 PASS** (채점된 것 전부) |
| groundedness | 11 PASS / 2 FAIL |
| evidence | 5 PASS / 26 FAIL |
| unit | 6 PASS / 3 FAIL |
| latency p50 / p95 | 375ms / 2,038ms |
| timeouts · http_errors · echo mismatch | 0 · 0 · 0 |

## 맞춰야 했던 것 세 가지

**① `execution_mode` enum** — 계약이 허용하는 값은 `STRUCTURED`/`RETRIEVAL`/`BOTH`/
`EARLY_EXIT` 넷뿐이다. 처음에 우리 경로 이름을 그대로 적었더니 **25건 전부 계약 위반**이
났다. 검색으로 답하므로 `RETRIEVAL`, 근거를 못 찾으면 `EARLY_EXIT`으로 바꿔 25/25 통과.

**② `source_locator` 형식** — Gold의 acceptable_sources는
`{doc_id}/{접수번호}.xml#node={노드번호}` 형식이다. 문서 id와 인용문이 맞아도 위치
표기가 다르면 근거로 인정되지 않는다. 우리 청크가 노드 번호를 들고 다니므로 그대로
만들어 실었다 — evidence 0 PASS -> **5 PASS**.

**③ `think_trace.calculation`** — 하니스의 closed metric은 답변 문장에서 숫자를 긁지
않는다(연도를 값으로 오인하는 것을 막으려는 설계다). `calculation`에 구조화된 값이
있어야만 채점한다. selector가 자리마다 확정한 값을 Gold의 필드 이름
(`contract_amount`, `period_start` …)으로 실었다. 값을 확정 못 한 자리는 넣지 않는다.

## 남은 NOT_SCORED 47건의 사유 (하니스가 알려준 그대로)

| 건수 | 사유 |
|---|---|
| 66 | `no structured field in think_trace.calculation` — Gold이 요구하는 필드명 매핑이 아직 부족 |
| 13 | `no explicit requested-format field exists in the current Gold schema` — Gold 쪽 미정의 |
| 12 | `no matching route_policy for the actual execution_mode` — Gold의 route_policy에 RETRIEVAL 경로가 없음 |
| 5 | `no explicit date-shaped fields in expected_answer.value` |

앞의 하나는 우리가 더 맞출 수 있고, 나머지 셋은 Gold·계약 쪽 사안이다.

## 팀에 남는 것

- **하니스가 외부 구현에도 붙는다는 것이 실증됐다.** 지금까지는 자기 시스템에만 붙어 있었다.
- 하니스 단독 실행에 필요한 의존성은 `ajv`, `ajv-formats` 둘뿐이다(Next/React 불필요).
- 설정 예시와 실행 절차: `experiments/team_harness_run/config.json`
  (`split: DEV_TUNE`, `run_purpose: FLOW_SELECTION` 조합은 lifecycle/ledger 없이 실행된다).
- `execution_mode` enum이 4개로 고정이라는 사실은 문서에 없어 실패로 알게 됐다 —
  외부 구현자를 위해 계약 문서에 적어 두면 좋다.

## 주의 — 아직 비교 숫자가 아니다

이 수치는 **우리 시스템의 것만** 있다. 팀 Agent를 같은 하니스로 돌린 기록이 아직 없으므로
"누가 더 정확한가"를 말할 수 없다. 두 시스템을 같은 config로 돌려야 비교가 성립한다.
그 준비가 이번 작업으로 끝났다.

재현:
```bash
DART_DETECTIVE_LLM=off .venv/bin/python -m uvicorn dart_detective.api:app --port 8000
node scripts/run-evaluation-harness.mjs run/config.json
```
