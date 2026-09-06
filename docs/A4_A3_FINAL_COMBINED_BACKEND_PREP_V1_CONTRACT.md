# A4/A3 Final Combined Backend Prep V1 — 계약

Turn A4-A3-FINAL-COMBINED-BACKEND-PREP-V1. 실제 A4/A3 결과나 Gold를 열기 전에 고정한다.
현재 진행 중인 A/B(ARM_A4_A3_LIVE vs ARM_A4_A3_REMEDIATION_LIVE) HCX 비교의 결과를 이
turn에서 보지 않는다 — 그 비교가 끝나는 즉시 결합 후보 C를 바로 실행할 수 있도록 조립만
해 둔다.

## 0. 목표 구조

```
QA condition mapper
  -> remediation retrieval (BM25 top-100 + dense top-100 -> wide pool <=200
     -> R4_wide_rrf_centric -> A3 Guard -> stable refill, 전부 opt-in 정책 적용)
  -> DocumentBinder
  -> 선택된 문서(들) 내부에서만 Evidence V2
  -> evidence 최대 20
  -> 기존 QA
```

세 조각(condition mapper, remediation retrieval, DocumentBinder+Evidence V2) 중 이 turn이
새로 만드는 코드는 그것들을 잇는 접착 코드(composition)뿐이다. 세 조각 자체의 규칙은
바꾸지 않는다.

## 1. 절대 금지(이 turn)

- 기존 backend(`DEFAULT`·`ARM_A_LIVE`·`ARM_A4_A3_LIVE`·`ARM_A4_A3_REMEDIATION_LIVE`·
  `ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2`) 수정. 새 opt-in backend만 추가한다.
- A4 R4 reranker 가중치·A3 Guard 규칙·remediation 정책(옵트인 subtype-relaxed pass,
  receipt-window round-robin, BM25 zero-score drop 등) 변경.
- `arm_a_document_binder.py`·`arm_a_evidence.py`의 판정 규칙(우선순위, budget 공식,
  dedup 기준, fallback 조건) 변경 — 두 모듈은 그대로 가져와 쓴다.
- 최종 QA evidence 총량이 20을 넘는 것. 서로 다른 `document_id`의 행을 한 evidence
  자리에 섞는 것.
- 결과(테스트 통과/실패 이외의 실측치)를 본 뒤 budget·우선순위·상한을 바꾸는 것.
- 현재 실행 중인 A/B HCX 비교의 output 파일·wire·로그 열람. `data/eval/*devtune*`,
  `results/**`, 실행 중인 다른 worktree의 산출물 접근.
- DEV_TUNE 질문지·Gold·DEV_CHECK/HOLDOUT 접근. HCX 실행. KURE 서버·PostgreSQL 접근·재시작.
- 전체 테스트 스위트 실행(이 turn은 targeted test만) — 현재 HCX 작업을 리소스로 방해하지
  않기 위함.
- rebase/squash/reset. 병합은 `git merge`(fast-forward 아님, `--no-ff`)만 쓴다.

## 2. 입력과 병합 방식

`codex/a4-a3-qa-condition-integration-v01`(3287f9e) 위에 새 worktree/branch를 만들고,
그 위에 두 브랜치를 **각각 `git merge --no-ff`** 한다(순서: remediation 먼저, 그다음
binder+evidence-v2 — 두 브랜치가 건드리는 파일이 서로 겹치지 않아 충돌이 나지 않음을
사전에 `git diff --stat`으로 확인했다):

1. `codex/a4-a3-remediation-integration-v01` @ `b5f9443f7ca3ec2d57c2d17453070ab23c4a6341`
2. `codex/a4-a3-qa-binder-evidence-v2-integration-v01` @ `5ff49b6d128b5fafd2a922691eb5820a4f9a293a`

병합 후 다음을 blob 단위로 재확인한다: `arm_a4_a3_remediation_live_adapter.py` ·
`arm_a4_a3_remediation_live_worker_client.py`(remediation source와 동일) ·
`arm_a_document_binder.py` · `arm_a_evidence.py` · `arm_a4_a3_binder_evidence_v2_adapter.py`
(binder+evidence-v2 source와 동일). `arm_a4_a3_live_adapter.py`·`arm_a_live_adapter.py`·
`corpus_retriever.py`·`qa_agent.py`·`validator.py`는 동결 기준선(6e24545) blob과 동일해야
한다.

## 3. 새 opt-in backend

이름: `ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE`.

파일: `src/dart_detective/arm_a4_a3_remediation_binder_evidence_v2_adapter.py`(신규).
`arm_a4_a3_binder_evidence_v2_adapter.apply_binder_and_evidence_v2()`(이미 검증된 순수
함수 — Binder -> Evidence V2 -> 20cap 로직 그 자체)를 **그대로 재사용**하고,
`arm_a4_a3_remediation_live_adapter.ArmA4A3RemediationLiveServingRetriever`(무변경)를
감싸는 새 클래스/빌더 하나만 추가한다 — Evidence 조립 로직을 새로 베끼지 않는다.

`arm_a_serving_bridge.py`(새 상수 1개 + `RETRIEVAL_BACKENDS` 튜플에 추가 1줄)와
`answer_api.py`(새 import 1줄 + dispatch 분기 1개)에는 최소 additive 변경만 한다. 기존
5개 backend 상수·기존 dispatch 분기는 한 글자도 바꾸지 않는다. `ARM_A4_A3_REMEDIATION_LIVE`
자체는 remediation turn이 의도적으로 `answer_api` dispatch에 등록하지 않은 상태 그대로
둔다(이 turn은 그 backend를 새로 등록하지 않는다 — "보존"이지 "신규 배선"이 아니다).

## 4. 실행 순서(§D)와 fallback

새 backend의 `retrieve()`는 다음을 순서대로 한다:

1. `ArmA4A3RemediationLiveServingRetriever.retrieve()` 호출 — remediation의 전체 검색
   파이프라인(BM25/dense wide pool -> R4 -> A3 Guard -> stable refill)이 이미 끝난 top-k.
   질문당 embedding 호출 1회라는 계약, corpus embedding 0, DB write 0는 그 안에서 이미
   보장된다 — 이 turn은 그 호출을 한 번 더 하지 않는다.
2. 그 결과와 `conditions`를 `arm_a_document_binder.bind_documents()`에 그대로 전달.
3. `status`로 분기(BOUND/MULTI_DOCUMENT_BOUND/AMBIGUOUS/UNRESOLVED) — `apply_binder_and_evidence_v2`
   가 이미 하는 그대로: BOUND는 선택된 document_id 하나의 후보만 Evidence V2에, MULTI는
   그룹마다 **독립적으로** Evidence V2를 호출(그룹 간 후보를 한 호출에 섞지 않음),
   AMBIGUOUS/UNRESOLVED는 Evidence V2를 아예 부르지 않고 remediation의 원본 top-k를
   그대로 통과시킨다.
4. Evidence V2가 어떤 문서에 대해 빈 결과를 내거나(이미 `arm_a_evidence` 자체가 부모로
   fallback하므로 정상적으로는 발생하지 않지만) 예외적으로 비면, 그 문서의 원본 후보로
   되돌아간다(방어적 2중 안전망 — `apply_binder_and_evidence_v2`에 이미 있음).
5. 전체를 20개로 자른다(`TOTAL_EVIDENCE_CAP`).
6. 반환값을 그대로 기존 QA(`qa_agent.py`, 무변경)에 넘긴다.

## 5. targeted test 범위

이 turn은 새 파일 + 이번에 건드린 두 파일(`arm_a_serving_bridge.py`·`answer_api.py`)에
관련된 테스트만 실행한다 — 전체 스위트(1,000여 개)는 돌리지 않는다:

```
tests/agents/test_arm_a4_a3_remediation_binder_evidence_v2_integration.py  (신규, §E 17종)
tests/agents/test_arm_a_serving_bridge.py
tests/agents/test_answer_api.py
tests/agents/test_arm_a4_a3_live_adapter.py
tests/agents/test_arm_a4_a3_binder_evidence_v2_integration.py
tests/agents/test_arm_a_document_binder.py
tests/agents/test_arm_a_evidence_v2.py
tests/agents/test_arm_a_adapter.py
tests/agents/test_arm_a_live_adapter.py
```

(remediation 쪽 자체 테스트 — `tests/four-arm-ac/a4-a3-remediation-integration.test.mjs` 등
— 은 이 turn이 건드리지 않았으므로 재실행 대상에서 뺀다. Node 검증은 remediation turn이
이미 했다.)

이 문서와 구현이 어긋나면 이 문서가 우선이다.
