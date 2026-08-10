# Disclosure Domain Contract v0.1

담당자 B가 관리하는 공통 계약입니다. 뷰어 애플리케이션과 분리되어 있으며,
PostgreSQL 기반 본 시스템의 메타데이터, ID, 공시 관계, Fact, 평가 데이터가
서로 다른 팀원의 파서·청커·검색기에서도 같은 의미를 갖도록 정의합니다.

## Source of truth

1. 코퍼스 포함 여부는 `manifest.jsonl`만 결정합니다.
2. 기업 조인은 `corp_code`를 사용합니다. 이름은 조인 키가 아닙니다.
3. `corp_code`와 `stock_code`는 선행 0을 보존한 문자열입니다.
4. 원본 manifest 행은 수정하지 않고 `manifest_payload`에 보존합니다.
5. 파싱 결과와 Fact는 반드시 원문 `source_locator`까지 역추적할 수 있어야 합니다.

## Canonical ingestion gate

청킹·임베딩은 manifest 등록만으로 시작하지 않습니다. 각 파일이 다음 gate를
통과한 뒤 생성된 canonical representation만 입력으로 사용합니다.

```text
manifest row
  -> 실제 경로 해석
  -> 확장자가 아닌 바이트 signature로 XML/HTML/PDF 판별
  -> 선언값과 분리하여 실제 encoding 검출·기록
  -> MAIN/AUDIT/ATTACHMENT 등 file role 분류
  -> tolerant parse와 repair 내역 기록
  -> 제목·문단·표·원문 locator 보존
  -> 문자수·표수·필수 section·텍스트 손실 검사
  -> ParseAudit SUCCESS/PARTIAL/FAILED
  -> SUCCESS 또는 허용된 PARTIAL만 chunk/fact 생성
```

원본 파일은 수정하지 않습니다. 수리된 파싱 결과에는 `repair_used`, 경고, 손실
의심 여부와 parser version을 남깁니다. 파서마다 성공 기준이 다를 수 있으므로
"strict XML 실패율" 하나를 보편적 품질 지표로 사용하지 않고 동일 gold 문서에
대한 text/table/locator 보존율로 비교합니다.

## ID rules

| 대상 | 규칙 |
|---|---|
| Document | manifest의 `{doc_group}_{rcept_no}`를 그대로 사용 |
| File | `file_{sha256(document_id + NUL + relative_path)[0:24]}` |
| Section | `section_{sha256(file_id + NUL + source_locator)[0:24]}` |
| Chunk | `chunk_{sha256(strategy_id + NUL + document_id + NUL + ordinal + NUL + content_fingerprint)[0:24]}` |
| Event | 검수된 chain에 대해 `event_{sha256(corp_code + NUL + event_type + NUL + chain_id)[0:24]}` |
| Chain | `chain_{sha256(doc_group + NUL + corp_code + NUL + stable_anchor)[0:24]}` |
| Fact | `fact_{sha256(subject + NUL + metric + NUL + period + NUL + scope + NUL + version)[0:24]}` |
| Evidence | `evidence_{sha256(document_id + NUL + source_locator + NUL + quote_hash)[0:24]}` |

`domain/contracts.mjs`가 같은 ID를 생성하는 유일한 공통 구현입니다. 각 모듈이
자체 ID 규칙을 만들지 않습니다.

## Time model

- `known_at`: 시장과 시스템이 해당 정보를 알 수 있게 된 접수 시점
- `valid_from`, `valid_to`: 사실이나 사건 상태가 현실에 유효한 기간
- `period_start`, `period_end`, `as_of_date`: 재무·지분 값이 설명하는 기준기간

`known_at`과 `valid_*`를 합치지 않습니다. 정정공시는 나중에 알려졌지만 과거
기간의 값을 수정할 수 있기 때문입니다.

## Answerability and coverage

Coverage는 한 단계짜리 상태가 아니라 서로 다른 두 계층으로 평가합니다.

1. **Manifest coverage**: 제공 코퍼스에 문서가 등록됐는지 평가합니다. Seed의
   `PRESENT`는 이 의미만 가지며 파싱 성공을 뜻하지 않습니다.
2. **Parse coverage**: 등록 문서의 실제 파일이 성공적으로 파싱됐는지 평가합니다.
   파서 실행 후 `PARSE_FAILED` 또는 `PARTIAL_PARSE_FAILURE`로 별도 갱신합니다.

질문 응답 시에는 기업×문서군 전체 집계만 사용하지 않고, 질문의 subtype·기간·
기준일 조건으로 manifest를 다시 제한한 query-scoped coverage를 계산합니다.

| Coverage | 최종 의미 |
|---|---|
| `PRESENT` | 관련 문서와 사용 가능한 근거가 있음 |
| `ZERO_DOCUMENT` | corpus에 해당 문서가 0건임 |
| `PARSE_FAILED` | 문서는 있지만 처리하지 못함 |
| `PARTIAL_PARSE_FAILURE` | 일부 파일·영역만 처리됨 |
| `NOT_IN_CORPUS` | 제공 범위 밖임 |

| Value status | 의미 |
|---|---|
| `DISCLOSED` | 값이 공시됨 |
| `WITHHELD` | 값이 의도적으로 유보됨 |
| `NOT_APPLICABLE` | 공시상 적용 대상이 아님 |
| `MISSING` | 문서에 기대 필드가 있으나 값을 확보하지 못함 |

`ZERO_DOCUMENT`, `PARSE_FAILED`, `WITHHELD`를 모두 `null`로 합치지 않습니다.

## Relation rules

- `AMENDS`: 원본 또는 이전 버전을 정정
- `TERMINATES`: 계약·사건을 해지·종료
- `CONFIRMS`: 미확정 공시를 확정
- `SAME_EVENT_AS`: 같은 기업 사건의 다른 공시
- `DISCLOSES`: 문서가 사건을 공시하는 document→event 관계

관계 방향은 `source_document_id -> target_document_id`입니다. 예를 들어 정정본이
원본을 고치는 경우 `정정본 --AMENDS--> 원본`입니다. 관계 후보는 규칙·모델이
만들 수 있지만, `method`, `confidence`, `evidence_id`를 반드시 남깁니다.
`DISCLOSES`는 문서→문서 관계가 아니므로 `document_events`에 별도로 저장합니다.

- 모든 정정 문서는 `AMENDS` 검수 큐에 올립니다.
- `단일판매공급계약해지` 문서는 수가 적으므로 `TERMINATES` 전수 검수 큐에 올립니다.
- exchange 정정문서의 정정 전/후 field delta는 변경 사실을 추출하는 강한 근거지만,
  대상 원본문서의 identity를 항상 증명하지는 않습니다. 따라서 field delta 추출과
  AMENDS chain 연결을 병행합니다.

## Delivery status

| 영역 | 현재 상태 | 완료 조건 |
|---|---|---|
| 기업·별칭·문서 seed | 완료 | 전체 manifest/universe 감사 통과 |
| AMENDS/TERMINATES 후보 | 생성 완료, 검수 전 | 명시 참조·필드·사건 동일성 확인 후 승격 |
| Fact 계약·DB 스키마 | 완료 | metric ontology와 parser 추출 결과 적재 후 실데이터 완료 |
| 평가 계약·검수기 | 완료 | canonical parser의 source locator를 이용한 500문항 2인 검수 후 Gold 완료 |

Fact 레코드와 평가 Gold를 원문 locator 없이 임의 생성하지 않습니다. 담당자 B는
metric 의미·scope·period·version 및 Gold 판정 기준을 관리하고, 파서 출력이 준비되면
원문 근거를 연결하여 실데이터를 확정합니다.

## Evaluation contract

독립 평가는 `DEV_TUNE`, `DEV_CHECK`, `HOLDOUT`으로 나눕니다. `REGRESSION`은
독립 표본이 아니라 발견된 버그를 누적하는 별도 suite입니다.

Gold는 특정 청킹 전략의 `chunk_id`를 정답으로 사용하지 않습니다. 다음 값으로
정의합니다.

- `gold_document_ids`
- `source_locator`
- `evidence_span`
- `required_evidence_slots`
- `expected_fact_ids` / `expected_event_ids`
- `expected_answerability`

동일 `evaluation_group_id`(동일 기업·기간 보고서 또는 동일 사건·정정 chain)는
둘 이상의 독립 split에 들어갈 수 없습니다.

## Files

- `postgres/001_core.sql`: PostgreSQL 공통 스키마
- `contracts.mjs`: ID 생성과 런타임 검수 규칙
- `evaluation/example.question.json`: 평가 항목 작성 예시
- `evaluation/README.md`: 500문항 배분·Chain 분할·2인 Gold 검수 규칙
- `evaluation/authoring-allocation.json`: 500문항 및 초기 150개 작성 할당
- `facts/metric-ontology.v0.1.json`: 핵심 Fact 의미·차원·원문 라벨 계약
- `relations/review-rubric.md`: 관계 유형별 Gold 승격 기준
- `interfaces/`: A→B DocumentIR 및 B→C Semantic Bundle JSON Schema
- `../scripts/audit-domain-data.mjs`: universe/manifest 무결성 감사
- `../scripts/validate-evaluation.mjs`: 평가 JSONL 검수 및 chain leakage 탐지
- `HANDOFF.md`: B 마감 범위와 A/C로부터 받을 산출물·acceptance gate
- `interfaces/fact-coverage-snapshot.schema.json`: 검수된 Fact coverage 불변 snapshot
- `interfaces/experiment-run.schema.json`: 동일 A/B round의 snapshot 고정 계약
- `evaluation/evaluation-gold.v0.2.schema.json`: route/evidence/scoring Gold 계약

## Commands

```bash
test -n "$CORPUS_PATH"
npm run domain:audit -- "$CORPUS_PATH"
npm run domain:seed -- "$CORPUS_PATH" work/domain-seed
npm run domain:eval-queue -- "$CORPUS_PATH"
npm run domain:validate-b -- "$CORPUS_PATH"
npm run eval:validate -- domain/evaluation/example.question.json
npm run eval:validate -- path/to/evaluation.jsonl
npm run test:domain
```
