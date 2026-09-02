# Codex 검수 요청 — LLM 예산 라우팅 (routing.py + max_tokens 호출별 지정)

당신은 독립 검수자다. **코드를 수정하지 말고**, 아래 체크리스트대로 검사한 뒤 보고서만 작성한다.
작업 폴더: 이 저장소 루트(`ai_festival`). Python 실행은 `.venv/bin/python`을 쓴다.

## 0. 먼저 읽을 것 (순서대로)
1. `CLAUDE.md` — 절대 원칙(vFINAL byte 불변, 신·구 스펙 공존 금지, 상태 라벨 혼용 금지, DEV_CHECK/HOLDOUT 접근 금지)
2. `docs/specs/team-architecture-v4.txt` **§7(유형·전략)과 §12(HCX 계약)** — 이번 변경의 유일한 근거
3. `docs/interfaces.md` §2·§4 — 에이전트 경계와 FC 스키마(이번 변경 범위 밖이지만 충돌 여부 확인용)

## 1. 변경의 목적 (한 문장)
질문 종류에 따라 HCX에 보내는 발췌 개수와 `maxTokens`를 다르게 주어, CLOVA 분당 토큰 한도(TPM = 입력 + maxTokens) 소모를 줄인다. **답변 품질을 올리려는 변경이 아니다.** 프롬프트 본문·검색 코어·검증 게이트는 그대로다.

## 2. 변경 범위 (이 파일들만 바뀌어야 한다)
| 파일 | 성격 |
|---|---|
| `src/dart_detective/routing.py` | **신규.** 전략 판정(7종) + 예산 매트릭스 + 강등 규칙 |
| `src/dart_detective/llm.py` | `complete_json`에 keyword-only `max_tokens: int \| None = None` 추가. `ClovaLLM`은 `maxTokens`에 반영, `usage["max_tokens_requested"]` 기록 |
| `src/dart_detective/agents/qa_agent.py` | `answer_question`에서 라우팅 호출 → 발췌 개수·max_tokens 적용. `AgentState`에 `route` 기록. 10~20줄 |
| `src/dart_detective/answer_wire.py` | `think_trace_of`에 `strategy` 한 단계 추가(선택) |
| `tests/agents/test_routing.py` | **신규.** 판정 순서·예산·강등·max_tokens 전달 테스트 |

**기준선**: 이번 변경 전의 준비물(`CLAUDE.md`, `docs/**`, `data/corpus/`, `data/eval/phase1_devtune_*`, `.gitignore`의 `.DS_Store`·`work/` 2줄)은 별도 '준비' 커밋으로 분리되어 있다. 검수 대상은 **그 커밋 이후의 diff**다. `git log --oneline -3`으로 준비 커밋을 찾고 `git diff <준비커밋> --stat`으로 **위 목록 밖의 파일이 바뀌었으면 즉시 지적**한다. 특히 `src/dart_corpus/**`(검색 코어)는 한 줄도 바뀌면 안 된다 — 4-arm 실험 입력이다.

## 3. 체크리스트 (각 항목에 PASS / FAIL / 판단불가 + 근거 file:line)

### A. 설계 정합 (v4 §7)
- [ ] A1. 전략 7종 이름이 정확히 `DIRECT_LOOKUP · COMPARISON · CALCULATION · ENUMERATION · COUNT · EXISTENCE_CHECK · NARRATIVE`인가
- [ ] A2. 판정 순서가 §7 "판정(순서 고정)"과 같은가: ① 집계어+패밀리어 → (몇 건→COUNT / 존재→EXISTENCE / 그 외→ENUMERATION, 최상급은 ENUMERATION) ② 서술어(정리·설명·비교·요약·변화)→NARRATIVE ③ 값 의문+slot≤2→DIRECT_LOOKUP ④ 기본 NARRATIVE. **순서가 바뀌면 FAIL.**
- [ ] A3. 예산 매트릭스가 §7 "실행 매트릭스"와 숫자까지 일치하는가: DIRECT/COMPARISON/CALC = top8·max512, ENUMERATION = max768, COUNT/EXISTENCE = max256, NARRATIVE = top20·max1024
- [ ] A4. 강등 규칙: event ledger가 아직 없으므로(v4 §3 조건부·§15 PROPOSED) ENUMERATION/COUNT는 §7 복구 규칙대로 **NARRATIVE로 강등 + "전수 집계 아님" 고지**가 되는가. 강등 사실이 trace(`route.downgraded_from`)에 남는가. 구현은 **코퍼스 존재 규칙(`corpus_existence`)이 못 잡은 EXISTENCE_CHECK도 같은 강등**을 적용한다(§7에서 COUNT/EXISTENCE가 같은 ledger 카운트 경로이기 때문) — 이 해석이 타당한지 판단하라
- [ ] A5. §7에 명시되지 않은 세부(예: COMPARISON/CALCULATION을 ③ 안에서 어떤 어휘로 가르는지)가 있다면 **코드 주석에 "v4 미명시 · 구현 세부"로 표시**되어 있는가. 표시 없이 새 규칙처럼 쓰여 있으면 지적
- [ ] A6. answer_type이 `CLOSED | OPEN_ENDED` 둘만 쓰는가(LIST 등 폐기 유형 금지)

### B. 바뀌면 안 되는 것
- [ ] B1. `tests/agents/test_qa_contract.py::test_prompt_fingerprint_matches_version` 통과 — `SYSTEM_PROMPT`·`USER_PROMPT_TEMPLATE`·`WANTED_BLOCK_TEMPLATE`·`ANSWER_SCHEMA`가 byte 동일
- [ ] B2. LLM 건너뛰기 규칙 3개가 그대로인가: `corpus_existence` → NOT_FOUND, `detect_withheld` → WITHHELD, `state.derived` 있으면 호출 안 함
- [ ] B3. "evidence_matches가 비면 LLM을 안 부른다" 가드가 그대로인가(이번 범위에서 바꾸지 않기로 함)
- [ ] B4. `src/dart_corpus/**` 무변경
- [ ] B5. 기존 테스트의 가짜 LLM(`complete_json(self, system, user, schema)` — max_tokens 인자 없음)이 **여전히 동작**하는가. 즉 `_llm_answer`가 max_tokens를 받지 않는 클라이언트에도 안전한가

### C. max_tokens가 실제로 전달되는가
- [ ] C1. `ClovaLLM.complete_json`의 `_post` payload `maxTokens`에 호출별 값이 들어가는가(테스트가 `_post`를 가짜로 바꿔 payload를 캡처하는지 확인)
- [ ] C2. 인자를 안 주면 기존 기본값(2048)으로 동작하는가(하위 호환)
- [ ] C3. `usage["max_tokens_requested"]`가 실제 요청값을 기록하는가. 잘림(`truncated`) 표시 로직이 유지되는가

### D. 기록·관측
- [ ] D1. `AgentState.to_dict()`에 `route`가 실리는가. **형식(중첩)**: `{strategy, answer_type, budget: {context_chunks, max_tokens, llm_calls, source}, reasons, downgraded_from, notice}`. (v1 브리프의 평탄 형식 표기는 오기였다 — 예산은 한 단위로 묶는다)
- [ ] D2. `state.llm` 메타에 `max_tokens`가 실리는가
- [ ] D4. **강등 고지가 공식 5필드 응답에 실리는가** — `answer_wire.to_answer_wire()` 결과의 `answer` 본문에 `routing.LEDGER_NOTICE`가 있고, `think_trace`의 `route` 단계에 `downgraded_from`·`notice`가 있는가. (`uncertainty`는 wire에 실리지 않는 내부 필드이므로 거기만 넣으면 FAIL)
- [ ] D3. think_trace에 시스템 프롬프트·비밀값이 새지 않는가(기존 원칙)

### E. 테스트 품질
- [ ] E1. `test_routing.py`가 판정 순서의 **각 분기**를 최소 1건씩 덮는가(집계+패밀리→COUNT, 존재→EXISTENCE, 나열→ENUMERATION, 최상급, 서술어→NARRATIVE, 값+slot≤2→DIRECT, 기본→NARRATIVE)
- [ ] E2. 순서 충돌 케이스가 있는가 — 예: "정리해줘"(서술어)와 값 의문이 같이 있을 때 NARRATIVE가 이기는지
- [ ] E4. wire 수준 테스트가 있는가 — 내부 `state`가 아니라 `to_answer_wire()` 결과로 고지·route 단계를 확인하는 테스트
- [ ] E3. 전체 스위트 실행: `.venv/bin/python -m pytest -q -m "not integration"` — 기존 521 passed 유지, 새 테스트 추가분 통과. **corpus root 부재로 인한 23 errors는 기존과 동일(무시)**

### F. 금지 사항 확인
- [ ] F1. HCX 실호출이 테스트에 없는가(`CLOVA_API_KEY` 없이 전부 통과해야 함. 비용 0)
- [ ] F2. `data/eval/`에 DEV_CHECK/HOLDOUT 관련 파일이 추가되지 않았는가
- [ ] F3. 폐기 표현이 코드·주석에 없는가: "Fixed-512 최종", "LIST 유형", "PG 불가 시 B 자동 전환"

## 3-1. 구현 완료 상태 (검수 시점 참고)
- 신규 테스트 27개 전부 통과. 전체 스위트 `548 passed, 23 errors` — errors 23은 전부 `corpus root not found`(parser 통합 테스트, 기존과 동일).
- `git diff --stat`: `.gitignore`, `qa_agent.py`(+47/-?), `answer_wire.py`(+5), `llm.py`(+19). 신규: `routing.py`, `tests/agents/test_routing.py`.
- `src/dart_corpus/**` 무변경.

## 4. 보고 형식
```
판정: 승인 / 조건부 승인 / 반려
요약: (3줄 이내)

발견 사항 (심각도 순):
1. [FAIL|WARN] 항목ID — file:line — 무엇이 문제인지 한 문장 — 왜 문제인지 한 문장
...

PASS 항목: A1 A2 … (ID만 나열)
판단불가 항목과 이유:
git diff --stat 결과:
pytest 결과 요약 (passed / failed / errors):
```

## 5. 하지 말 것
- 코드·테스트·문서 수정 금지 (제안은 보고서에 글로만)
- HCX/CLOVA API 호출 금지
- `docs/specs/` 아래 파일 열람은 되지만 수정 금지 — vFINAL은 byte 불변
- DEV_CHECK/HOLDOUT 데이터 탐색 금지
