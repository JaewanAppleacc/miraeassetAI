# 공통 기반 완료 현황과 이후 작업 로드맵

기준일: 2026-08-18

기준 릴리스: `seed-release-v0.20`

문서 목적: 지금까지 완료한 통일 작업의 경계를 고정하고, 평가 데이터·DB·개별 Agent 구현·배포의 다음 순서를 팀이 동일하게 이해하도록 한다.

## 1. 현재 결론

평가 데이터를 만들고 여러 작업자가 각자의 방식으로 Agent를 설계하기 위해 필요한 **최소 공통 기반 통일은 완료**됐다.

완료된 것은 모든 Agent가 공유해야 하는 데이터 의미, 근거와 provenance, ID, API, 계산·검증 안전 경계, 평가 Harness, Seed 기준선과 portable release bundle이다. 반면 검색 순서, Planner, Retriever, DB 인덱스, 임베딩, 프롬프트, 도구 호출 순서 등 Agent의 성능 전략은 의도적으로 통일하지 않았다.

따라서 앞으로는 공통 규칙을 더 넓히는 연구보다 다음 작업에 집중한다.

1. 공통 데이터를 DB에 재현 가능하게 적재하는 reference loader 구축
2. 최종 평가 데이터 확대와 chain-safe split 확정
3. 작업자별 Agent 구현과 동일 Harness 비교
4. 선정된 Agent의 운영 DB·배포 환경 구성

## 2. 완료된 공통 통일 범위

### 데이터·의미 계약

- 4,204개 문서의 Canonical DocumentIR와 corpus snapshot
- document/node/chunk/evidence/fact/event/relation ID와 `source_locator`
- Evidence, Fact, Event, Relation, Coverage, Chain의 공통 의미
- 기간, 단위, scope, 최신 유효값, 정정 이력, certainty와 value status
- 회사 식별용 승인 Company Directory
- 직접 공시값과 파생 계산값, 정보한계의 구분

### Runtime·안전 계약

- Calculator, Validator, Policy Guard와 fail-closed 경계
- 회사명·내부 enum·snake_case·corp_code 등의 사용자 노출 차단
- 근거 없는 수치, 잘못된 회사 귀속과 출처 없는 계산 차단
- `GET /answer` 5개 문자열 필드 Wire 계약
- `/health`, `/ready`, 초기화 실패와 timeout의 안전 응답

### 평가·검수 계약

- Seed 25문항 Gold/Metric/Harness
- Owner 검수와 승인 데이터 승격 이력
- Q18처럼 직접 공시 여부가 불명확한 경우의 정보한계 정책
- 회귀 비교용 versioned Wire와 clean Plan 계보
- synthetic fixture, 부정 테스트와 과적합 정적 검사

### 배포 재현 기반

- 결정론적 gzip과 portable release bundle
- bundle manifest의 encoded/decoded SHA-256 및 record count pin, 그리고 경로
  traversal·symlink escape·duplicate/unknown role에 대한 fail-closed 검증
  (Turn M11)
- 승인 decision과 production runtime 결합
- `git archive + npm ci --omit=dev` 기반 **production runtime** clean-clone
  실행 검증 — 아래 두 항목을 명확히 구분한다(Turn M11, 독립 검수로 실측 확인):
  - **공식 production clean-clone(완료)**: Git 추적 코드와 portable v0.20
    bundle만으로 `npm ci --omit=dev` → production Node 서버 초기화 →
    `/ready` → `/answer` → `tests/seed-release-isolated-deployment-official-clean-clone.test.mjs`가
    새 clone에서 4/4 PASS.
  - **과거 개발·감사(work/domain-seed) 기반 테스트 전체 재현(미지원)**: 과거
    `work/domain-seed/` 산출물을 직접 참조하는 다수의 개발/감사 테스트는 그
    디렉터리 전체가 Git에 없어(`/work/`가 gitignore 대상, portable bundle 3개
    디렉터리만 예외) 새 clone에서 재현되지 않는다. "새 clone에서 전체 계약
    테스트가 모두 통과한다"는 표현은 사용하지 않는다.
- 로컬 장기 workspace(수 주간 누적된 `work/domain-seed/` 포함) 기준:
  Turn M11.1에서 domain 계약 테스트 1,641개와 별도 v0.20 최종 테스트 9개가
  모두 통과했고(0 FAIL / 0 SKIP), schema/typecheck/build도 통과했다. 이 수치는
  **로컬 workspace 전용**이며 새 clone 재현성의 증거가 아니다.
- Reference DB/Loader(§4)의 입력 정본은 `work/domain-seed`가 아니라 portable
  v0.20 bundle(Git 추적)이다 — loader 자신도 fresh clone에서 bundle만으로 재현
  가능해야 한다(§6 Phase 1 참고).

## 3. 통일하지 않은 영역 — 작업자 자율 설계 범위

다음은 공통 평가 경계만 지키면 작업자가 독립적으로 선택한다.

- Question IR과 질의 해석 방식
- Router/Planner/ReAct/고정 DAG 사용 여부
- Fact 우선, Retrieval 우선 또는 병렬 실행
- BM25, Dense, RRF, reranker와 query expansion
- chunking과 parent-child/table 검색 전략
- PostgreSQL, pgvector, Elasticsearch, Qdrant 등 파생 검색 저장소
- HCX 프롬프트와 근거 합성 순서
- 재검색, fallback, 캐시와 실행 예산 배분
- 내부 모듈 구조와 AgentFlow 구현

다만 최종 답변은 공통 corpus snapshot, 근거/provenance, Calculator/Validator, `/answer` 계약과 평가 Harness를 우회할 수 없다.

## 4. DB는 언제, 무엇을 만드는가

DB 작업은 이제 시작한다. 두 계층을 구분한다.

### 4.1 공통 Reference DB/Loader

목적은 특정 검색 전략을 강제하는 것이 아니라, 모든 작업자가 같은 release bundle을 같은 의미로 적재했는지 검증하는 것이다.

권장 기준 구현은 PostgreSQL이며 최소한 다음 데이터를 적재한다.

- corpus snapshot, document, node와 source locator
- Evidence, Fact, Event, Relation, Coverage, Chain
- Company Directory
- 평가 question, Gold, Metric, run과 usage ledger
- release ID, artifact SHA, schema version과 migration 이력

필수 조건:

- Seed/release 데이터는 읽기 전용 정본으로 유지한다.
- 작업자별 파생 테이블과 인덱스는 별도 schema/namespace에 둔다.
- loader는 재실행해도 같은 결과가 나오는 idempotent 방식이어야 한다.
- record count, snapshot ID, SHA와 외래키를 적재 전후 검증한다.
- 손상·중복·다른 snapshot 혼입 시 전체 적재를 fail-closed한다.
- 빈 DB에서 bundle만으로 복원하는 통합 테스트를 둔다.

### 4.2 작업자별 검색 DB/Index

다음은 공통 DB와 분리된 실험 영역이다.

- BM25 인덱스
- vector embedding과 pgvector/Qdrant 등의 Dense 인덱스
- section/table 전용 인덱스
- graph traversal용 파생 구조
- 캐시와 후보별 feature store

이 데이터는 언제든 공통 bundle에서 재생성할 수 있어야 하며, 공통 Fact/Evidence 정본을 덮어쓰면 안 된다.

## 5. 앞으로의 단계별 작업

### Phase 0 — 공유 저장소 인계

- [ ] 검수 브랜치의 CI 실행
- [ ] 대용량 bundle 21개 항목과 SHA 재확인
- [ ] 코드 리뷰 후 보호된 기본 브랜치로 병합
- [ ] release tag/commit 서명 또는 Owner 승인 이력 확정
- [ ] 비밀값·개인 절대경로·불필요한 로컬 파일이 없는지 확인

완료 기준(Turn M11 정정 — 독립 검수로 실측 확인한 대로 두 가지를 분리):
- production runtime clean-clone 재현: **완료.** 새 clone에서 `npm ci --omit=dev`
  → production Node 서버 초기화 → `/ready` → `/answer`가 통과한다
  (`tests/seed-release-isolated-deployment-official-clean-clone.test.mjs` 4/4 PASS).
- 과거 `work/domain-seed` 기반 개발/audit test suite 전체 재현: **미지원.**
  `work/` 전체가 Git에 없어 새 clone에서 재현되지 않는다. 로컬 장기
  workspace에서는 전체 suite가 통과한다(위 §2 참고). "새 clone에서 전체
  계약 테스트가 모두 통과한다"거나 "모든 과거 work artifact가 Git에서
  복원된다"는 표현은 쓰지 않는다.
과거 `work/` 전체를 Git에 추가하거나 산발적으로 누적된 개발 산출물을
복구하는 것은 이번 Turn과 다음 Phase 모두의 목표가 아니다 — Phase 1의 입력
정본은 portable v0.20 bundle이다.

### Phase 1 — Reference DB와 Loader

- [x] PostgreSQL 최소 reference schema 및 migration 작성
- [x] v0.20 bundle streaming loader 작성
- [x] snapshot/SHA/record count/외래키 검증 추가
- [ ] 읽기 전용 common schema와 작업자별 namespace 분리
- [x] 빈 DB 복원·중복 적재·손상 bundle 부정 테스트 (실제 PostgreSQL 16으로 검증)
- [x] 최소 조회 API 또는 repository adapter 제공 (Turn N2)

현재 N1 구현은 portable v0.20 Seed bundle을 대상으로 하며 PostgreSQL 16만 허용한다.
격리된 PostgreSQL 16.15 인스턴스에서 빈 DB 복원, bundle 21-role/792-record 적재,
재적재 멱등성, 실패 시 rollback, READY 불변성 및 최소 권한을 실제 SQL로 검증했다.
이 bundle의 Canonical DocumentIR는 68 records(54 base + 14 delta)이며 전체
4,204문서가 아니다. 전체 검색 DB를 만들기 전 4,204문서 portable snapshot 승격과
지속적인 PostgreSQL 16 CI 통합 검증이 추가로 필요하다. 상세 계약은
`domain/postgres/README.md`를 따른다.

Turn N2는 이 위에 읽기 전용 Repository(`domain/postgres/reference-repository.mjs`)와
기존 Runtime Store 계약 3개(FactStore/EvidenceStore/StructuredStore)용 얇은
adapter(`domain/postgres/reference-runtime-adapters.mjs`)를 추가했다. 실제
PostgreSQL 16에서 v0.20-r3 bundle을 적재한 뒤, 이 Repository의 조회 결과를 portable
`seed-structured-query-adapter.mjs`와 VERIFIED_FACT 87 / VERIFIED_EVIDENCE 219 /
VERIFIED_EVENT 24 / VERIFIED_RELATION 40 **전량**에 대해 레코드 단위로 비교해
동일함을 확인했다(`npm run test:reference-repository:postgres16`, 13/13 PASS).
**이 Repository/Adapter는 아직 production Runtime(`configured-seed-runtime.mjs`,
`GET /answer`)에 연결되지 않았다** — 여전히 portable bundle-backed Runtime만
production 경로다. pgvector/BM25/embedding/reranker, 전체 4,204문서 확장, 작업자별
검색 namespace는 이번 Turn 범위 밖이며 손대지 않았다.

완료 기준: 새 서버의 빈 DB를 v0.20 bundle만으로 동일하게 복원하고 동일 질의 결과를 재현한다.

### Phase 2 — 평가 데이터 확대

- [ ] 질문 후보 Pool 300~500 작성
- [ ] 문서·사건·정정 chain 기준으로 split 선배정
- [ ] Anchor Gold 120~150 작성·상호 검수
- [ ] 최종 Gold 300 확정
- [ ] `DEV_TUNE 150 / DEV_CHECK 50 / HOLDOUT 100` 동결
- [ ] 별도 Challenge 50~80과 동적 Regression 구성
- [ ] Critical Slice와 metric 판정 기준 확정

주의: 현재 Seed 25문항은 배선·계약·회귀 검사에는 충분하지만 일반화 성능을 증명하는 데이터는 아니다.

### Phase 3 — 작업자별 Agent 구현

각 작업자는 자신의 브랜치와 namespace에서 다음을 수행한다.

- [ ] AgentFlow와 실행 manifest 작성
- [ ] 검색/계획/도구 호출 전략 구현
- [ ] 공통 Reference DB는 읽기 전용으로 사용
- [ ] 실행 예산, timeout, HCX 호출 수와 외부 자원 사용량 기록
- [ ] 동일 Anchor/Harness로 결과 제출
- [ ] 실패 사례만 Regression으로 추가

작업자 간 비교 시 코드 형태가 아니라 Evidence 완전성, 정답 정확도, 안전 위반, latency, 비용과 재현성을 비교한다.

### Phase 4 — 검색 실험과 Agent 선정

- [ ] Fixed 512 + Kiwi BM25 기준선 측정
- [ ] section-aware/parent-child/table-aware chunking 비교
- [ ] Dense와 RRF까지 동일 Anchor에서 비교
- [ ] 필요할 때만 reranker 추가
- [ ] 사전에 고정한 Hard Gate와 selection rule 적용
- [ ] 최종 Agent 하나를 선정한 뒤 유효한 아이디어만 한 번에 하나씩 이식

HOLDOUT은 최종 동결 뒤 한 번만 사용한다. Seed 점수에 맞춘 질문별 분기나 문장 하드코딩은 금지한다.

### Phase 5 — 운영 DB·배포

- [ ] 선정 Agent 기준 운영 schema와 인덱스 확정
- [ ] production dependency 취약점 조치
- [ ] bundle materialization 임시 파일 정리 정책 추가
- [ ] 모니터링, 로그, backup/restore, resource limit 구성
- [ ] 보호된 브랜치·필수 리뷰·CI와 배포 승인 분리
- [ ] 실제 Public Endpoint에서 `/ready`와 `/answer` 검증
- [ ] 장애·변조·artifact 누락·timeout 부정 테스트

배포는 별도 승인 작업이다. 저장소 업로드나 release 데이터 승인이 곧 deployment 승인을 의미하지 않는다.

## 6. 현재 남은 위험과 우선순위

### P0 — 공유 전에 확인

- 기본 브랜치를 직접 덮어쓰지 말고 검수 브랜치와 리뷰를 사용한다.
- bundle entry의 안전 상대경로, 중복/누락/추가 role을 generic loader에서도 fail-closed하는지 재확인한다.
- 현재 bundle 자체의 21개 role/path/SHA가 안전한 상태인지 CI에서 다시 검증한다.

### P1 — 배포 전에 해결

- `npm audit --omit=dev`의 high 취약점과 실제 노출 경로를 검토하고 dependency를 갱신한다.
- repository 내부 Owner 문자열은 전자서명이 아니므로 branch protection과 서명된 tag/commit으로 최종 신뢰 경계를 보완한다.
- 성공한 runtime 종료 후 materialized 임시 디렉터리가 누적되지 않도록 정리한다.
- 운영자가 초기화 실패 원인을 확인할 수 있는 내부 로그를 제공하되 외부 응답에는 민감정보를 노출하지 않는다.

### P2 — 일반화 성능 확인

- 같은 Seed 25문항으로 반복 수정했으므로 구조적 과적합은 낮아도 경험적 일반화 증거는 아직 부족하다.
- 새로운 chain-safe Anchor/DEV_CHECK/HOLDOUT으로 검증하기 전에는 “전체 질문에 일반화됐다”고 선언하지 않는다.
- 새 오류가 실제 데이터·계약·평가에서 재현되지 않는 한 온톨로지나 Sub-request 연구를 다시 확장하지 않는다.

## 7. 팀 작업 규칙

1. 공통 정본은 직접 수정하지 않고 새 revision과 migration으로 변경한다.
2. 공식 입력/API/평가 경계 변경은 Owner 승인과 계약 테스트를 요구한다.
3. 작업자별 검색 데이터는 별도 namespace에 저장한다.
4. 개인 절대경로, 원본 corpus, 비밀값과 재생성 불가능한 index를 Git에 넣지 않는다.
5. 질문 ID·회사명·문서 ID·Gold를 이용한 특수 분기를 만들지 않는다.
6. Seed는 기능 배선과 회귀에 사용하고 전략 선택은 Anchor 이상 데이터로 수행한다.
7. 결과 보고에는 commit, config, artifact SHA, 실행 비용, latency와 실패 목록을 포함한다.
8. 공통 계약은 최소화하고, Agent 내부 설계의 자율성을 기본값으로 유지한다.

## 8. 바로 다음 실행 항목

1. 이 검수 브랜치를 팀에서 리뷰하고 CI를 통과시킨다.
2. Reference PostgreSQL schema/loader를 별도 작은 작업으로 시작한다.
3. 동시에 평가 질문 Pool과 chain-safe split 작성자를 배정한다.
4. DB 적재 계약이 고정되면 각 작업자가 AgentFlow 실험 브랜치를 만든다.
5. Anchor가 준비되면 동일 Harness로 첫 기준선(BM25)을 측정한다.

여기서부터는 “통일 작업을 더 만드는 단계”가 아니라, **고정된 최소 공통 기반 위에서 데이터를 확대하고 서로 다른 Agent 전략을 공정하게 비교하는 단계**다.
