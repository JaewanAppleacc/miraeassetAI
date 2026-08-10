# 담당자 B 마감 및 A/C 인수 조건

## 현재 인수 상태 (2026-08-04)

A의 전체 DocumentIR을 인수하고 B 계약으로 스트리밍 검증했다.

- 원본 4개 JSONL, 8,615,531,403 bytes, 4,204문서
- 실제 source file 4,622개, block 1,571,530개, table 636,429개
- A 품질: structured 2,693 / partial 1,432 / fallback 79
- B parse coverage: PRESENT 4,123 / PARTIAL_PARSE_FAILURE 79 / PARSE_FAILED 2
- A snapshot `snap_7484a10220422056`는 B snapshot
  `corpus_04750795e1a2d5c3`에 명시적으로 매핑한다.
- 79건은 최대 20,000자 fallback text가 남은 구조 실패이며, 별도 2건은 PDF 본문
  미지원과 빈 viewer HTML 때문에 노드와 텍스트가 모두 0인 완전 누락이다.
- ID/locator는 결정론적으로 설계됐으나 4,204건 전수 2회 재실행 hash 비교는 미실시다.
- 원본·전체 Canonical 복제본은 Git에 넣지 않고 `work/a-document-ir/`에서 관리한다.

첫 의미 추출 배치로 exchange 계약/해지 1,126문서에서 Fact/Evidence 후보
8,873쌍을 생성했다. 모두 `CANDIDATE`이며 관계 chain과 사람 검수 전에는
`VERIFIED`로 승격하지 않는다.

## B가 동결한 것

- 기업·별칭·문서·ID 규칙과 22개 핵심 metric ontology
- Fact/Event/Relation/Evidence 의미 계약과 PostgreSQL 논리 스키마
- AMENDS 1,004건 및 TERMINATES 20건 관계 검수 큐
  - TERMINATES subtype 오류 수정 완료
  - Fact 기반 고신뢰 검수 추천 8건 / 수동 판별 11건 / corpus 후보 없음 1건
  - EXCHANGE 정정 631건의 명시 참조 추출: 내부 정확 매칭 260 / corpus 밖 299 / 모호 72
  - 고신뢰 TERMINATES 검수 패킷: 즉시 검수 2 / AMENDS chain 선행 필요 6
- 150문항 초기 작성 큐, chain-safe split, usage freeze 규칙
- Evaluation Gold v0.2, Fact Coverage Snapshot, Experiment Run 인터페이스
- `WITHHELD`, `NOT_APPLICABLE`, `ZERO_DOCUMENT`, `PARSE_FAILED`,
  `OUT_OF_SCOPE`, `CONFLICTING_EVIDENCE`의 분리 원칙
- 최신 역할·MVP 계약과 C 적재용 Semantic Candidate 패키지 계약
  - `domain/interfaces/b-to-c-mvp-contract.v0.1.json`
  - `domain/interfaces/C_SEMANTIC_HANDOFF.md`
  - 과거 역할 문서와 충돌하면 위 최신 계약을 우선한다.

현재 큐는 Gold가 아니라 작성 계획입니다. A의 DocumentIR과 관계 검수 결과가 들어온
후 source locator·Fact/Event ID·정답을 채우고 2인 검수해야 Gold가 됩니다.

## A에게 받을 필수 산출물 (개발 입력 인수 완료, 재현성 최종 gate 잔존)

| 산출물 | 필수 내용 | B에서 사용하는 곳 | 미수령 시 차단되는 작업 |
|---|---|---|---|
| Corpus Snapshot | snapshot ID, manifest/universe SHA-256, 4,204문서 일치 | 모든 artifact 버전 고정 | Gold/Facts 재현성 확정 |
| DocumentIR 전량 | `document-ir.schema.json` 준수 JSONL/Parquet | Fact/Event/Evidence 생성 | source locator와 근거 Gold 작성 |
| File/ParseAudit | 실제 format·encoding, file role, parse status, warning, text-loss 여부 | coverage 상태 계산 | PRESENT와 PARSE_FAILED 구분 |
| Canonical blocks | 제목 계층, 문단, field group, 표/행, 안정적 locator | metric·사건 추출 | Fact와 인용 근거 생성 |
| Table representation | 원본 header/body, 병합셀 처리, 단위·scope·기간 힌트 | 재무·계약·지분 Fact | 수치 Gold와 계산 검증 |
| Dedup report | fingerprint, duplicate group, repeated-section 표시 | 대표 evidence 선택 | 중복 근거 편향 방지 |
| Parser Gold 결과 | 80~100 대표문서의 기대 block/표와 parser recall | 파싱 Hard Gate | 손상된 입력에서 실험 시작 방지 |

### A 전달 acceptance gate

1. manifest 문서만 전달하며 `document_id`가 공통 규칙과 일치한다.
2. 확장자가 아니라 실제 바이트로 format/encoding을 판정한다.
3. 실패한 문서를 빈 문서로 만들지 않고 `FAILED/PARTIAL`과 진단을 보존한다.
4. locator는 결정론적으로 설계됐으며, 최종 동결 전 전수 semantic hash 재실측을 통과한다.
5. 각 artifact에 corpus snapshot과 parser/schema version이 있다.

## C에게 받을 필수 산출물

| 산출물 | 필수 내용 | B에서 사용하는 곳 | 미수령 시 차단되는 작업 |
|---|---|---|---|
| 공통 artifact loader | DocumentIR/Semantic Bundle/Gold schema 검증과 reject report | A→B→C 통합 | 잘못된 입력의 조용한 적재 방지 |
| Experiment Runner | 고정 seed/config, run manifest, 결과 JSONL | 청킹·임베딩·검색 A/B | 재현 가능한 모델 선택 |
| Snapshot enforcement | 같은 round에서 corpus/parser/gold/fact coverage 고정 | route policy 공정 비교 | 검색 성능과 coverage 효과 분리 |
| Usage Ledger | append-only usage event, provisional 공식실행 차단 | split 오염 관리 | DEV/HOLDOUT 신뢰성 확보 |
| Metric evaluator | Hard Gate, Evidence Slot Recall, citation/numeric/route 점수 | Gold 기반 채점 | 실험 채택/기각 결정 |
| Regression runner | 버그 fixture 누적·자동 재실행 | 회귀 방지 | 수정 후 기존 기능 보장 |
| Cache/index manifest | chunk·embedding·lexical/index snapshot ID와 hash | 비용·재현성 관리 | 서로 다른 인덱스 혼합 방지 |
| API contract test | 최종 JSON schema, timeout/retry/fallback, HCX answer-only 경계 | 제출 안정성 | API/JSON 실패 방어 |

### C 전달 acceptance gate

1. `experiment-run.schema.json`과 `evaluation-usage-event.schema.json`을 준수한다.
2. 동일 `experiment_round_id`에서 `fact_coverage_snapshot_id`가 달라지면 실행을 거부한다.
3. provisional 질문은 SANDBOX 외 실행을 거부한다.
4. retrieved context와 think trace는 코드가 조립하고 HCX는 answer 설명만 생성한다.
5. `CONFLICTING_EVIDENCE` 자연 사례가 없더라도 fixture로 조기 종료 경로를 검증한다.

## 인수 후 B의 남은 실행 순서

1. A의 ParseAudit을 manifest-level coverage와 병합한다.
2. DocumentIR에서 핵심 Fact와 Evidence 후보를 추출하고 사람이 검수한다.
3. AMENDS/TERMINATES/CONFIRMS chain을 확정하고 split을 lock한다.
4. Evidence locator·정답·route policy를 채워 Gold v0.2를 확정한다.
5. Verified Semantic Bundle과 Fact Coverage Snapshot을 C에 전달한다.
6. C runner에서 schema, leakage, critical slice, regression 검사를 통과시킨다.

## 교환 순서

`A: DocumentIR/ParseAudit → B: Semantic Bundle/Gold/Fact Coverage → C: 실행·평가 결과`

C는 B 전체 검수가 끝날 때까지 기다리지 않고 `work/semantic-handoff/`의 Candidate
표본으로 loader와 DB migration을 개발할 수 있다. 단, Candidate는 SANDBOX 전용이며
공식 STRUCTURED 경로에는 `verification_status=VERIFIED`만 허용한다.

A와 C의 전체 작업 완료를 기다릴 필요는 없습니다. 동일 snapshot·schema의 검증된
배치 단위로 인수하여 B가 Fact/Gold 작성을 이어가되, 공식 split과 최종 점수는 chain
closure와 snapshot 고정 이후에만 사용합니다.
