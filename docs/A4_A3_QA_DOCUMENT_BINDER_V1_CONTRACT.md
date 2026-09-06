# A4/A3 QA DocumentBinder V1 — 계약

Turn A4-A3-QA-DOCUMENT-BINDER-V1. 이 문서는 구현 전에 고정한다 — 실제 A4/A3 결과나
Gold를 열어보고 나서 쓴 것이 아니다. 아래 규칙은 결과를 본 뒤 바꾸지 않는다(바꿔야 할
근거가 나오면 새 turn에서 별도로 재논의한다).

## 0. 배경과 위치

최종 목표 파이프라인:

```
검색 결과 -> A4 R4 -> A3 Guard/refill -> DocumentBinder -> Evidence V2 -> QA
```

`fix/a-plus-qa-evidence-assembly-v01`(e59330c)의 실 HCX 결과가 보여준 실패 양상: 행 단위
정규화(Evidence V2)가 구조 지표는 올렸지만 근거 수를 20개에서 80개 이상으로 늘렸고, 그
과정에서 서로 다른 문서의 행이 한 답변 안에 섞여 문서 일관성이 깨졌다(가중 점수 67.5 ->
63.5). DocumentBinder는 Evidence V2 **앞**에서 "이 질문은 어느 document_id(들)로
답해야 하는가"를 먼저 결정해, Evidence V2가 그 경계 밖으로 행을 확장하지 못하게 막는
역할이다. 이 turn은 DocumentBinder만 구현한다 — Evidence V2와의 실제 연결은 다음 turn.

## 1. 절대 금지(이 turn)

- 새로운 검색·DB 조회·임베딩·재랭킹. 입력은 A4+A3가 이미 만든 top-20 후보 리스트뿐이다.
- Gold/정답/expected value를 문서 선택 기준으로 사용. 이 모듈은 합성 fixture로만 검증한다.
- `document_id` 공간 밖으로 후보를 확장(새 candidate 생성 0).
- 기존 retrieval rank·provenance 변경(재정렬 0, node_indices 등 그대로 보존).
- 결과를 본 뒤 규칙·상한을 바꾸는 것 — 이 문서가 그 규칙을 동결한다.
- `qa_agent.py`·`answer_api.py`·worker(`*.mjs`)·`arm_a_serving_bridge.py`·
  `arm_a_live_adapter.py`·`arm_a4_a3_live_adapter.py`·`corpus_retriever.py`·
  `validator.py` 수정. Evidence V2 실배선, e59330c normalization 활성화, HCX 실행,
  DEV_TUNE/DEV_CHECK/HOLDOUT 접근, `b30b909` 통합, 현재 동결 브랜치 수정.
- `e59330c`·`a9c4b08`을 통째로 merge/cherry-pick.

## 2. 입력 계약

```python
def bind_documents(
    question: str,
    conditions: QueryConditions,     # dart_corpus.retrieval.conditions.QueryConditions
    retrieved_candidates: Sequence[RetrievedChunk],  # A4+A3 최종 top-20, 이미 rank 순서
) -> DocumentBindingResult
```

- `retrieved_candidates`는 A4 R4 -> A3 Guard/refill이 이미 끝낸 **최종 순위 그대로**의
  `RetrievedChunk` 시퀀스다(순서 = rank). 이 함수는 그 순서를 읽기만 한다.
- 각 후보의 `metadata`에서 다음 필드를 **있으면** 쓴다(없으면 그 차원은 판단하지 않고
  넘어간다 — "정보 부족은 AMBIGUOUS" 원칙과 대칭이다):
  `corp_code`(선택, 있으면 `corp_name`보다 우선) · `corp_name` · `doc_group` ·
  `doc_subtype` · `rcept_dt`("YYYYMMDD") · `base_year` · `base_month` ·
  `is_correction`. 이 필드들은 오늘 `corpus_retriever._metadata_of()`가 이미
  `RetrievedChunk.metadata`에 얹어 주는 것과 같은 이름이다(코드 변경 없음, 소비만).
- `question_dates()`(corpus_retriever.py의 기존 순수 함수, import만 — 수정 없음)로
  질문 속 명시적 "YYYY-MM-DD"류 날짜를 하루 단위까지 직접 뽑는다. `conditions.years`
  보다 세밀한 신호가 필요해서다.

## 3. 출력 스키마 — `DocumentBindingResult`

```python
@dataclass(frozen=True)
class CandidateGroup:
    group_id: str                          # "g0", "g1", ... — 등장 순서
    role: str | None                       # 예: "primary" | "year_2024" | "before" | "after" | 회사명 | "ambiguous"
    document_ids: tuple[str, ...]          # 보통 1개. 그룹 안에서도 못 좁히면 여러 개.
    selected: bool                         # True면 candidate_groups 중 최종 채택
    candidates: tuple[RetrievedChunk, ...] # 이 그룹에 속하는 원본 후보(순서 보존)

@dataclass(frozen=True)
class DocumentBindingResult:
    status: str                    # BOUND | MULTI_DOCUMENT_BOUND | AMBIGUOUS | UNRESOLVED
    selected_document_ids: tuple[str, ...]
    candidate_groups: tuple[CandidateGroup, ...]
    rejected_document_ids: tuple[str, ...]
    rejection_reasons: Mapping[str, tuple[str, ...]]   # doc_id -> 사유 목록
    retained_candidates: tuple[RetrievedChunk, ...]
    original_rank: Mapping[str, int]        # chunk_id -> 입력에서의 1-based rank
    document_budgets: Mapping[str, int]     # doc_id -> Evidence V2용 근거 예산(합계 <= 20)
    diagnostics: Mapping[str, Any]          # 감사용 — 어떤 우선순위가 왜 발동했는지
```

### status 의미

- `BOUND` — 정확히 하나의 document_id로 좁혀졌다(그 문서의 후보만 `retained_candidates`).
- `MULTI_DOCUMENT_BOUND` — 질문이 명시적으로 복수 문서를 요구하고(§5), 역할(role)별로
  각각 하나의 document_id로 좁혀졌다. `candidate_groups`에 역할마다 별도 그룹이 있다.
- `AMBIGUOUS` — 확신 있게 하나로 좁힐 수 없다(예: 우선순위 판단에 필요한 정보가
  후보마다 없거나 불명확). **아무것도 강제로 제외하지 않는다** — 살아남은 후보 전부가
  `retained_candidates`에 남고, `selected_document_ids`는 비운다(무엇도 확정하지 않음).
- `UNRESOLVED` — 입력이 비었거나, 명시적 충돌로 전부 제외돼 남은 문서가 없다.

### `retained_candidates` 규칙

- `BOUND`/`MULTI_DOCUMENT_BOUND`: `selected=True`인 그룹의 후보만(다른 문서로 새지 않게
  — 이것이 "단일 문서 질문의 근거 행을 서로 다른 문서에서 혼합 금지"의 실제 강제 지점).
- `AMBIGUOUS`: 명시적으로 제외되지 않은 후보 전부(아무것도 삭제하지 않는다).
- `UNRESOLVED`: 빈 튜플.

## 4. 문서 결박 기준 — 우선순위와 판정 규칙

다음 필드만 쓴다: `corp_code`/`corp_name`, `doc_group`, `doc_subtype`, `rcept_dt`,
`base_year`/`base_month`, `is_correction`, 질문에 명시된 날짜·기간, 기존 rank,
기존 candidate provenance.

각 문서(같은 `doc_id`의 후보들을 하나로 묶은 단위)에 대해 순서대로 검사한다. **판정에
필요한 값이 후보에 없으면 그 차원은 "불명" 표시만 하고 제외하지 않는다** — 아래 4개
우선순위 전부 이 규칙을 따른다.

1. **회사** — `conditions.corps`가 비어 있지 않은데, 문서의 `corp_code`(있으면) 또는
   정규화한 `corp_name`이 그 어떤 요구 회사와도 일치하지 않는다고 확신할 수 있으면 제외.
   (정규화: 공백 제거 후 완전일치 또는 포함 관계 허용 — 별칭·법인 형태 표기 차이 흡수.)
2. **문서군** — `conditions.doc_groups`가 비어 있지 않은데 문서의 `doc_group`이 그
   목록에 없으면 제외.
3. **접수일·기간** — 질문이 명시한 날짜(`question_dates()`)·연도(`conditions.years`)·
   연월(`conditions.year_months`)과 문서의 `rcept_dt`/`base_year`/`base_month`가
   확실히 다르면(예: 요구 연도가 있는데 문서 연도가 다른 연도로 명확함) 제외. 문서에
   해당 필드가 없으면 "기간 불명"으로 표시하고 제외하지 않는다.
4. **subtype** — `conditions.periodic_subtypes`/`exchange_subtypes`/`major_labels`
   중 문서의 `doc_group`에 해당하는 집합이 비어 있지 않은데, 문서의 `doc_subtype`이
   확실히 그 목록 밖이면 제외. `doc_subtype`이 비어 있으면 "subtype 불명"으로 표시하고
   제외하지 않는다.
5. **정정 여부** — `conditions.correction`이 True(질문이 정정공시를 요구)인데 문서의
   `is_correction`이 확실히 False면 제외. 반대 방향(질문이 정정을 요구하지 않는데
   문서가 정정)은 제외하지 않는다 — 정정본이 최신 유효본일 수 있어서다.
6. **동률 처리** — 위 1-5를 통과한 문서가 여럿이고, 그 문서들에 "불명" 표시가 하나도
   없다면(=판단에 필요한 정보가 전부 있었는데도 우열이 안 갈림) 기존 retrieval rank가
   가장 좋은(=가장 앞선) 문서를 채택한다(`BOUND`). "불명" 표시가 하나라도 있는 문서가
   섞여 있으면 rank로 임의로 자르지 않고 `AMBIGUOUS`로 유지한다.

## 5. 복수 문서 처리

다음 신호가 있으면 단일 문서로 강제하지 않는다(`MULTI_DOCUMENT_BOUND`):

| 신호 | 판정 | role 부여 |
|---|---|---|
| `len(conditions.years) >= 2` | 연도 비교 | `year_{YYYY}` |
| `len(conditions.year_months) >= 2` | 연월 비교 | `period_{YYYY}_{MM}` |
| `len(conditions.corps) >= 2` | 기업 비교 | 회사명 |
| 질문에 "정정 전"/"정정전"과 "정정 후"/"정정후"가 모두 있음, 또는 "변경 전"/"변경 후" | 정정·변경 전후 비교 | `before`(`is_correction=False`) / `after`(`is_correction=True`) |
| 질문에 "직전"과 ("현재" 또는 "이번")이 모두 있음 | 직전/현재 보고서 비교 | `previous`(rcept_dt가 이른 쪽) / `current`(rcept_dt가 늦은 쪽) |

역할마다 §4의 우선순위 + 동률 규칙을 **그 역할에 해당하는 후보 부분집합 안에서만** 다시
적용해 문서 하나로 좁힌다. 역할 안에서도 못 좁히면 그 역할의 그룹은 `selected=False`로
남고 전체 status는 `AMBIGUOUS`로 낮춘다(부분적으로만 확신 있는 상태를 `MULTI_DOCUMENT_BOUND`
로 과장하지 않는다). 한 evidence 자리의 값을 서로 다른 document_id의 행으로 채우는 것은
이 turn 다음(Evidence V2)의 책임이지만, DocumentBinder는 역할별 `document_ids`를
분리해 제공함으로써 그 혼합이 애초에 불가능하도록 경계를 긋는다.

## 6. Evidence 폭증 방지 — budget

- `DEFAULT_TOTAL_EVIDENCE_BUDGET = 20`(모듈 상수, 하드코딩 아님 — 특정 질문/기업과
  무관한 전역 상한).
- DocumentBinder는 **행을 만들지 않는다**(§1 금지 항목) — 대신 `retained_candidates`에
  실제로 등장하는 doc_id들에 한해, 그 rank 순서대로 결정론적으로 예산을 나눈다:
  `base = budget // n_docs`, 나머지는 rank가 앞선 문서부터 1씩 더 받는다. 문서가
  하나뿐이면 그 문서가 budget 전체(<=20)를 받는다 — "한 문서가 top-20을 모두 차지해도
  임의 cap을 적용하지 않는다"는 요구를 그대로 만족한다(cap은 총합에만 걸린다).
- `len(retained_candidates) <= len(retrieved_candidates) <= 20`은 새 candidate를
  만들지 않는 구현이므로 항상 자동으로 성립한다.

## 7. 산출물

- `src/dart_detective/arm_a_document_binder.py` — 위 계약을 구현하는 순수 모듈.
  검색·DB·KURE·LLM import 0.
- `tests/agents/test_arm_a_document_binder.py` — §필수 테스트 20종, 전부 합성 fixture.

이 문서와 구현 사이에 차이가 생기면 이 문서가 우선이다. 바꾸려면 새 turn에서 이 문서를
먼저 고쳐야 한다.
