# 대량보유 파서 + 부분 답변 구현 스펙 (자립형 — 이 문서만 보고 구현 가능)

작성: 2026-09-05, 이전 세션 실측 기반. 코덱스 조건부 승인 4건 반영 완료.
목표: DEV_TUNE 101 중 대량보유 계열 33문항에서 결정론 값 추출·쌍 계산·부분 답변을 켠다.
현재 이 33문항에서 계산기 발동은 **0건**(실측)이고 답은 원문 덤프다.

## 0. 먼저 읽을 것 / 절대 제약

- `CLAUDE.md`(상태 로그), `docs/interfaces.md`. vFINAL·검색 코어·프롬프트·validator는 **무변경**.
- 이번 작업은 **답변 조립 층만** 건드린다: `calculator.py` · `qa_agent.py`(배선 2곳) · 테스트.
- LLM 재호출 추가 금지. `legacy report_pair_diffs`는 이번에 **건드리지 않는다**(새 파서가 실전 경로).
- validator 수정 금지 — `calculator.allowed_numbers()`(calculator.py 363행 부근)가 이미
  부호 제거 변형(`v.lstrip("-")`)을 허용하므로 "662,232 감소" 표기는 그대로 통과한다.
- 실행: `.venv/bin/python`. HCX 실행 전 `set -a; source .env; set +a`.
- push 대상: `git push origin main:share/dart-qa-handoff`.

## 1. 확인된 사실 (재검증 불필요 — 이 세션에서 실측 완료)

- 대량보유 문항 33/101 (질문에 "대량보유" 또는 gold doc이 `holding_*`).
- judge16(`results/judge16/`) 기준선: 값 완전 35·부분 46·미포함 11(분모 92)·가중 58.0 ·
  답변가능성 98/101 · 안전세트 28/28. 33문항 전부 `think_trace.calculation` 미발동.
- 버그: `calculator.py`의 `PAIR_LABELS = (("직전 보고서", "이번 보고서"),)` +
  `l.split("|")[0].strip() == label` 완전일치. 실제 서식 2종 모두 불일치:
  - **연혁표**: 라벨이 붙은 표기(`직전보고서`), 셀 9개(날짜·보고자 섞임)
  - **요약표**: 라벨이 **둘째 칸**(첫 칸은 그룹 제목)
- `qa_agent.py`의 `pair_lines`(answer_question 안, `calculator.report_pair_diffs` 호출 직전)가
  매치된 청크들의 줄을 **doc_id 없이 평탄화** — 문서 경계 소실.
- `answer_wire.retrieved_context_of()`(answer_wire.py 66행 부근)는 **state.evidence_matches만**
  직렬화한다 → 파서가 쓴 근거는 반드시 EvidenceMatch로 승격해야 감사 가능.
- 자유 슬롯(`ANSWER_SLOT`) 매치는 picked_value가 None — 대량보유 답의 값 운반체는 현재 덤프 줄 자체.

## 2. 실물 픽스처 (원문 그대로 — 테스트에 이대로 사용)

문항: `author_045…` "Massachusetts Financial Services Company이(가) (주)아모레퍼시픽에 대해 제출한
주식등의 대량보유상황보고서(보고서작성기준일 2024년 03월 22일)… 직전 보고서 대비 … 보유주식등의
수와 보유비율은 각각 어떻게 변동되었는가?" · gold doc `holding_20240403000410`.

**연혁표 (node 28, 2행 머리글)**:
```
| 보고서작성기준일 | 보고자 | 보고자 | 주식등 | 주식등 | 주권 | 주권 | 의결권 있는 발행주식총수(주)
 | 보고서작성기준일 | 본인 성명 | 특별관계자수 | 주식등의 수(주) | 비율(%) | 주식수(주) | 비율(%) | 의결권 있는 발행주식총수(주)
직전보고서 | 2023년 06월 02일 | MassachusettsFinancialServicesCompany | 1 | 2,925,317 | 5.00 | 2,925,317 | 5.00 | 58,492,759
이번보고서 | 2024년 03월 22일 | MassachusettsFinancialServicesCompany | 1 | 2,263,085 | 3.87 | 2,263,085 | 3.87 | 58,492,759
증    감 | 증    감 | 증    감 | 증    감 | -662,232 | -1.13 | -662,232 | -1.13 | 0
```

**요약표 (node 1 — 라벨 둘째 칸, 그룹 2개)**:
```
보유주식등의 수 및 보유비율 |  | 보유주식등의 수 | 보유비율
보유주식등의 수 및 보유비율 | 직전 보고서 | 2,925,317 | 5.00
보유주식등의 수 및 보유비율 | 이번 보고서 | 2,263,085 | 3.87
의결권의 수 및보유비율 |  | 의결권의 수 | 보유비율
의결권의 수 및보유비율 | 직전 보고서 | - | -
의결권의 수 및보유비율 | 이번 보고서 | 2,263,085 | 3.87
```

**오결합 함정 픽스처 (다른 문서의 다른 보고자·다른 기준일 — 실제 검색 근거에 함께 등장)**:
```
직전보고서 | 2023년 09월 22일 | 국민연금공단 | 1 | 4,329,578 | 7.40 | 4,329,578 | 7.40 | 58,492,759
이번보고서 | 2024년 08월 16일 | 국민연금공단 | 1 | 3,744,240 | 6.40 | 3,744,240 | 6.40 | 58,492,759
```
필요 시 원문 재확인: `NodeStore("data/index").fetch_node("holding_20240403000410", 28)["text"]`.

## 3. 설계 (코덱스 4조건 반영판)

### 3-1. 반환형 — 추출값과 계산값을 섞지 않는다 (조건 1)

`Derived`는 코드 계산값 전용이다(calculator.py Derived docstring). 파서는 다음을 반환:

```python
@dataclass
class HoldingParseResult:
    matches: list[EvidenceMatch]   # 직전/이번 수량·비율 — 원문 행 + picked_value (추출값)
    derived: list[Derived]         # 증감 2개만 (kind "holding_change", 수량 unit "주"/비율 "%p")
    missing_slots: tuple[str, ...] # 예: ("직전 보고서 보유주식등의 수", "직전 보고서 보유비율")
    consumed_texts: frozenset[str] # 파서가 소비한 행(공백 정규화) — 폴백 덤프에서 이 행만 숨김
```

- 직전/이번 값 4개(부분이면 2개)는 **EvidenceMatch**로: slot 이름 `"이번 보고서 보유주식등의 수"` 등,
  `evidence_text`=원문 행 그대로, `picked_value`=셀 값 그대로, doc_id/chunk_id/node_index/rcept_no는
  출처 청크에서 복사. 위치는 `src/dart_detective/agents/calculator.py`에 두되 EvidenceMatch 순환
  import를 피하려면 파서는 (slot, 행, 값, 청크참조) 튜플을 반환하고 qa_agent가 EvidenceMatch로 변환해도 된다.
- 증감은 질문에 변동어(변동/변화/증감/차이/얼마나)가 있고 **쌍이 완비**일 때만 Derived 생성.

### 3-2. 근거 승격 — 감사 가능성 (조건 2)

파서가 값을 뽑은 행의 EvidenceMatch를 **state.evidence_matches에 추가**한다(중복 chunk·행이면 기존
매치에 picked_value/slot만 갱신). 이유: `retrieved_context`는 evidence_matches만 직렬화하고,
citations도 여기서 만들어진다 — 승격하지 않으면 answer의 숫자가 retrieved_context에 근거 없는
감사 불가 답변이 된다. **테스트로 잠글 것**: 승격된 행이 wire의 retrieved_context에 나타나는지.

### 3-3. 대상 문서·행 선택 캐스케이드 (조건 3 — 보고자만이 아니라 기준일 결박)

같은 회사·같은 보고자의 공시가 여러 건 검색된다(여러 날짜의 직전/이번 쌍 동시 등장 실측).
선택 순서:
1. **질문의 보고서작성기준일** — 질문에서 날짜 추출(`2024년 03월 22일`·`2024-03-22`·`2024.03.22`
   동치. 기존 날짜 동치 로직이 validator 계열에 있으니 재사용 가능하면 재사용, 아니면 로컬 정규화
   `(연,월,일)` 튜플 비교). 이 날짜와 **이번보고서 행의 날짜 셀**(연혁표) 또는 문서의
   보고서작성기준일 행(요약표가 있는 doc의 다른 줄 `… | 보고서작성기준일 : | 2024년 03월 22일`)이
   일치하는 문서만 후보.
2. 대상 회사(검색 조건이 이미 발행회사로 필터하지만, 후보가 여럿이면 유지되는 것만).
3. holding 문서(doc_id가 `holding_` — 정기보고서 안의 최대주주 변동 표는 후순위).
4. 그 문서의 이번보고서 날짜 = 질문 기준일 재확인.
5. 보고자: 질문에 보고자명이 **있으면** 행 보고자 셀(연혁표) 또는 문서에서 추출한 filer와
   정규화(공백 제거·casefold) 포함 비교로 결박. 질문에 보고자명이 **없어도 끄지 않는다** —
   기준일로 문서가 유일하게 정해지면 그 문서의 보고자(연혁표 보고자 셀, 없으면 문서 앞 node들의
   보고자 행)를 **filer로 추출해 답변에 사용**("보고자를 알려줘" 유형 대응).
- 어느 단계든 후보가 2개 이상 남아 유일하게 정해지지 않으면 **fail-closed**(파서 미발동, 덤프 유지).
- 다른 보고자의 행으로 빈자리를 채우지 않는다(직전이 없으면 부분 답변).
- 파싱 대상 그룹: 매치된 청크 + **같은 doc_id**의 retrieval 상위 청크(요약표가 근거 선발에 안
  뽑혔어도 같은 문서면 값 소스로 사용 — 사용 시 3-2 승격 필수).

### 3-4. 머리글 파싱 — 2행 머리글 병합, 고정 인덱스 금지

- 연속한 비데이터 행(데이터 행 판정은 `tables._is_data_row` 재사용)이면서 **셀 수가 같은** 줄들을
  셀 단위로 이어붙여 논리 머리글을 만든다(예: 위 연혁표 1·2행 → i번째 셀 = "주식등 주식등의 수(주)").
- 열 확정: 논리 머리글에서 정규화(공백 제거) 후 `주식등의수`를 포함하되 `및`을 포함하지 않는
  **첫** 셀 = 수량 열, 그보다 오른쪽에서 `비율`을 포함하는 첫 셀 = 비율 열("보유비율"·"비율(%)" 둘 다).
  보고자 열 = `본인성명` 또는 `보고자` 포함 첫 셀(없으면 None).
- 정렬 가드: 논리 머리글 셀 수 == 데이터 행 셀 수. 다르면 그 표는 미발동.
- **요약표 전용 규칙**: 데이터 행 = `cell[0]`에 "주식등" 포함(의결권 그룹 배제) AND `cell[1]`
  정규화가 직전보고서/이번보고서. 값은 머리글(`보유주식등의 수`·`보유비율`)로 확정한 열에서.
  `-` 셀은 값 아님(parse 실패 → 그 행 미사용).
- 변형 테스트 필수: ① 열 하나 추가된 표 ② 병합 셀로 빈 셀 낀 표 ③ 2행 머리글 ④ 수량·비율
  순서가 뒤바뀐 표 — 넷 다 정답이거나 fail-closed여야 하며, 고정 인덱스 구현은 ①·④에서 반드시 깨진다.

### 3-5. 폴백 덤프 — 소비한 행만 숨긴다 (조건 4)

`any(kind.startswith("holding"))`로 덤프 전체를 끄는 것은 **금지** — 보유목적·보고사유 등 다른
slot 근거가 사라진다. 대신:
- `fallback_answer(matches, exclude_texts: frozenset[str] = frozenset())` — rest 줄 중 공백
  정규화가 `exclude_texts`(= `HoldingParseResult.consumed_texts`)에 있는 것만 숨긴다.
- 다른 slot 근거(보유목적·보고사유 등)는 그대로 유지.
- `missing_slots`는 답변에 "다음 항목은 검색된 근거에서 확인하지 못했다: …"로 명시.
- 테스트로 잠글 것: 보유값과 보유목적을 함께 묻는 질문에서 보유목적 근거가 사라지지 않음.

### 3-6. describe() 자연어화

- `holding_change`: `- 보유주식등의 수: 2,925,317에서 2,263,085로 662,232주 감소(증감 -662,232)`
  — 방향어는 부호로, 크기는 절댓값, **signed 원값 병기**(자동 채점 value_forms가 "-662,232"를
  찾을 수 있게). 비율은 `(증감 -1.13%p)`.
- 승격된 추출값은 기존 "공시에서 확인한 값:" 섹션(valued 경로)이 자동으로 문장화한다 —
  describe에 중복 출력하지 않는다.
- 기존 `increase_rate`/`pair_change` 렌더링도 같은 형식(…에서 …로 N 증가/감소, signed 병기)으로
  통일. 문체는 해라체(기존 답변 전체와 일관).
- validator 확인 테스트: describe 출력 + 승격 근거로 `validator.validate()` 돌려 SUPPORTED.

## 4. 구현 순서 (커밋 3분할)

1. **테스트 먼저**: `tests/agents/test_holding_parser.py` — §2 실물 픽스처 + §3-4 변형 4종 +
   아래 필수 케이스. 전부 빨간 상태 확인 후 구현 시작.
2. 커밋 ①: 파서(`HoldingParseResult`, 문서 선택 캐스케이드, 머리글 병합) + 단위 테스트.
3. 커밋 ②: qa_agent 배선(그룹 구성 → 파서 호출 → EvidenceMatch 승격 → derived 병합 →
   `exclude_texts` 전달) + describe 자연어화.
4. 커밋 ③: 통합 테스트(retrieved_context 포함·보유목적 보존·불변조건) + 문서/CLAUDE.md 상태 갱신.

**필수 테스트 목록** (§3의 잠금 항목 외 추가):
- 여러 날짜의 동일 보고자 공시 중 **질문 기준일 문서만** 선택 (다른 날짜 쌍 미사용)
- 보고자명이 질문에 없어도 기준일 유일 문서에서 filer 추출해 답변에 사용
- 새 추출 근거가 wire `retrieved_context`에 포함(감사 가능성)
- 다른 문서·다른 보고자 오결합 금지(국민연금 픽스처)
- 이번만 있고 직전 없음 → 부분 답변(추출값 2 + missing_slots 명시), 증감 미계산
- 머리글 없음·셀 수 불일치 → 파서 미발동, 덤프 원형 유지
- 기존 `report_pair_diffs` 테스트 6개(test_entity_comparison.py·test_phase1_fixes.py) 무변경 통과

## 5. 검증·합격 기준·롤백

1. `.venv/bin/python -m pytest tests/ -q --ignore=tests/parsing --ignore=tests/retrieval --ignore=tests/contract`
   (기준: 현재 552 passed + 신규 전부).
2. `DART_DETECTIVE_LLM=off PYTHONIOENCODING=utf-8 .venv/bin/python scripts/run_safety_set.py` → **28/28**.
3. judge17: `set -a; source .env; set +a` 후
   `PYTHONIOENCODING=utf-8 .venv/bin/python scripts/judge_devtune.py --out-dir results/judge17` (~20분).
4. judge16과 paired diff(문항별 value_score 비교). **합격**: 대량보유 33문항에서 값 악화 0(개선만),
   비대량보유 churn ±5 이내(FC 실행간 변동 밴드), 답변가능성 98/101 유지.
5. **롤백 경로**: 값 소실 발견 시 1차로 `exclude_texts` 전달만 끄면(빈 set) 덤프가 복원되어
   점수는 원복된다 — 파서·승격은 유지 가능.
6. 통과 시 push(`origin main:share/dart-qa-handoff`) + CLAUDE.md 상태 로그 1블록 추가.
   서버 반영은 팀원2 재배포 시 일괄(`DART_QA_CODE_SHA` env를 새 커밋으로 갱신 — pins 변경으로
   캐시 자동 무효화. 56f776f 이후분과 함께).

## 6. 오늘 범위 밖 (구현 금지 — 실측 후 재논의)

`presentation.py` 전면 모듈화 · FC 프롬프트 문체 · validator 규칙 변경 · 자유 슬롯 picked_value
전면 확대 · 질문 토큰 기반 선별 발췌 · 덤프 전면 제거 · `legacy report_pair_diffs` 수정.

## 7. 기대치 (정직한 상한)

직격 개선 상한은 VALUE_NOT_EXTRACTED 17 언저리 + 대량보유 부분 개선. RETRIEVAL_MISS 44는 이
작업으로 불가침. author_045는 요약표·연혁표 모두 원문에 직전 값이 있으므로 **완전 쌍**
(-662,232 · -1.13)까지 가능. 견적 7~9시간(테스트 포함).
