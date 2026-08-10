# Disclosure Analyst — Claude Code Implementation Contract

이 문서는 Claude Code가 구현 작업을 시작하기 전에 읽어야 하는 최상위 계약이다.
대화 중 새로 떠오른 아이디어보다 이 문서와 버전이 명시된 JSON Schema, 계약 테스트를
우선한다.

## 1. Architecture status

```text
Architecture Contract: FROZEN v1.1
Design Approval: COMPLETE
Operational Freeze: P0 baseline commit 이후 COMPLETE
```

v1.1의 핵심 경계는 다음과 같다.

- 데이터·ID·의미·컴포넌트 I/O·안전 불변식·API·평가 심판은 공통으로 동결한다.
- Agent 내부 오케스트레이션 순서와 도구 사용 방식은 `AgentFlow` 플러그인에서 실험할
  수 있다.
- 각 Flow는 별도 Agent 제품이 아니다. 동일 Runtime Host와 Shared Services를 사용한다.
- 문서만 수정해 Architecture를 변경하지 않는다. 계약 변경에는 schema version bump,
  계약 테스트, 3인 합의가 필요하다.

## 2. Project goal

미래에셋증권 AI Festival 공시 Agent 과제의 근거 기반 질의응답 시스템
`Disclosure Analyst`를 구현한다. 제공된 DART 공시 코퍼스 안에서 기업·기간·지표·사건을
해석하고, 검색·비교·계산·정정 이력을 처리한 뒤 다음 JSON API로 답한다.

```json
{
  "question": "...",
  "retrieved_context": [],
  "think_trace": {
    "execution_mode": "STRUCTURED | RETRIEVAL | BOTH | EARLY_EXIT",
    "operations": [],
    "calculation": {},
    "validation": {}
  },
  "answer": "..."
}
```

## 3. Competition constraints

1. 생성 LLM은 네이버클라우드 HyperCLOVA X 계열만 사용한다.
2. 임베딩·리랭커는 사용할 수 있지만, Qwen 계열처럼 LLM에서 파생되어 규정상 생성형
   LLM으로 해석될 여지가 있는 모델은 운영진 승인 전 사용하지 않는다.
3. 제공 코퍼스 밖 뉴스·리포트·위키·외부 DB를 답변 근거로 사용하지 않는다.
4. OpenDART 등 외부 API를 런타임에 호출하지 않는다.
5. 주가 예측·종목 추천·투자의견을 생성하지 않는다.
6. `manifest.jsonl`에 등록된 문서만 대회 코퍼스로 인정한다.
7. 계산은 공통 코드 Calculator가 수행한다.
8. HCX는 검증된 결과를 한국어로 설명하는 역할만 담당한다.
9. `retrieved_context`, 구조화된 `think_trace`, 최종 JSON은 코드가 조립한다.
10. HCX에 전체 JSON 조립이나 상한 없는 자율 Tool loop를 맡기지 않는다.

## 4. Frozen contract layer

### Data and meaning

다음은 모든 Flow가 동일하게 사용한다.

```text
manifest·universe·Corpus Snapshot
DocumentIR·ParseAudit·parser/schema version
document/node/chunk/evidence ID
fact/event/relation/chain ID
source_locator
기간·scope·단위·정정 Version
Coverage·Value Status·Answerability
Fact/Event/Relation/Evidence 의미
```

`PostgreSQL`은 Fact/Event/Relation/Evidence와 평가 상태의 단일 Source of Record다.
후보 Flow는 공통 SoR을 읽기 전용으로 사용하며 후보별 파생 데이터는 별도 namespace에
저장한다.

### Component I/O

교체 가능한 컴포넌트는 다음 경계에서 공통 객체로 변환해야 한다.

```text
RetrieverRequest   -> RetrieverResult
StructuredQuery    -> StructuredResult
EvidenceBundle     -> ValidationResult
CalculationRequest -> CalculationResult
AnswerRequest      -> AnswerResult
AgentInput         -> FinalResponse + ExecutionTrace
```

`Evidence[]` 하나만 맞추는 것으로 충분하지 않다. 필터, rank, score, snapshot,
source locator, version, period, scope와 latency를 보존한다.

### Common checkpoints

모든 Flow는 내부 표현과 무관하게 Harness에 다음 결과를 보고해야 한다.

```text
QuestionUnderstanding
├─ company
├─ period
├─ metric/topic
├─ intent
├─ confidence
└─ degraded

EvidenceBundle
├─ document_id
├─ source_locator
├─ evidence_span
├─ fact/event/relation IDs
└─ version·scope·period

ValidationResult
├─ evidence_supported
├─ version_valid
├─ dimension_comparison
├─ conflict_status
└─ answerability

CalculationResult
├─ inputs
├─ unit_normalization
├─ formula
└─ result

ExecutionTrace
├─ flow_id
├─ execution_mode
├─ operations
├─ tool_calls
├─ selected_evidence
├─ hcx_calls
├─ latency_ms
└─ fallback_reason
```

## 5. Runtime Host and Shared Services

Runtime Host는 한 벌만 유지한다. Flow마다 다음 기능을 다시 구현하지 않는다.

```text
SharedServices
├─ CompanyResolver
├─ DocumentStore
├─ Fact/Event/Relation Store
├─ Retriever registry
├─ Calculator
├─ Evidence/Citation/Version Validator
├─ HCX Client
├─ Policy Guard
├─ Execution Budget
└─ API Serializer
```

불변식은 문서상의 권고가 아니라 서비스 경계의 입력 거부로 강제한다.

- Calculator는 검증된 `CalculationRequest`만 수락한다.
- HCX Client는 검증된 Evidence/Calculation 또는 안전한 EarlyExit 요청만 수락한다.
- Citation Validator는 원문에서 해소되는 `source_locator`와 span을 요구한다.
- 공통 Fact/Relation Store는 후보 Flow가 수정할 수 없다.
- API Serializer는 스키마 불일치 시에도 유효한 안전 JSON을 반환한다.
- Execution Budget은 HCX·Tool·재검색 횟수와 timeout 상한을 강제한다.

각 거부 규칙에는 계약 테스트를 둔다.

## 6. AgentFlow freedom

공통 인터페이스 개념은 다음과 같다.

```typescript
interface AgentFlow {
  run(
    input: AgentInput,
    context: SharedContext,
    services: SharedServices
  ): Promise<AgentOutcome>;
}
```

Flow가 자유롭게 설계할 수 있는 영역:

```text
전체 Flow·DAG
Question IR 사용 여부와 생성 방식
Router 사용 여부와 결정 시점
IR-first / Retrieval-first
Fact·Retrieval 직렬·병렬 실행
Planner·ReAct·bounded Tool Calling
Graph·Relation 활용
재검색과 Evidence 보완 순서
Validator 실행 위치
Chunking·Embedding·BM25·Dense·RRF·Reranker
Query Expansion
HCX Prompt
답변 전후 검증 순서
```

초기 Flow:

```text
Flow A: Reference를 겸하는 IR-first 기준선
Flow B: Fact·Retrieval 병렬형
Flow C: Retrieval-assisted 또는 Planner형
```

Flow A가 Seed E2E와 공통 계약 테스트를 통과하기 전에는 Flow B·C를 상설 구현하지
않는다. 각 담당자는 해당 주의 공통 트랙 산출물을 먼저 완료한다.

## 7. Mandatory invariants for every Flow

실행 순서와 무관하게 다음을 지킨다.

1. 제공 코퍼스 밖 정보를 사용하지 않는다.
2. HCX 외 생성형 LLM을 사용하지 않는다.
3. 사실 주장 전 Evidence를 확보하고 검증한다.
4. 검증되지 않은 값으로 계산하지 않는다.
5. 계산은 공통 Calculator가 수행한다.
6. HCX는 검증된 결과만 설명한다.
7. HCX가 전체 JSON을 조립하지 않는다.
8. 질문 기준일에 맞는 latest-effective를 검증한다.
9. 연결/별도·분기/누계·단위를 검증한다.
10. WITHHELD·문서 없음·파싱 실패를 구분한다.
11. Fact와 원문 충돌을 HCX가 임의로 선택하지 않는다.
12. 근거 부족 시 환각하지 않고 제한적 재검색·역질문·정보한계로 처리한다.
13. Tool·재검색·HCX 호출에 상한을 둔다.
14. Timeout과 내부 오류에도 유효한 JSON을 반환한다.
15. 투자추천·미래예측·프롬프트 공격을 차단한다.

## 8. Execution mode and Gold policy

네 실행 모드는 내부 상태기계를 강제하지 않는다. 실행 후 비교·오류 분석을 위한 공통
분류다.

```text
STRUCTURED | RETRIEVAL | BOTH | EARLY_EXIT
```

Gold는 정확한 노드 순서를 강제하지 않고 다음을 평가한다.

```text
preferred_route
allowed_routes
required_operations
forbidden_operations
expected_answerability
```

질문 유형별 기본 route policy를 생성하고, 정정·해지·WITHHELD·충돌·scope·계산·모호성
및 DEV_CHECK/HOLDOUT Critical Slice만 사람이 정밀 검수한다. 모든 route를 무조건
허용하여 오류를 숨기지 않는다.

Answerability 상태를 하나의 `UNANSWERABLE`로 합치지 않는다.

```text
SUPPORTED
NOT_FOUND / ZERO_DOCUMENT_IN_CORPUS
WITHHELD
NOT_APPLICABLE
UNANSWERABLE / PARSE_FAILED
OUT_OF_SCOPE
AMBIGUOUS_QUERY
CONFLICTING_EVIDENCE
```

## 9. Data facts already verified

- 기업 70개, 문서 4,204개
- periodic 1,054 / major 598 / exchange 1,469 / holding 1,083
- 정정공시 1,004개, 공급계약 해지 20개
- 선언된 원문 파일 4,622개
- A DocumentIR 인수 완료: structured 2,693 / partial 1,432 / fallback 79
- fallback 79건에는 제한된 raw text가 남아 있다.
- PDF+HTML 2건은 현재 노드와 텍스트가 0인 실제 parse failure다.
- `.xml` 확장자여도 실제 HTML일 수 있으며 선언 encoding과 실제 encoding이 다를 수 있다.
- 값은 DISCLOSED/WITHHELD/NOT_APPLICABLE/MISSING을 구분한다.
- `(예정)`, `(잠정)` 등 certainty를 보존한다.
- 관계는 AMENDS/TERMINATES/CONFIRMS/SAME_EVENT_AS를 구분한다.
- 반복 섹션 비율이 높으므로 전체 임베딩 전 fingerprint dedup과 chunk budget을 검사한다.

## 10. Retrieval experiment contract

Baseline은 `Fixed 512 + Kiwi BM25`다. 후보는 다음 범위에서 같은 Anchor와 Harness로
비교한다.

```text
Chunking
├─ Fixed 512 + overlap
├─ Section-aware Flat
└─ Document-type-aware Hierarchical Parent–Child + Table Dual

Embedding
├─ KURE-v1
├─ BGE-M3
└─ PIXIE-Rune (실험 전 정확한 revision 고정)

Search
├─ Metadata Filter
├─ BM25 / Dense
├─ RRF
└─ 조건부 Reranker
```

청킹 전략을 BM25 단독 결과로 탈락시키지 않는다. Anchor에서는 모든 주요 청킹 후보를
Dense·RRF까지 비교한다. 최종 운영에는 검증된 임베딩 한 개와 검색 구성 한 개만 남긴다.

PostgreSQL은 SoR, pgvector는 Dense 기준선, Tantivy 또는 경량 BM25는 Lexical
기준선이다. Qdrant/Elasticsearch/OpenSearch는 기준선이 실측으로 실패할 때만 검토한다.

## 11. Evaluation lifecycle

```text
질문 후보 Pool 300~500
→ Chain-safe split 선배정
→ Seed Gold 20~30
→ Anchor Gold 120~150
→ 최종 Gold 300
   ├─ DEV_TUNE 150
   ├─ DEV_CHECK 50
   └─ HOLDOUT 100

별도 Challenge 50~80
별도 동적 Regression
```

- Seed는 배선·API·계약 검사에만 사용하고 전략 선택에 사용하지 않는다.
- Anchor는 DEV_TUNE의 부분집합이다.
- Flow 반복 비교는 고정된 Anchor급 약 50개 서브셋을 사용한다.
- A/B/C 전체 Flow의 DEV_TUNE 150 실행은 기준 Flow 선정 직전 한 번으로 제한한다.
- DEV_CHECK는 최대 2회 사용하며 정밀 순위화가 아니라 방향성·Critical 회귀를 본다.
- HOLDOUT은 최종 동결 후 한 번만 사용한다.
- DEV_TUNE·Challenge에서 발견한 오류만 Regression에 축적한다.
- 동일 문서·사건·정정 chain과 anchor document가 독립 split을 넘지 않는다.

Gold 작성:

```text
B: Evaluation Owner와 최종 의미 판정
B + C: Chain 단위 질문·Gold 분담 작성 및 상호 검수
A: source_locator·표·Section·파싱 품질 표본 감사
```

## 12. Flow selection and integration

Flow 선정 규칙은 실행 전에 decision rule과 함께 hash로 고정한다.

```text
Selection milestone: 사전 지정한 3주차 말

Hard Gate
├─ JSON/API 계약 위반 없음
├─ 안전 불변식 위반 없음
├─ Evidence grounding 기준 충족
├─ Critical Slice 치명 회귀 없음
└─ 실행 예산 준수

Primary
├─ DEV_TUNE E2E 정확도
├─ Evidence 완전성
└─ Critical Slice 성능

Tie-breaker
1. 구현·운영 단순성
2. p95 latency
3. HCX·Tool 비용
4. 장애 fallback 안정성
```

기준 Flow를 선택한 뒤 다른 Flow의 아이디어나 컴포넌트를 한 번에 하나만 이식하고
paired 평가한다. 질문 유형별 상위 Dispatcher는 반복 가능한 DEV_TUNE 증거가 있을 때만
도입한다. 탈락 Flow는 비교 실험과 기술제안서 근거로 보존한다.

## 13. Team roles and priority

```text
A common track
├─ DocumentIR Snapshot·Loader·ParseAudit
├─ Section·Table·source_locator
└─ parser/dedup 품질

B common track
├─ Fact/Event/Relation/Evidence
├─ Version·Coverage·Metric Ontology
└─ Evaluation Owner·Gold

C common track
├─ Runtime Host·Shared Services
├─ Harness·Usage Ledger·실제 API
└─ 장애·운영·재현성
```

공통 역할과 Flow 역할은 branch/worktree, artifact namespace와 실행 manifest에서 분리한다.
공통 트랙이 Flow 개인 작업보다 우선한다.

## 14. Current implementation status

완료 또는 인수됨:

- manifest/universe 감사와 공통 ID·metadata 계약
- A DocumentIR·ParseAudit 4,204건
- Fact/Event/Relation/Evidence 논리 스키마와 metric ontology
- 관계 후보 큐와 검수 rubric
- 평가 작성 큐 150건과 chain-safe split 초안
- Gold v0.2, Semantic Bundle, Fact Coverage, Retrieval I/O 계약
- 대표 Chunk Artifact와 budget profile

아직 완료되지 않음:

- P0 baseline commit
- AgentFlow·SharedServices 코드 인터페이스
- 서비스 경계 거부 로직과 계약 테스트
- 확정 Seed Gold 20~30개
- 최소 VERIFIED Semantic Bundle과 Fact Coverage Snapshot
- Runtime Host·실제 제출 API·평가 Harness
- Fixed 512 + Kiwi BM25 실제 기준선 결과
- Seed E2E 실행 로그

후보·작성 큐를 확정 Gold나 VERIFIED 데이터처럼 사용하지 않는다.

## 15. Approved schema work

다음은 v1.1 이전에 승인된 구현 범위이며 Architecture 재설계로 취급하지 않는다.

```text
Experiment Run v0.3
Evaluation Usage Event v0.2
Evaluation Split Lifecycle v0.1
AgentFlow / SharedServices / AgentOutcome contracts v0.1
```

스키마 변경은 additive migration을 우선하며 삭제·의미 변경에는 major version을 올린다.

## 16. Freeze governance

FROZEN v1.1을 변경할 수 있는 근거는 다음뿐이다.

1. Seed E2E에서 재현된 실패
2. Gold 평가에서 측정된 회귀
3. API 장애 테스트에서 재현된 오류
4. 대회 공식 규정 변경
5. 실제 원문에서 발견된 구조적 예외

위 근거가 없는 아이디어는 Architecture에 바로 반영하지 않는다. Idea Backlog에 기록하거나
격리된 Spike로만 검증한다. 측정 결과 없이 Frozen 계약을 변경하지 않는다.

## 17. Claude Code implementation workflow

Claude Code는 구현 담당이고 Codex는 독립 검수 담당이다.

권장 도구 프로필:

```text
security-guidance
└─ 사용: API 입력, prompt injection, 비밀값, SQL·명령 실행 경계 검토

commit-commands
└─ 사용: 검증된 작은 로컬 커밋; 자동 push·PR 금지

pr-review-toolkit
├─ 필수: 계약·스키마·공통 인터페이스 변경 diff의 일반 코드 품질 검토
├─ 선택: 그 외 고위험 구현 diff
└─ 범위: 버그·엣지케이스·타입·에러 처리; Architecture 계약 판정은 Codex 담당
```

`hookify`와 `Superpowers`는 설치하지 않는다. 필요한 결정론적 규칙은 프로젝트 native
hook과 계약 테스트가 강제한다. `feature-dev`와 `ralph-wiggum`도 Architecture 재탐색과
반복 범위 확대 위험 때문에 사용하지 않는다. `code-review`와 `pr-review-toolkit`을 동시에
설치하지 않는다. 공식 카탈로그에 없는 `pyright-lsp`, `typescript-lsp` 플러그인을 전제로
하지 말고 프로젝트 명령을 직접 쓴다.

작업 시작 전:

1. `git status --short`
2. 이 `CLAUDE.md`
3. 관련 `domain/` 계약과 JSON Schema
4. 변경 대상 테스트
5. 작업 수용 기준과 변경 금지 범위

구현 규칙:

- Architecture를 다시 브레인스토밍하지 않는다.
- 작업 단위 구현 계획만 작성한다.
- 계약 변경이 필요하면 임의 수정하지 않고 blocker로 보고한다.
- 기존 사용자 변경과 다른 작업자의 Artifact를 덮어쓰지 않는다.
- 별도 branch/worktree에서 작업하고 동일 파일 동시 수정을 피한다.
- 테스트를 먼저 추가하거나 실패를 재현한 뒤 최소 구현을 작성한다.
- 대용량 `work/`, 원본 데이터, 임베딩, index를 Git에 추가하지 않는다.
- 비밀값, 개인 절대 경로와 외부 코퍼스 의존성을 코드에 넣지 않는다.
- 자동 push·PR 생성은 하지 않는다.

작업 완료 전 최소 검증:

```bash
npm run schema:validate
npm run test:domain
npm run typecheck
git diff --check
```

P0 baseline commit은 위 네 검증이 모두 통과할 때만 생성한다. 알려진 실패를 기준선으로
승인하거나 신규 오류를 기존 소음으로 분류하지 않는다. 프로젝트 native hook은 파일 편집
직후 `npm run verify:contracts`를 실행하고, `Stop` 시점에도 재검증하여 빨간 상태의 완료를
차단한다.

Python 변경이 있으면 프로젝트 `.venv`에서 `pyright` 또는 프로젝트에 고정된 타입 검사와
관련 테스트를 실행한다. 명령이 설치되지 않았으면 통과한 척하지 말고 명시적으로 보고한다.

Codex 인계 보고서:

```text
구현 목적·수용 기준
사용한 계획
변경 파일
commit SHA 또는 검수용 diff
실행한 테스트와 결과
계약·스키마 변경 여부
생성 Artifact와 hash
알려진 한계·미해결 blocker
```

## 18. Required commands and references

```bash
npm run schema:validate
npm run test:domain
npm run eval:validate -- domain/evaluation/example.question.json
npm run eval:validate -- domain/evaluation/fixtures/conflicting-evidence.question.json
test -n "$CORPUS_PATH"
npm run domain:validate-b -- "$CORPUS_PATH"
git diff --check
```

`CORPUS_PATH`는 팀별 로컬 환경 또는 비밀 관리 방식으로 설정한다. 개인 절대 경로를
문서·코드·스크립트에 커밋하지 않는다.

핵심 문서:

- `domain/HANDOFF.md`
- `domain/README.md`
- `domain/interfaces/README.md`
- `domain/evaluation/README.md`
- `domain/chunking/README.md`
- `domain/retrieval/README.md`

## 19. Immediate milestone

설계 문서 추가 검토보다 다음 산출물을 우선한다.

```text
1. AgentFlow·SharedServices 계약과 거부 테스트
2. P0 baseline commit SHA
3. Seed Gold 20개 + 최소 VERIFIED Evidence
4. Flow A 실제 API Seed E2E
5. FinalResponse·ExecutionTrace·latency 로그
```

Flow B·C는 Flow A Seed E2E와 공통 트랙 Gate 통과 후 시작한다.
