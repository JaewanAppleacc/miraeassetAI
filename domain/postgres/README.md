# Reference PostgreSQL

## 역할

PostgreSQL은 승인된 release의 구조화 데이터와 provenance를 모든 Agent가 동일하게
조회하는 공통 Source of Record다. portable bundle은 새 환경으로 옮길 수 있는 정본
artifact이고, PostgreSQL은 그 bytes를 검증한 뒤 생성되는 runtime materialization이다.

공통 DB에 저장하는 것:

- release·snapshot·artifact SHA와 record count
- Canonical DocumentIR Seed subset
- Company Directory
- VERIFIED Evidence, Fact, Event, Relation과 Chain
- Coverage, Gold, Thin Plan과 승인 이력

공통 DB에 저장하지 않거나 강제하지 않는 것:

- embedding model과 vector
- BM25/Dense/RRF/reranker 구성
- worker별 cache, feature와 검색 순위
- Agent 내부 상태와 Planner 구현

작업자별 검색 파생물은 별도 PostgreSQL schema나 별도 검색 엔진에 만들고,
`disclosure_reference` schema의 READY release는 수정하지 않는다.

## 선택

- 공통 기준: PostgreSQL 16
- Node driver: `pg` 8.23.0
- 선택 확장: pgvector는 Dense 실험을 선택한 작업자 schema에서만 사용
- BM25 기준선: PostgreSQL FTS 또는 별도 Tantivy 계층을 실험으로 비교하며 공통
  schema에는 고정하지 않음

Cloudflare UI용 `db/`의 D1 설정은 이 Reference DB와 다른 용도다. D1은 공통
Fact/Evidence Source of Record가 아니다.

## 현재 데이터 범위

v0.20-r3 bundle의 Canonical DocumentIR는 Seed 실행에 필요한 68 records(54 base +
14 delta)다. 전체 대회 코퍼스 4,204문서를 포함하지 않는다. 따라서 이 loader는 Seed
API·평가·DB 배선 기준선이며, 전체 retrieval index를 만들기 전에는 4,204문서
Canonical DocumentIR의 별도 portable snapshot 승격이 필요하다.

## 적재

빈 PostgreSQL 데이터베이스에만 명시적으로 연결한다.

```bash
DATABASE_URL='postgresql://...' npm run db:reference:load
```

loader는 `server_version_num`을 먼저 확인하며 PostgreSQL 16이 아니면 migration 전에
거부한다. 연결 문자열은 반드시 호출자가 제공하고 코드에 기본 계정이나 비밀번호를 두지
않는다.

loader는 다음 순서로 동작한다.

1. final manifest/decision과 외부 bundle-manifest SHA pin 검증
2. bundle entry path·role·encoded/decoded SHA·gzip limit 검증
3. private temporary directory에 materialize
4. fatal UTF-8·JSON·record key·record count 검증
5. 단일 PostgreSQL transaction으로 `LOADING` import
6. 모든 record가 성공한 뒤에만 `READY` 전환
7. 실패 시 rollback 및 temporary directory 정리

동일 release/hash를 다시 적재하면 `ALREADY_LOADED`이고, 같은 release ID에 다른
hash가 들어오면 거부한다. READY release의 artifact/record는 trigger로 update/delete를
거부하며, LOADING → READY 전환 중에는 release_id·revision·모든 snapshot ID·모든 SHA
pin·bundle entry count·bundle/final manifest와 decision의 raw payload·created_at이
전부 함께 고정된다(`disclosure_reference.guard_release_transition`).

## 권한 (읽기 전용 Agent role / writer role)

`002_reference_release.sql` migration은 어떤 전역 role도 생성하지 않는다. Agent
Runtime용 읽기 전용 role이나 loader 자신이 쓸 writer role은 호출자가 이미 만든
role 이름을 `domain/postgres/reference-release-grants.mjs`에 명시적으로 전달해야
적용된다.

```js
import { applyReferenceReaderGrant, applyReferenceWriterGrant } from "./reference-release-grants.mjs";

await applyReferenceReaderGrant({ client, roleName: "agent_runtime_reader" }); // SELECT만
await applyReferenceWriterGrant({ client, roleName: "reference_loader_writer" }); // releases/artifacts: SELECT/INSERT/UPDATE, records: SELECT/INSERT만 (DELETE는 어디에도 없음)
```

writer role도 GRANT만으로는 READY release를 바꿀 수 없다 — 위 immutability trigger가
GRANT 여부와 무관하게 SQL 레벨에서 거부한다. role 이름은 안전한 PostgreSQL 식별자
패턴(`^[a-z_][a-z0-9_]*$`)만 허용하며, `CREATE ROLE` 자체는 이 프로젝트가 대신 실행하지
않는다(운영자/호출자의 결정 사항).

## PostgreSQL 16 통합 테스트 (실제 서버 필요, 기본 `verify:contracts`에는 없음)

`npm run test:reference-db`(계약 테스트 + fake client)는 기본 검증에 포함되지만, 실제
PostgreSQL 16 서버에 대한 통합 테스트는 별도 명령이다.

```bash
DATABASE_URL='postgresql://user:pass@localhost:5432/scratch_db' \
  npm run test:reference-db:postgres16
```

대상 DB는 반드시 빈 scratch DB여야 한다. `DATABASE_URL`이 없으면 이 스위트는 조용히
skip하지 않고 `POSTGRESQL_16_INTEGRATION_NOT_RUN` 오류로 명시적으로 실패한다.

CI에서 실행하려면(예: GitHub Actions) 다음과 같은 `postgres:16` service가 필요하다.

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_USER: disclosure_test
      POSTGRES_PASSWORD: disclosure_test
      POSTGRES_DB: disclosure_reference_scratch
    ports: ["5432:5432"]
    options: >-
      --health-cmd pg_isready
      --health-interval 5s
      --health-timeout 5s
      --health-retries 10
env:
  DATABASE_URL: postgresql://disclosure_test:disclosure_test@localhost:5432/disclosure_reference_scratch
```

이 통합 스위트는 빈 DB migration, 실제 v0.20-r3 bundle 적재(21 artifact/792
record/READY), 재적재 `ALREADY_LOADED`, 실패 시 rollback(0 rows), READY mutation의
실제 SQL 거부, reader/writer role의 실제 GRANT 동작까지 검증한다. Turn N1.2에서 이
환경에 Homebrew PostgreSQL 16.15를 직접 설치해(`brew services`는 사용하지 않고
`pg_ctl`로 격리된 scratch 인스턴스만 기동) 실제로 실행했고, 12/12 PASS로 통과했다
(카스케이드 삭제 트리거 가시성 버그와 `declared_record_count` 의미 불일치라는 두 실제
결함을 이 과정에서 발견·수정함 — 자세한 내용은 커밋 이력 참고).

`npm run test:reference-repository:postgres16`(Turn N2, 아래 "Repository/Adapter"
절 참고)도 동일한 방식으로 실행해 13개 항목이 모두 통과했다.

## 다음 단계

**Turn N3.1 이후 다음 우선순위는 평가 데이터(Gold Pool/chain-safe split) 확대다.**
아래 항목은 평가 데이터 확대와 **병행**하는 별도 트랙이며, 그중 어느 것도 평가 데이터
작성을 시작하기 위한 선행조건이 아니다 — 특히 전체 4,204문서 PostgreSQL projection과
production wiring 여부는 평가 데이터 확대와 독립적으로 결정한다.

1. (병행) 전체 4,204 DocumentIR portable snapshot 준비
2. (병행) `001_core.sql`의 정규화 projection과 Reference record 간 변환 확정
3. (병행) 작업자별 검색 namespace/schema는 공통 migration 밖에서 각자 생성
4. (병행) BM25 기준선부터 동일 Harness로 측정
5. (production wiring 결정 — 평가 데이터 확대의 선행조건 아님) Repository/Adapter를
   실제 production Runtime(`configured-seed-runtime.mjs`)에 연결할지 여부와 시점 결정

## Repository/Adapter (Turn N2)

`domain/postgres/reference-repository.mjs`는 pinned·READY release 하나를 읽기
전용으로 제공하는 공통 Repository다. `domain/postgres/reference-runtime-adapters.mjs`는
이 Repository 하나를 공유하며 기존 Runtime Store 계약 3개(`domain/runtime/fact-store.mjs`,
`domain/runtime/citation-validator.mjs`, `domain/runtime/structured-store.mjs`)에
연결하는 얇은 adapter 3개를 제공한다. SQL과 검증 로직은 Repository 한 곳에만 있고,
세 adapter는 호출 규약만 번역한다.

역할:

- **Repository**: `getFact`/`getEvidence`/`getEvent`/`getRelation`(ID 단건 조회)과
  `queryFacts`/`queryEvents`/`queryRelations`/`queryEvidence`(StructuredQuery와 동일한
  필터 — corp_codes, metric_codes/event_types/relation_types, document_ids, 기간/scope,
  verification_statuses, as_of_date, limit)를 제공한다.
- **Adapter**: Repository를 감싸 각 Runtime Store가 기대하는 envelope(`{ corpus_snapshot_id,
  record }` 등)과 StructuredResult 모양으로만 번역한다. status/code 판정은 여전히
  fact-store.mjs/citation-validator.mjs/structured-store.mjs 자신이 한다.

필수 release/snapshot pin:

```js
import { createPostgresReferenceRepository } from "./reference-repository.mjs";

const repo = await createPostgresReferenceRepository({
  client, // 또는 pool -- lifecycle은 호출자 소유, 이 모듈은 절대 end()/release()하지 않음
  expectedReleaseId: "seed-release-v0.20",
  expectedCorpusSnapshotId: "corpus_04750795e1a2d5c3",
  expectedApprovedRevision: "seed-structured-artifacts-v0.7",
  expectedFactCoverageSnapshotId: "fact_coverage_snapshot_87ad2fa54e8ab7f7543c1ce3",
});
```

다섯 인자 모두 필수다(하나라도 빠지면 `TypeError`). 생성 시점에 실제
`disclosure_reference.releases` row를 조회해 `status='READY'`와 네 pin을 전부 검증하고,
release가 없거나 LOADING이거나 어느 pin이라도 다르면 즉시 실패한다 — 가장 최신
READY release로 자동 대체하지 않고, `ORDER BY imported_at DESC LIMIT 1` 같은 코드는
이 파일에 없다. `get*`/`query*`는 매 호출마다 새로 parameter-bound SELECT를 실행한다
(구성 시점 캐시 없음 -- READY release는 트리거로 불변이 보장되므로 안전하다).

일반 개발용 사용 예(Runtime Store에 연결):

```js
import { createPostgresFactStoreAdapter, createPostgresStructuredStoreAdapter } from "./reference-runtime-adapters.mjs";
import { createFactStore } from "../runtime/fact-store.mjs";
import { createStructuredStore } from "../runtime/structured-store.mjs";

const context = { corpus_snapshot_id: repo.corpusSnapshotId, fact_coverage_snapshot_id: repo.factCoverageSnapshotId };
const factStore = createFactStore(createPostgresFactStoreAdapter(repo), context);
const structuredStore = createStructuredStore(createPostgresStructuredStoreAdapter(repo), context);
```

**production Runtime에는 아직 연결되지 않았다.** `configured-seed-runtime.mjs`와
`GET /answer`는 이번 Turn에서 수정하지 않았고, 여전히 portable bundle-backed Runtime
그대로 동작한다 — 이 Repository/Adapter는 독립적으로 테스트된 새 계층일 뿐, 아직 어떤
production 경로에도 배선되지 않았다.

**pgvector/BM25/embedding/reranker는 이번 Turn 범위 밖이다.** 이 Repository는
`disclosure_reference.records`의 정확한 매치 필터(corp_code/metric_code/document_id
등)만 지원하며, 유사도 검색이나 랭킹은 구현하지 않는다.

동일성 검증: `tests/reference-repository-postgres16-integration.test.mjs`가 실제
PostgreSQL 16에서 v0.20-r3 bundle을 적재한 뒤, 이 Repository의 결과와 portable
`domain/adapters/seed-structured-query-adapter.mjs`의 결과를 VERIFIED_FACT 87건,
VERIFIED_EVIDENCE 219건, VERIFIED_EVENT 24건, VERIFIED_RELATION 40건 **전량**에 대해
레코드 단위로 완전히 비교한다(대표 필터 조합 포함).

## Bundle vs PostgreSQL 읽기 경로 비교 (Turn N3)

production `GET /answer`가 실제로 사용하는 것은 `seed-structured-query-adapter.mjs`
하나가 아니다. `domain/adapters/seed-runtime-service-adapters.mjs`(=
`createSeedRuntimeServiceAdapters`, `configured-seed-runtime.mjs`가 호출하는 실제
production wiring)는 unpack된 bundle 위에 서로 다른 세 어댑터를 따로 구성한다.

| 기능 | portable bundle 경로 | PostgreSQL Repository 경로 |
| --- | --- | --- |
| `getFact(id)` | `seed-fact-artifact-store.mjs`의 `getFact` — **Coverage Snapshot이 authorize한 fact_id만** 서빙(coverage slot에 없는 VERIFIED Fact는 존재하지 않는 것과 동일하게 처리). 반환 `{ corpus_snapshot_id, fact_coverage_snapshot_id, record }` \| `null` | 두 가지 경로가 있다(Turn N3.1). **raw `reference-repository.mjs`의 `getFact`**: 해당 release의 **모든** VERIFIED_FACT row를 authorize 없이 서빙(감사·진단 전용, 반환은 `payload` \| `null`). **`coverage-authorized-fact-view.mjs`의 `getFact`**(Agent가 실제로 써야 하는 경로): bundle과 동일하게 Coverage-authorize된 fact_id만 서빙, 그 외는 `null` |
| `getEvidence(id)` | `seed-evidence-artifact-store.mjs`의 `getEvidence` — manifest가 선언한 evidence_id 전체 서빙. 반환 `{ corpus_snapshot_id, record }` \| `null` | `getEvidence` — 해당 release의 모든 VERIFIED_EVIDENCE row 서빙. 반환은 `payload` \| `null` |
| `getEvent(id)` | **없음.** production wiring은 VERIFIED_EVENT를 `readPinnedJsonl`로 배열째 읽어 Thin Runner/Plan 로직에 직접 넘긴다 — 단건 조회 Runtime Store 계약(`{ getEvent }`) 자체가 bundle 쪽에 존재하지 않는다. 유일하게 개별 ID 존재 여부를 물을 수 있는 경로는 아래 `query()`뿐이다 | `getEvent` — 해당 release의 모든 VERIFIED_EVENT row 서빙 |
| `getRelation(id)` | **없음** (Event와 동일한 이유 — `readPinnedJsonl`로 배열째 소비) | `getRelation` — 해당 release의 모든 VERIFIED_RELATION row 서빙 |
| `query(structuredQuery)` | `seed-structured-query-adapter.mjs`의 `query` — 4개 role 전체를 메모리에 올려두고 filter+sort(known_at desc → FACT/EVENT/RELATION/EVIDENCE 순 → record_id asc)+limit | `createPostgresStructuredStoreAdapter`가 `queryFacts`/`queryEvents`/`queryRelations`/`queryEvidence`를 target별로 호출해 합치고, **동일한** sort 알고리즘으로 정렬+limit(두 구현이 의도적으로 같은 정렬 로직을 두 곳에 유지) |
| 반환 레코드 shape | `{ record_type, record_id, verification_status, known_at, source_document_ids, evidence_ids, payload }` (trimmed — corp_code/period/scope 등 filter 전용 필드는 반환되지 않음) | 동일 shape (`trimmedRecord`) |
| NOT_FOUND | `query()`는 빈 배열 + `status: "NOT_FOUND"`; `getFact`/`getEvidence`는 `null` | 동일 |
| DB/파일 오류 | 파일 read/hash/schema 실패는 construction 시점에 throw(구성 자체가 실패); 이미 구성된 뒤에는 in-memory 조회라 오류가 사실상 없음 | 매 `get*`/`query*` 호출마다 실제 SQL round trip — 진짜 DB 실패(connection 끊김 등)는 그 호출에서 throw되고, 절대 NOT_FOUND로 축소되지 않음(`tests/reference-repository.test.mjs`의 fail-closed 테스트로 검증) |
| 정렬 순서 | 계약: `known_at desc → record_type 순서 → record_id asc` | 동일 알고리즘을 독립적으로 두 번 구현(위 표 참고) — `tests/reference-repository-postgres16-integration.test.mjs`가 재정렬 없이 원본 순서 그대로 비교해 실측으로 확인 |
| mutation 안전성 | 반환 객체 `Object.freeze` + `structuredClone` — 호출자가 mutate 시도 시 TypeError, 다음 호출에 영향 없음 | 동일 |

**Coverage authorize 경계는 Turn N3.1에서 도입, Turn N3.1.1에서 production과
실질적으로 동일한 수준으로 굳어진 계약이다 (더 이상 "남은 위험"이나 예외 아님).**
Turn N3에서는 PostgreSQL `getFact`/`queryFacts`에 Coverage authorize 경계가 없어
Coverage가 Fact 전량보다 좁아지는 release에서 미승인 Fact가 노출될 수 있다는 점을
"알려진 비대칭"으로만 기록했다. Turn N3.1은 이를 막는 별도 계층
(`coverage-authorized-fact-view.mjs`)을 추가했지만, 그 초판은 두 가지 실제 결함이
있었다 — ① authorize 필터를 raw Repository의 `limit=1000` 내부 pre-fetch **뒤에**
적용해 전체 Fact가 1,000건을 넘으면 승인 Fact를 누락할 수 있었고, ② production
`seed-fact-artifact-store.mjs`가 수행하는 corp_code/metric_code/scope
direct-dimension-consistency 검사가 빠져 있었다. Turn N3.1.1이 이 두 결함을 모두
수정했다 — authorize 집합을 raw Repository의 `fact_ids` 필터로 push down해 limit
전에 적용하고(내부 1000-cap 자체를 제거), slot이 참조하는 각 Fact의 corp_code/
metric_code/(non-null) scope를 raw Repository의 pinned `getFact()`로 실제 대조한다.
v0.20-r3는 여전히 87개 Fact 전량이 authorize되고 모든 slot의 차원이 실제 Fact와
일치하여, raw/Agent-authorized/bundle production 세 경로의 결과가 실측으로 완전히
같다(`tests/reference-repository-postgres16-integration.test.mjs`의 Turn N3.1 3-way
parity 테스트로 검증). 부분 Coverage(일부만 authorize), 1,001건 이상의 Fact,
corp_code/metric_code/scope 불일치 시나리오는 모두 실제 PostgreSQL 16에 합성
release를 적재해 별도로 검증했다
(`tests/coverage-authorized-fact-view-postgres16-integration.test.mjs`).

## raw Repository vs Agent adapter (Turn N3.1)

`domain/postgres/reference-repository.mjs`(raw Repository)와
`domain/postgres/reference-runtime-adapters.mjs`의 `createPostgresFactStoreAdapter`/
`createPostgresStructuredStoreAdapter`(Turn N2, unauthorized adapter)는 **이번 Turn에서
의미를 바꾸지 않았다** — 여전히 release의 모든 VERIFIED_FACT를 authorize 없이 서빙하는
감사·진단용 정본 조회다. 코드베이스 안의 다른 모든 감사·디버깅 목적 조회(예:
`recordCounts()`)와 같은 층에 속한다.

Fact를 실제로 소비하는 Agent 코드는 대신 다음 새 계층을 사용해야 한다.

- **`domain/postgres/coverage-authorized-fact-view.mjs`의 `createCoverageAuthorizedFactView`**:
  raw Repository를 감싸 `getFact`/`queryFacts`에 Coverage authorize 경계를 적용한다 —
  **production `seed-fact-artifact-store.mjs`와 실질적으로 동일한 두 가지 검사를 모두
  수행한다(Turn N3.1.1, 예외 없음).**
  release의 FACT_COVERAGE_SNAPSHOT slot row(role=`FACT_COVERAGE_SNAPSHOT`,
  `record_key`=`slot_key`, `payload`=개별 slot 객체 — 전체 snapshot 문서가 아니라 slot
  하나당 DB row 하나) 전체를 읽어 모든 slot의 `fact_ids[]` 합집합을 authorize 집합으로
  삼는다. slot이 참조하는 각 fact_id는 raw Repository의 pinned `getFact()`로(고유
  fact_id당 한 번, 결과는 construction 동안 캐시) 실제 조회해 존재를 확인하고, 그
  payload와 slot의 **corp_code/metric_code/(slot.scope가 null/undefined가 아닌 경우)
  scope가 정확히 일치**하는지 검사한다(production의 direct-dimension-consistency 검사와
  동일한 규칙 — period_key는 검사하지 않는다, production도 검사하지 않으므로). 이 두
  검사 모두 raw SQL을 별도로 재구현하지 않고 raw Repository의 이미 integrity-검증된
  `getFact()` 경로만 사용하므로, Fact 총량이 몇 건이든(1,000건 이하든 이상이든) 스캔에
  의존하지 않는다. 같은 fact_id가 여러 slot에서 재사용되는 것은 production처럼
  허용하되, 재사용하는 slot 각각이 독립적으로 위 차원 검사를 통과해야 한다. Construction
  시점에 fail-closed하는 조건: `expectedFactCoverageSnapshotId`가 Repository 자신의
  pinned 값과 불일치, FACT_COVERAGE_SNAPSHOT row가 0건, slot의 `record_key`가 자신의
  `payload.slot_key`와 불일치, slot의 `verification_status`가 `VERIFIED`가 아님, slot의
  `fact_ids`가 배열이 아니거나 빈 문자열을 포함, slot이 참조하는 fact_id가 해당
  release의 실제 VERIFIED_FACT row로 resolve되지 않음, slot의 corp_code/metric_code/
  non-null scope가 그 fact_id의 실제 값과 불일치, 진짜 DB 오류.

  `queryFacts`의 `limit`은 항상 authorize 필터를 적용한 **뒤에** 계산된다 — raw
  Repository의 `fact_ids` 필터로 authorize 집합(호출자가 이미 `fact_ids`를 지정했다면
  그 교집합)을 **push down**해서 raw Repository 자신이 전체 레코드에 filter → sort →
  limit을 한 번에 적용하도록 한다(Turn N3.1.1 — 이전 버전은 raw Repository를
  `limit=1000`으로 먼저 조회한 뒤 authorize 필터링을 적용해, 전체 Fact가 1,000건을
  넘거나 상위 1,000건에 미승인 Fact가 몰리면 승인 Fact가 누락될 수 있었다. 이 pre-fetch
  cap은 완전히 제거됐다 — `tests/coverage-authorized-fact-view-postgres16-integration.test.mjs`의
  1,001건 real PostgreSQL 16 회귀 테스트로 검증). 교집합이 공집합이면 raw Repository를
  아예 호출하지 않고 즉시 빈 배열을 반환한다(Turn N3.1.2 — 이전 버전은 raw Repository
  SQL의 "빈 배열=무제한" 필터 의미를 우회하려고 실재하지 않는 fact_id 문자열을
  sentinel로 만들어 raw Repository를 호출했다; 이 sentinel은 완전히 제거됐다). signal이
  이미 aborted면 이 빈-교집합 경로에서도 `RequestAbortedError`를 던진다 — I/O가 없다는
  이유로 abort 계약을 건너뛰지 않는다. 진짜 DB 오류를 NOT_FOUND로 축소하는 경로는
  어디에도 없다.

  release_id는 항상 감싸고 있는 Repository의 `releaseId`로 scope되므로 다른 release의
  Coverage가 섞일 수 없다(구조적으로, 별도 검사가 필요 없음).
- **`createCoverageAuthorizedPostgresFactStoreAdapter`/`createCoverageAuthorizedPostgresStructuredStoreAdapter`**
  (`reference-runtime-adapters.mjs`에 추가): 위 authorized view를 Runtime Store envelope로
  감싼다. `createCoverageAuthorizedPostgresStructuredStoreAdapter`의 복합 query에서는
  FACT target만 authorized view를 거치고 EVENT/RELATION/EVIDENCE는 기존 unauthorized
  경로 그대로다 — 미승인 Fact 제거가 다른 role 결과에 전혀 영향을 주지 않는다.

**Agent가 사용해야 할 것은 raw Repository/unauthorized adapter가 아니라 이 두
coverage-authorized adapter다** — 아래 "Agent용 최소 읽기 인터페이스" 절 참고.
raw Repository/unauthorized adapter는 감사·디버깅 스크립트에서만 쓴다.

## Agent용 최소 읽기 인터페이스 (Turn N3, Turn N3.1로 갱신 — 문서화만, production 배선/구현 아님)

아래는 shadow parity 검증(Turn N3)과 Coverage authorize 경계(Turn N3.1)를 반영해
확정한, Agent 작업자가 기대할 수 있는 최소 공통 읽기 인터페이스다. **이 절은 문서일
뿐이며 어떤 production 코드도 바꾸지 않는다** — `configured-seed-runtime.mjs`/
`GET /answer`는 여전히 portable bundle-backed Runtime 그대로 동작한다.

**Fact는 반드시 Coverage-authorized 경로로 읽는다** — PostgreSQL 쪽에서는
raw `reference-repository.mjs`가 아니라 `coverage-authorized-fact-view.mjs`/
`createCoverageAuthorizedPostgresFactStoreAdapter`/
`createCoverageAuthorizedPostgresStructuredStoreAdapter`를 사용한다. Event/Relation/
Evidence는 Coverage 경계가 없으므로(bundle 쪽도 마찬가지) 기존 raw Repository/
unauthorized adapter 그대로 사용한다.

```text
getFact(fact_id)         -> record | null      (Coverage-authorized 경로에서만.
                                                  record: 원문 Fact payload)
getEvidence(evidence_id) -> record | null
getEvent(event_id)       -> record | null      (PostgreSQL Repository만 제공;
                                                  bundle 쪽은 query()로만 개별 ID 확인 가능)
getRelation(relation_id) -> record | null      (위와 동일한 비대칭)
query(structuredQuery)   -> { corpus_snapshot_id, fact_coverage_snapshot_id,
                               status: "OK" | "NOT_FOUND", error_codes: [],
                               records: [...] }  (두 경로 모두 제공, 동일 filter 의미.
                                                    PostgreSQL 쪽은 반드시
                                                    createCoverageAuthorizedPostgresStructuredStoreAdapter
                                                    사용 — FACT만 authorize 필터링,
                                                    다른 target은 영향 없음)
```

- **NOT_FOUND 의미**: 단건 조회는 `null`, `query()`는 빈 `records` 배열 +
  `status: "NOT_FOUND"`. 존재하지 않는 ID는 두 경로 모두 예외 없이 이 형태로만
  응답한다 — 절대 오류로 던지지 않는다.
- **DB/파일 오류 의미**: 진짜 실패(연결 끊김, 손상된 row, 손상된 파일)는 NOT_FOUND로
  축소되지 않고 그 호출에서 그대로 throw된다. Agent 구현은 NOT_FOUND(정상적인 "없음")와
  오류(비정상적인 "확인 불가")를 절대 같은 값으로 합치면 안 된다.
- **release/snapshot pin 요구사항**: PostgreSQL Repository는 `expectedReleaseId`,
  `expectedCorpusSnapshotId`, `expectedApprovedRevision`, `expectedFactCoverageSnapshotId`
  네 가지 pin을 전부 요구하며, 하나라도 불일치하거나 release가 READY가 아니면 즉시
  실패하고 절대 다른 release로 fallback하지 않는다. bundle 경로도 동일하게 pinned
  manifest/hash를 요구한다(구성 자체가 fail-closed). `createCoverageAuthorizedFactView`는
  자신의 `expectedFactCoverageSnapshotId`를 감싸고 있는 Repository의 pinned 값과
  다시 한 번 대조하며, 불일치·release가 READY가 아님·FACT_COVERAGE_SNAPSHOT row 0건은
  모두 construction 시점에 fail-closed한다(위 "raw Repository vs Agent adapter" 절
  참고).
- **반환값 불변성**: 두 경로 모두 매 호출마다 독립적인 frozen 복사본을 반환한다.
  호출자가 반환값을 mutate해도(시도 시 TypeError) 이후 호출 결과나 다른 호출자의
  view에 영향을 주지 않는다.
- **read-only 경계**: 두 경로 모두 쓰기 API를 제공하지 않는다. PostgreSQL 쪽은
  `disclosure_reference.records`/`releases`에 대해 SELECT만 issue하며(정적 grep
  테스트로 검증), Agent 읽기 전용 role(`agent_runtime_reader`)로 연결해도 전체
  조회 기능이 그대로 동작함을 실측으로 확인했다.
- **getEvent/getRelation 비대칭**: 위 비교 표대로, bundle 쪽에는 단건 조회
  Runtime Store 계약이 없다 — Agent가 두 경로를 모두 지원하는 코드를 작성하려면
  Event/Relation 단건 조회는 `query(targets:["EVENT"|"RELATION"], predicates:{event_ids|relation_ids:[id]})`로
  대체해야 한다(PostgreSQL의 `getEvent`/`getRelation`을 유일한 경로로 가정하면 안 됨).

새 Query Planner, 자연어→SQL, 새 Retriever/벡터 DB는 이 절의 범위가 아니며 만들지
않았다. shadow parity 검증 자체는 `domain/postgres/shadow-parity-comparator.mjs`
(baseline=bundle, shadow=PostgreSQL, 첫 mismatch만 role/query/id/field path로 보고,
production 응답을 절대 대체하지 않음)로 재사용 가능하게 분리했다 —
`tests/shadow-parity-comparator.test.mjs`(단위)와
`tests/reference-repository-postgres16-integration.test.mjs`(실제 PostgreSQL 16)
양쪽에서 사용한다. Coverage authorize 경계 자체는
`domain/postgres/coverage-authorized-fact-view.mjs` 한 곳에만 있다 —
`tests/coverage-authorized-fact-view.test.mjs`(fake client 단위)와
`tests/coverage-authorized-fact-view-postgres16-integration.test.mjs`(실제
PostgreSQL 16, 부분 Coverage 합성 fixture)로 검증한다.
