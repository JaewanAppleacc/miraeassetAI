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

---

## 2차: 필드명 매핑 후 (같은 날, LLM 호출 0회)

| 항목 | 1차 | 2차 |
|---|---|---|
| metric_pass | 34 | 34 |
| not_scored | 47 | **43** |
| value 하위 필드 | 전부 NOT_SCORED | **PASS 4 / FAIL 2** / NOT_SCORED 61 |

**바뀐 것**

1. **하니스는 `calculation.result` 안쪽을 본다.** 최상위에 필드를 늘어놔도 읽지 않는다
   (`closed-metric.mjs`의 `structuredRaw`: `calc.result ?? calc.value`). result를
   오브젝트로 바꾸자 채점이 붙기 시작했다.
2. **필드 이름은 규칙으로만 만든다.** Gold의 `expected_answer.value` 필드는 25문항에
   181종이고 대부분 문항 전용(`crane_investment_amount`, `mobis_revenue_2023`)이다.
   그걸 사전에 박으면 정답지를 코드에 넣는 것이라 하지 않았다. 규칙으로 유도되는 것만
   내보낸다 — 항목명(`contract_amount`), 지표×연도(`revenue_2023`), 표에 단위가 적혀
   있을 때만 붙는 단위 이름(`revenue_2023_million_krw`), 계산값(`revenue_change_percent`).
3. **날짜도 값으로 뽑는다.** `period_start`/`period_end`는 표에 `2023-04-28` 형태라
   숫자 판정에서 빠져 있었다.
4. **백분율 자릿수를 3으로.** Gold의 `scoring_spec`이 `rounding: 3, tolerance: 0.001`
   이라 2자리로 자르면 반올림 차이만으로 오답이 된다(3.15 vs 3.145). 규격을 맞춘 것이지
   정답을 맞춘 것이 아니다.

**실채점 예시**

| 문항 | 필드 | 우리 값 | Gold | 결과 |
|---|---|---|---|---|
| Q01 | contract_amount | 635,384,978,972 | 635384978972 | PASS |
| Q02 | equity_ratio_percent | 5.5 | 5.5 | PASS |
| Q12 | operating_profit_change_percent | 46.276 | 46.276 | PASS |
| Q12 | revenue_change_percent | 3.145 | 3.145 | PASS(자릿수 수정 후) |
| Q11 | revenue_change_percent | 30.26 | 29.645 | FAIL — 다른 표를 근거로 삼았다 |

Q11은 반올림이 아니라 **값 자체가 다르다**. 우리 selector가 고른 표가 Gold이 기대한
표와 다르다는 뜻이고, 이건 형식이 아니라 실제 성능 문제다 — 남겨서 다음에 본다.

---

## 3차: 연결/별도 구분 규칙 추가 (LLM 호출 0회)

| 항목 | 2차 | 3차 |
|---|---|---|
| metric_pass | 34 | **36** |
| gold25 근거 커버리지 | 37/140 | **41/140** |
| 새 18문항 근거 | 19/24 | 19/24 (유지) |
| gold25 검색 회귀 | +0.0000 | **+0.0000** |

**문제(Q11)**: HMM 2025 사업보고서의 "1. 요약재무정보" 섹션 안에 표가 둘 있다.
섹션 경로도 행 레이블도 같아서 selector가 검색 순위만 보고 **별도 표**를 골랐는데,
질문은 "연결 실적"을 물었다. 계산은 정확했고 입력이 틀렸다.

```
node 230  가. 요약연결재무정보          <- 연결
node 232  매출액 | 10,891,443 | ... | 8,400,969
node 234  나. 요약재무정보              <- 별도
node 236  매출액 | 10,721,177 | ... | 8,230,446   (selector가 고른 쪽)
```

**고친 방법**: 표 안에는 구분이 없고 **바로 앞 문단**에만 있다. 문서를 한 번 훑어
`노드번호 -> 연결|별도` 지도를 만들고, 질문이 요구한 쪽 표에 가산점을 준다.
검색 점수는 건드리지 않았다 — 그래서 회귀 0이다.

**결과**: Q11이 Gold과 소수 셋째 자리까지 일치.

| | 전 | 후 | Gold |
|---|---|---|---|
| 매출액 증가율 | 30.262% | **29.645%** | 29.645 |
| 영업이익 증가율 | 152.005% | **149.876%** | 149.876 |

근거 사유에 판단이 남는다: `행 레이블 매출액 일치, 표 머리글 2023년 = 3번째 값 열,
연결 재무제표, Retrieval 2위` — 검색 2위 표가 연결 가산점으로 1위를 눌렀다.

**안전장치**: 질문에 연결·별도가 둘 다 있거나 없으면 가르지 않는다. 범위를 모르는
표는 감점하지 않는다(모른다고 깎지 않는다).

---

## 5번: 실호출 검증 (2026-08-31, run A/B)

**run A — 폐기 9문항을 HCX-005로 재실행** (71.2원, VAT 별도)

| 결과 | 문항 | 해석 |
|---|---|---|
| 생존 | **Q17** | 과잉거부 수리 실증 — "정보 부족" 정직 답변이 이제 채택된다 |
| 재폐기(근거미달) | 7건 | 공백 문제가 아니라 진짜 근거 없는 수치 — 차단이 맞다 |
| JSON 깨짐 재현 | Q22 | invalid escape — 모델 비결정 출력, 기록 유지 |
| **파이프라인 버그 발견** | Q18 | evidence가 문자열 배열로 와서 예외 폐기 → normalize_citations로 수리·잠금 |
| 지어낸 숫자 | **0건** (9/9) | 단위 검사 units_ok 전부 통과 |

**run B — 형식실패 3문항을 HCX-007로** (0원)

전부 HTTP 400 — 이 API 키/테스트앱에서 HCX-007 호출 불가. 크레딧 최소화 방침에 따라
진단 재호출 없이 중단. 모델 스위치 실험은 007 권한 확보 후 과제로 남긴다.

누적 실호출 비용: 약 397원(VAT 별도) / 예산 3,000원.
