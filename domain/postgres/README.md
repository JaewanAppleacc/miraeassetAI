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
await applyReferenceWriterGrant({ client, roleName: "reference_loader_writer" }); // SELECT/INSERT/UPDATE/DELETE
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
실제 SQL 거부, reader/writer role의 실제 GRANT 동작까지 검증한다. 이 세션 환경에는
`psql`/`docker`/`podman`/로컬 PostgreSQL 16이 전혀 없어 이번 Turn에서는 실행하지
못했다 — `POSTGRESQL_16_INTEGRATION_NOT_RUN`으로 별도 보고한다.

## 다음 단계

1. 실제 PostgreSQL 16 서버(CI service 또는 로컬 Docker)에서 위 통합 테스트 실행
2. 전체 4,204 DocumentIR portable snapshot 준비
3. `001_core.sql`의 정규화 projection과 Reference record 간 변환 확정
4. 작업자별 검색 namespace/schema는 공통 migration 밖에서 각자 생성
5. BM25 기준선부터 동일 Harness로 측정
