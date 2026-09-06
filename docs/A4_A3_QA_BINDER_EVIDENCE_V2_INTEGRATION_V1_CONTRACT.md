# A4/A3 QA Binder+EvidenceV2 Integration V1 — 계약

Turn A4-A3-QA-BINDER-EVIDENCE-V2-INTEGRATION-V1. 이 문서는 실제 A4/A3 결과나 Gold를
열어보기 전에 고정한다. 아래 규칙은 결과를 본 뒤 바꾸지 않는다.

입력 3종(이미 완료·동결):
- 조건 매핑 통합본 — `codex/a4-a3-qa-condition-integration-v01` @ `3287f9e`(base)
- DocumentBinder — `codex/a4-a3-qa-document-binder-v01` @ `127d98f`(+ 선행 계약 `f46e2e7`)
- QA Evidence V2 — `codex/a-plus-qa-evidence-v2` @ `a9c4b08`

동결 기준선: `codex/a4-a3-plus-qa-frozen-v01` @ `6e24545`(위 3branch의 공통 조상).
`fix/a-plus-qa-evidence-assembly-v01`(e59330c)는 실패 참고 자료일 뿐, 전체 merge/cherry-pick
하지 않는다.

## 1. 절대 금지(이 turn)

- 기존 backend(`DEFAULT`/`ARM_A_LIVE`/`ARM_A4_A3_LIVE`)의 동작·기본값 변경.
- 새로운 검색·임베딩·재랭킹. 입력은 ARM_A4_A3_LIVE가 이미 만든 top-20 후보 리스트뿐이다.
- A4 R4 가중치·A3 규칙·검색 candidate k 변경.
- Gold/정답/expected value를 판단 기준으로 사용(합성 fixture만).
- 결과를 본 뒤 budget·규칙 변경 — 이 문서가 그 규칙을 동결한다.
- DEV_CHECK/HOLDOUT 접근, HCX 실행, DEV_TUNE 채점.
- `b30b909`/remediation 통합, 동결 브랜치 수정, `e59330c` 전체 병합.
- 중단된 미커밋 worktree(`agent-a4-a3-qa-evidence-v2-wiring`)의 코드 복사.

## 2. 목표 파이프라인

```
QA conditions -> condition mapper -> A4 R4 -> A3 Guard/stable refill
  -> DocumentBinder -> [선택된 document_id 내부에서만] Evidence V2
  -> QA evidence 최대 20 -> 기존 QA
```

새 opt-in backend에서만 Binder+Evidence V2를 활성화한다. DocumentBinder는 항상
Evidence V2보다 먼저 실행된다.

## 3. 새 backend

이름: `ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2`

새 파일: `src/dart_detective/arm_a4_a3_binder_evidence_v2_adapter.py`
(DocumentBinder·Evidence V2·기존 `ArmA4A3LiveServingRetriever`를 조립만 하는 얇은 어댑터.
검색·DB·KURE·LLM import 0.)

`arm_a_serving_bridge.py`/`answer_api.py`에 대한 수정은 이 backend의 dispatch를 추가하는
**최소 additive 변경만**이다:
- `arm_a_serving_bridge.py`: `RETRIEVAL_BACKEND_ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2` 상수
  추가 + `RETRIEVAL_BACKENDS` 튜플에 추가. 기존 상수·기존 클래스·기존 함수 본문은 한 글자도
  바꾸지 않는다.
- `answer_api.py`: `_build_retriever()`에 새 backend용 `if` 분기 한 개 추가. 다른 분기·
  `DEFAULT_ARM`·기존 로직은 그대로.
- 이 두 파일은 의도적으로 바뀌므로, 상속받은 byte-lock 테스트
  (`tests/agents/test_arm_a_document_binder.py`, `tests/agents/test_arm_a_evidence_v2.py`의
  `_EXPECTED_UNCHANGED_FILE_SHA256`)에서 이 두 파일의 기대 SHA만 새 값으로 갱신한다.
  나머지 5개 파일(`corpus_retriever.py`·`qa_agent.py`·`arm_a_live_adapter.py`·
  `arm_a4_a3_live_adapter.py`·`validator.py`)의 기대 SHA는 절대 바꾸지 않는다 — 이 turn은
  이 5개 파일을 한 byte도 건드리지 않는다.

## 4. 실행 순서(어댑터의 `retrieve()`)

1. 기존 `ArmA4A3LiveServingRetriever.retrieve()`로 top-20(또는 요청 k)을 그대로 받는다
   (재정렬·재검색 없음, A4/A3 순위 불변).
2. `bind_documents(question, conditions, candidates)`를 부른다.
3. `status`로 분기:
   - **BOUND**: `selected_document_ids`(정확히 1개)의 `retained_candidates`만 Evidence V2에
     전달. 결과를 그 문서의 `document_budgets[doc_id]`로 자른다(rank 순서 보존, 새 점수 없음).
   - **MULTI_DOCUMENT_BOUND**: `candidate_groups` 중 `selected=True`인 그룹마다 **따로**
     Evidence V2를 실행한다(한 번의 `normalize_arm_a_evidence` 호출에 서로 다른 문서의 후보를
     섞어 넣지 않는다 — 인터리빙이 그룹 경계를 넘지 않게 하기 위함). 각 그룹 결과를 그
     그룹의 `document_ids[0]`에 대응하는 `document_budgets` 값으로 자른 뒤, 그룹 등장 순서대로
     이어 붙인다. 각 행의 `metadata`에 `binder_group_id`/`binder_role`을 남긴다.
   - **AMBIGUOUS / UNRESOLVED**: Evidence V2를 실행하지 않는다. **1단계에서 받은, 필터링
     이전의 원본 top-k 결과를 그대로**(binder가 거른 `retained_candidates`가 아니라) QA에
     전달한다 — "기존 backend 대비 회귀 없음"을 이 두 상태에서 구조적으로 보장하기 위한
     선택이다(binder의 오탐으로 인한 근거 손실을 이 경로에서 차단). 각 행에
     `binder_status`만 태그한다.
4. Evidence V2가 어떤 문서에 대해 빈 리스트를 만들면(이론상 arm_a_evidence 내부가 항상 최소
   1개의 parent-context/unresolved 행을 반환하므로 실무에서는 발생하지 않지만, 방어적으로)
   그 문서의 `retained_candidates`(binder가 넘겨준 원본 후보)로 대체한다.
5. 모든 경로의 최종 결과를 `[:20]`으로 한 번 더 방어적으로 자른다(budget 합계가 항상 20
   이하이므로 정상 경로에서는 no-op).
6. 그대로 반환 — qa_agent.py 이후 로직은 무변경.

## 5. Evidence budget

- `DocumentBinder.document_budgets`를 그대로 소비한다(합계 <= 20, 새 계산 없음).
- 문서별 Evidence V2 결과가 그 문서 budget을 넘으면 **뒤쪽을 자른다**(정렬은
  `normalize_arm_a_evidence`가 이미 parent rank를 1차 키로 두므로 자르는 것만으로 안정적
  선택이 된다 — 별도 재정렬 없음).
- dedup은 `arm_a_evidence.normalize_arm_a_evidence`의 기존 `(doc_id, node_index, row_index)`
  locator 규칙 그대로(추가 dedup 없음). 서로 다른 문서를 같은 호출에 섞지 않으므로 그룹 간
  교차 dedup은 발생하지 않는다(발생할 필요도 없다 — doc_id가 다르면 locator도 다르다).
- top-20 밖 후보로 padding하지 않는다(어댑터는 1단계 결과 이상을 새로 만들지 않는다).

## 6. 문서 혼합 방지

- BOUND 결과의 최종 evidence `doc_id` 집합은 정확히 `{selected_document_ids[0]}`.
- MULTI_DOCUMENT_BOUND는 그룹별로 독립 호출하므로 한 그룹의 출력에 다른 그룹의 `doc_id`가
  섞이는 것이 구조적으로 불가능하다.
- 비교 질문(연도/현재-직전/정정 전후)의 역할 구분은 `CandidateGroup.role`을 그대로
  `binder_role` metadata로 옮겨 QA/검증 단계가 문서 경계를 알 수 있게 한다.

## 7. 완료 판정

- `BINDER_EVIDENCE_V2_INTEGRATION_READY`: 조건 mapper 정상(101/101 유지) · 문서 혼합 0 ·
  evidence <= 20 · AMBIGUOUS/UNRESOLVED에서 원본 top-k 유지 · 기존 backend 회귀 0 ·
  전체 테스트 GREEN · 기존 파일(위 5개) SHA 불변.
- 계약 위반 또는 안전한 fallback 불가 시: `BLOCKED_CONTRACT`.

이 문서와 구현이 어긋나면 이 문서가 우선이다. 바꾸려면 새 turn에서 이 문서를 먼저 고친다.
