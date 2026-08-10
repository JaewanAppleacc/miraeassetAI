# B → C Semantic Artifact handoff v0.1

## 최신 역할과 MVP

`b-to-c-mvp-contract.v0.1.json`을 최신 역할 기준으로 사용한다. 과거 문서에서 Fact
담당자가 다르게 적힌 경우 이 계약이 우선한다.

- B: Fact/Event/Relation/Evidence의 의미 정의, 추출, 사람 검수, Gold 작성
- C: schema loader, 저장, 조회, 실험 실행, metric 계산, snapshot 고정
- Fact Store와 Event/Correction Chain은 MVP에 포함한다.
- 단, MVP가 모든 공시 필드를 구조화한다는 뜻은 아니다. 계약·해지·정정과 핵심
  재무지표를 우선하고 그 밖의 서술 정보는 Retrieval을 사용한다.

## C 요청 필드 매핑

| C 표현 | 동결된 B 필드 | 비고 |
|---|---|---|
| `fact_id` | `fact_id` | 동일 |
| `doc_id` | `source_document_id` | 문서 출처임을 명확히 함 |
| `fact_type` | `metric_code` + `value_type` | 의미와 자료형을 분리 |
| `value_raw` | `raw_value_text` | 원문값 |
| `value_normalized` | `normalized_value` | 계산값 |
| `unit` | `unit` | 정규화 단위 |

현재 B 스키마를 C의 축약 필드에 맞춰 별도로 복제하지 않는다. `value_status`,
`value_certainty`, 원문 단위, currency/scale, scope, period, known/valid time,
`withheld_until`, `verification_status`, `evidence_ids`가 정확한 답변과 버전 선택에
필수이기 때문이다.

## 패키지 내용

`work/semantic-handoff/`에는 다음이 들어간다.

- `semantic-bundle.candidate.sample.jsonl`: 대표 문서의 적재 테스트용 Bundle
- `semantic-bundle.schema.json`: B→C 구조 계약
- `semantic-bundle.contract-example.json`: Fact/Event/Relation/Evidence가 모두 있는
  schema contract fixture. 실제 corpus Gold가 아니다.
- `fact-coverage-snapshot.schema.json`: 동일 실험 round에서 고정할 coverage 계약
- `evaluation-gold.v0.2.schema.json`: 평가 Gold 계약
- `b-to-c-mvp-contract.v0.1.json`: 역할·범위·현재 전달 상태
- `001_core.sql`: PostgreSQL 논리 스키마
- `semantic-handoff-manifest.json`: source/output hash, 표본 선정 이유와 개수

샘플은 `CANDIDATE`만 포함한다. 이는 loader·DB migration·SANDBOX 테스트용이며,
공식 STRUCTURED 경로나 평가 점수에 사용하면 안 된다. C는
`verification_status=VERIFIED`가 아닌 Fact/Event/Relation/Evidence를 공식 실행에서
거부해야 한다.

## 생성과 검증

```bash
npm run domain:semantic-handoff
npm run domain:validate-semantic-handoff
```

생성기는 동일 source artifact와 설정에서 같은 JSONL을 만들며, manifest에 source와
output SHA-256을 기록한다. `producer.created_at`은 원본 Bundle 값을 보존하므로 생성
시각 때문에 표본 hash가 바뀌지 않는다.

## 현재 한계

- 거래소 계약 1,126문서의 전체 Candidate Bundle은 이미 생성됐지만 사람 검수 전이다.
- Event와 확정 Relation은 chain 검수 전이므로 대표 Candidate Bundle에서 빈 배열이다.
- AMENDS/TERMINATES 검수 결과가 확정되면 새 semantic artifact revision으로 전달한다.
- 최종 Gold 일정은 단순 코드 작업이 아니라 2인 검수 인력과 C Usage Ledger 준비에
  의존한다. 따라서 Candidate 전달일과 Verified/Gold 확정일을 같은 날짜로 약속하지
  않는다.
