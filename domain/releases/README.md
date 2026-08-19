# Seed release locks

`work/` 아래의 Seed 산출물은 대용량·로컬 작업 데이터라 Git에서 제외한다. 이 디렉터리의
manifest는 해당 산출물의 경로, 크기, 레코드 수, SHA-256과 교차 참조 불변식을 Git으로
추적한다.

Release lock은 데이터 자체의 외부 백업을 대신하지 않는다. 다음 두 조건을 모두 만족해야
복구 가능한 정본으로 취급한다.

1. manifest에 기록된 파일을 공유 저장소·Git LFS·immutable archive 중 하나에 보관한다.
2. 새 환경에서 `npm run seed:verify-release`가 성공한다.

`release_status=BLOCKED_FOR_E2E`는 바이트 정본이 잠겼지만 의미 검수·Fact Coverage·Flow A
등 E2E 선행 조건이 남았다는 뜻이다. 이를 `READY_FOR_E2E`나 최종 Gold로 해석하지 않는다.

## 현재 상태 요약 (Turn M11 기준)

아래 두 절("v0.20 release-binding checklist"와 "Turn L2")은 v0.20이 아직 생성되지
않았던 시점에 작성된 **historical/pre-v0.20 사전 설계 문서**다. 감사 이력으로
보존하며 삭제하지 않지만, 현재 상태를 확인하려면 이 절을 먼저 읽는다.

- **release 상태**: `seed-release-v0.20`은 `domain/releases/seed-release.v0.20.decision.json`
  기준 `status: "APPROVED"`다(더 이상 미생성이 아니다). `supersession_note`는 Owner가
  검수한 v0.20-r3 Candidate의 데이터·clean Plan v0.13·응답 출력·Q18 정보한계 정책을
  그대로 최종 승인했다고 기록한다.
- **Company Directory**: production은 `seed-company-directory.v0.1.candidate.*`가
  아니라 **v0.2 approved**(`seed-company-directory.v0.2.approved.jsonl`/`.manifest.json`/
  `-owner-decision.v0.2.approved.json`)를 사용한다. v0.1 candidate는 감사 이력으로만
  남는다.
- **portable bundle**: `domain/releases/bundles/seed-release-v0.20-r3.candidate/`가
  Git에 추적돼 있으며(더 이상 untracked가 아니다), `domain/runtime/configured-seed-runtime.mjs`가
  이 r3 bundle 디렉터리와 `seed-release.v0.20.manifest.json`/`.decision.json`을 직접
  가리킨다(`EXPECTED_RELEASE_ID = "seed-release-v0.20"`). production runtime은 이제
  bundle-backed v0.20에 결합돼 있다.
- **bundle 경로 안전성**: Turn M11에서 `seed-release-bundle-unpack.mjs`에 절대경로·`..`·
  symlink escape·duplicate/unknown role에 대한 fail-closed 검증을 추가했다(독립 검수가
  재현한 실제 경로 traversal 결함의 수정) — 자세한 내용은
  `domain/adapters/bundle-manifest-path-safety.mjs`.
- **GitHub 인계**: 이 브랜치(`codex/common-baseline-v020-handoff`)는 GitHub에 push
  완료됐다. 단, 이는 사용자의 명시적 별도 지시로 이루어진 것이며, v0.20 decision
  자체의 `release_authorization.push_authorized`/`deployment_authorized` 필드는 여전히
  둘 다 `false`다 — 이 decision은 release **데이터 내용**만 승인했을 뿐, GitHub push나
  실제 production deployment를 승인한 것이 아니다. `push_authorized`/`deployment_authorized`는
  release 데이터 승인과는 별도의 정책 경계이며, 실제 public deployment는 **아직
  수행되지 않았다.**
- **clean-clone 재현성**: production runtime 경로(git clone → `npm ci --omit=dev` →
  `/ready`/`/answer`)는 새 clone에서 독립적으로 재현·검증됐다
  (`tests/seed-release-isolated-deployment-official-clean-clone.test.mjs`). 반면 과거
  `work/domain-seed/` 산출물을 직접 참조하는 개발/audit 테스트 다수는 그 디렉터리
  전체가 Git에 없어 새 clone에서 재현되지 않는다 — 자세한 내용은 `PROJECT_NEXT_STEPS.md`.

## Release authorization: decision artifact 계약

`domain/adapters/seed-runtime-service-adapters.mjs`는 canonical release manifest의
`release_authorization` 블록을 자기 선언만으로 신뢰하지 않는다. Runtime을 생성하려면
다음이 모두 성립해야 한다.

1. `release_authorization.decision_artifact_path`가 root 기준 안전한 상대 경로여야 한다
   (절대 경로·`..` 탈출·symlink alias 거부).
2. 그 경로의 실제 파일을 raw byte로 읽어 SHA-256을 계산하고
   `decision_artifact_sha256`과 정확히 일치해야 한다.
3. decision artifact는 **자유 형식 Markdown이 아니라 기계 검증 가능한 JSON**이어야
   하며, 그 내용이 `status`/`approved_by`/`approved_at`을 manifest의 자기 선언과
   독립적으로 재확인해야 한다.
4. decision artifact는 승인 대상 전체 release bundle을 고정해야 한다: 두 manifest
   (canonical/structured) 각각의 경로+내용 해시, `corpus_snapshot_id`,
   `fact_coverage_snapshot_id`, `release_id`, 승인한 revision, 그리고 두 manifest에
   선언된 모든 artifact의 role·path·sha256·record_count.
5. 실제로 전달된 두 manifest 경로는 root 기준으로 정규화한 뒤 decision artifact가
   선언한 경로와 정확히 일치해야 한다. 동일 바이트를 다른 경로에 복사하거나, 다른
   경로를 symlink로 별칭 지정해도 통과하지 못한다.

경로/해시/artifact 목록/snapshot ID 중 하나라도 불일치하면 construction은
`RELEASE_NOT_APPROVED`로 fail-closed한다. 계약 테스트는
`tests/release-authorization-boundary.test.mjs`에 있다.

## Release Gate: 승인 신원의 한계와 최종 신뢰 anchor

이 decision artifact 검증은 **암호학적 서명 검증이 아니다.** `approved_by`는 저장소
내부의 절차적 assertion(문자열 필드)일 뿐이며, 이 필드 자체의 진위나 서명 여부를
암호학적으로 증명하지 않는다. decision artifact JSON 파일에 접근하고 저장소에 그
파일을 커밋할 수 있는 사람이라면 누구나 원칙적으로 `approved_by` 값을 채울 수 있다.
이 계층이 실제로 막는 것은 다음이다.

- 승인 없이 임의 manifest를 Runtime에 연결하는 것 (자기 선언 `status:"APPROVED"`만으로
  통과하던 이전 결함).
- 승인된 decision artifact의 내용을 조작하거나, 승인 대상과 다른 데이터를 몰래
  바꿔치기하는 것 (경로/해시/artifact 목록 불일치).

이 계층이 막지 못하는 것은 다음이다.

- 저장소에 쓰기 권한이 있는 사람이 승인되지 않은 decision artifact를 직접 작성해
  커밋하는 것. **이를 막는 최종 배포 신뢰 anchor는 이 코드가 아니라 보호된
  브랜치(protected branch)의 리뷰 요구사항, 또는 서명된 release tag/commit이다.**
  즉 "누가 이 저장소에 `release_authorization`이 가리키는 decision artifact를
  커밋할 수 있는가"를 통제하는 것은 Git 호스팅 플랫폼의 브랜치 보호 규칙과 코드
  리뷰 절차이며, 이 문서가 설명하는 애플리케이션 코드가 아니다.
- decision artifact 자체의 위조(예: 실제 Owner가 승인하지 않았는데도 승인한 것처럼
  파일을 작성)를 코드 수준에서 탐지하는 것.

전자서명(예: decision artifact에 대한 실제 암호학적 서명과 공개키 검증) 기능은 이번
범위에서 구현하지 않는다. 이는 별도 작업으로 추적하며, 그 전까지 `approved_by`는
"이 저장소 안에서 통제된 변경 이력을 통해 기록된 절차적 승인 표시"로만 취급하고,
실제 배포 승인 여부는 여전히 protected branch·코드 리뷰·release tag 서명 등 Git
플랫폼 계층의 통제에 의존한다.

## [HISTORICAL/PRE-v0.20] v0.20 release-binding checklist (Turn K: 사전 설계 문서)

> **이 절은 v0.20이 실제로 생성·승인되기 이전(Turn K)에 작성된 사전 설계 문서다.**
> v0.20은 이후 실제로 생성되어 APPROVED됐다(위 "현재 상태 요약" 참고). 아래 본문은
> 그 시점의 "아직 생성되지 않았다"는 서술을 그대로 보존한 감사 이력이며, 현재
> 상태를 설명하지 않는다. Company Directory 경로도 v0.1 candidate를 가리키는 채로
> 남아 있다 — 실제 production은 v0.2 approved를 쓴다.

이 절은 아직 생성되지 않은 v0.20 manifest/decision을 위한 필수 결합 목록만 기록한다.
v0.19는 이 절 때문에 수정하지 않으며, 이 절 자체도 실제 v0.20 파일을 생성하지 않는다.
v0.20 decision artifact를 작성할 때는 기존 `release_authorization` 계약(위 절)에
더해 다음 세 자산을 **명시적으로 pin**해야 한다.

1. **Company Directory 자산.** `COMPANY_DIRECTORY` artifact
   (`work/domain-seed/seed-company-directory.v0.1.candidate.jsonl`)와 그 manifest
   (`work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json`)의 경로와
   내용 SHA-256, record_count.
2. **Company Directory Owner decision.** 승인된 decision artifact 경로
   (`work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json`)의
   SHA-256, `reviewer`, `reviewed_at` (ISO 8601). 이 decision 자체의
   `corpus_snapshot_id`는 v0.20이 고정하는 corpus_snapshot_id와 반드시 일치해야 한다.
3. **Timeline Fact Narrative Policy decision.** 승인된 decision artifact 경로
   (`work/domain-seed/seed-timeline-fact-narrative-policy-decision.v0.1.json`)의
   SHA-256.

### 강제 정책

v0.20을 가리키는 **production 호출자**(`domain/runtime/configured-seed-runtime.mjs`)는
Company Directory 결합을 optional/no-op으로 둘 수 없다. 위 1·2번 자산 중 하나라도
누락되거나 해시/경로/승인 상태가 어긋나면 Runtime 생성 전체가
`RELEASE_NOT_APPROVED`로 fail-closed해야 한다. 이는 이미
`domain/adapters/seed-runtime-service-adapters.mjs`의 `requireCompanyDirectory` 플래그
(Turn K에서 추가, `configured-seed-runtime.mjs`에서 `true`로 하드코딩됨)로 코드
수준에서 구현·테스트되어 있다 (`tests/seed-runtime-service-adapters.test.mjs`의
"Turn K: requireCompanyDirectory production policy" 절 참고).

generic/test adapter 호출(즉 `createSeedRuntimeServiceAdapters`를 직접, production
singleton을 거치지 않고 호출하는 모든 fixture/audit 스크립트)은 계속
`requireCompanyDirectory`를 생략(기본값 `false`, no-op)할 수 있다. 이 정책은 caller별
opt-in이며, 전역 필수 조건이 아니다.

Timeline Fact Narrative Policy decision (3번)은 현재 코드 경계에서 강제되지 않는다
(`domain/flows/synthesis/gap-classification.mjs`가 이미 그 정책을 제네릭하게 반영하고
있으므로, Runtime 생성 자체를 막을 필요는 없다). v0.20 decision artifact는 감사
가능성을 위해 이 정책의 SHA-256을 pin하지만, 이는 Runtime 구성 성공/실패 조건이
아니라 release 이력 기록이다.

### [HISTORICAL/PRE-v0.20] Turn L2: portable bundle의 Git 추적 상태와 CANDIDATE/OFFICIAL 검증 분리

> **이 절도 v0.20 최종 승인 이전(Turn L2) 시점의 기록이다.** "아직 git add/commit을
> 하지 않았다", "untracked(`??`)로 보이는 상태" 서술은 현재 상태가 아니다 — 지금은
> `seed-release-v0.20-r3.candidate/` bundle이 실제로 Git에 추적돼 있고
> `configured-seed-runtime.mjs`가 그것을 직접 가리킨다(위 "현재 상태 요약" 참고).
> Isolated portability 검증(CANDIDATE/OFFICIAL 계층 분리 자체)에 대한 아래 설명은
> 여전히 유효하다.

`domain/releases/bundles/`는 더 이상 전체가 gitignore되지 않는다. `.gitignore`는
`/domain/releases/bundles/*` 뒤에 `!/domain/releases/bundles/seed-release-v0.20/`
negate rule을 두어, 결정론적으로 gzip 압축된(모든 개별 파일 100MiB 미만, 원본
비압축 121MB DocumentIR 없음) `seed-release-v0.20/` bundle만 Git 추적 대상으로
남긴다. 다른 미래 bundle 디렉터리는 기본적으로 계속 ignore된다. (이후 실제로
`git add`/commit됐다 -- 이 절 작성 시점에는 `git status --short -uall`에서 개별
파일이 untracked(`??`)로 보이는 상태였다.)

이 bundle은 `scripts/build-seed-release-v020-candidate-bundle.mjs`로 재현 가능하게
생성되며, Company Directory는 `seed-company-directory.v0.2.approved.*`
(Turn K item F의 byte-equivalent 승격본)만 참조한다. v0.1 candidate는 감사 이력
으로만 남는다. (이 절 작성 시점에는 `domain/runtime/configured-seed-runtime.mjs`가
여전히 v0.1을 가리키며 수정되지 않은 상태였다 -- v0.2 bundle 검증은
`scripts/start-agent-server-v020-candidate.mjs`(운영 진입점이 아닌, 테스트 전용
config-injection 스크립트)를 통해서만 이루어졌다. 이후 v0.20 최종 승인과 함께
`configured-seed-runtime.mjs` 자체가 bundle-backed v0.20을 직접 가리키도록
바뀌었다 -- 위 "현재 상태 요약" 참고.)

Isolated portability 검증은 서로 다른 주장을 하는 두 계층으로 분리되어 있다:

- **CANDIDATE** (`tests/seed-release-isolated-deployment-candidate.test.mjs`):
  실제 `domain/releases/bundles/seed-release-v0.20/`를 byte-for-byte 복사(복사
  전후 bundle-manifest·모든 encoded artifact SHA 비교)해 격리 환경에 unpack하고,
  소스 코드는 `git ls-files`가 아니라 명시적 allowlist(`domain/`, `scripts/`,
  `package.json`, `package-lock.json`)로 복사한다. node_modules는 손으로 고른
  ajv 관련 subset만 복사한다(smoke test 전용, `npm install` 없음). 현재 dirty
  worktree에서도 실행 가능하며 `release_eligible: false`를 항상 보고하고,
  **"git clone 재현"이라고 주장하지 않는다.**
- **OFFICIAL** (`tests/seed-release-isolated-deployment-official-clean-clone.test.mjs`):
  `git archive HEAD` + 실제 `npm ci`만 사용한다. 이 Turn 기준 Runtime 코드와
  bundle-manifest.json이 아직 커밋되지 않았으므로, 실행 전에 필수 경로가
  `git ls-files --cached`에 있는지 사전 점검하고 없으면 실제 배포 시도 없이
  `BLOCKED_BY_UNCOMMITTED_SOURCE`를 명시적으로 보고한다(요약 테스트는 이 감지
  자체를 검증하며 항상 PASS, 나머지 테스트는 사유와 함께 skip된다). 이 파일이
  실제로 전부 PASS해야만 "clean-clone release_eligible verified true"라고 부를
  수 있다 -- 선택적 커밋 이전에는 이 상태에 도달할 수 없다.

