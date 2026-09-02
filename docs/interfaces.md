# interfaces.md — 팀 코드가 만나는 지점 4곳 (초안 v0 · 2026-09-03)

> 상태: **DRAFT — 킥오프에서 확정.** 여기 적힌 것만 맞추면 세 사람은 완전히 병렬로 일한다.
> 확정 후에는 이 파일의 SHA-256을 기록하고, 변경은 팀 공지 + 이 파일 갱신으로만 한다.
> 근거: `docs/specs/team-architecture-v4.txt` §12·§13·§15, `docs/specs/4arm-vfinal-spec.txt` 1·6·7·14·15·20번.

표기: **소유자** = 그 타입을 만드는 사람. 나머지는 소비만 한다(필드 임의 추가·변경 금지).

---

## 0. 공통 원시 규약 (모든 계약이 공유)

### 0-1. doc_id
`{doc_group}_{rcept_no}` — 예 `holding_20240403000410`. DocumentIR·Gold·manifest 전부 동일.

### 0-2. locator — 본질은 (doc_id, node_index)
Gold(DEV_TUNE 101)의 `source_locator`는 두 표기가 섞여 있다(실측 345건):

| 표기 | 건수 | 예 |
|---|---|---|
| `{doc_id}/{rcept_no}.xml#node={N}[&row={R}&col={C}]` | 266 | `holding_20240620000340/20240620000340.xml#node=0&row=4&col=2` |
| `{doc_id}::{file}.xml::n{N}` | 79 | `holding_20240403000410::20240403000410.xml::n0` |

**규약**
- 러너 출력·어댑터·에이전트는 `doc_id`와 `node_index`를 **별도 정수 필드**로 반드시 싣는다. 문자열 locator는 표시용이다.
- 문자열 표기의 정본은 `{doc_id}/{rcept_no}.xml#node={node_index}` (B 스택 `answer_wire.source_locator_of`가 이미 이 형식). row/col은 알 때만 덧붙인다.
- 채점기는 Gold의 두 표기를 모두 `(doc_id, node_index[, row, col])`로 정규화해 비교한다. 러너가 Gold 표기를 흉내 낼 필요 없다.
- `node_index`는 DocumentIR `nodes[]`의 0-based 인덱스. A/C(Fixed-512) 청크가 여러 node에 걸치면 **slot이 매치된 span이 속한 node**를 적는다(vFINAL 14번은 slot-match 청크의 locator만 검사).

### 0-3. 공통 입력 SHA (킥오프 체크리스트 1번)
| 입력 | 위치 | SHA-256 |
|---|---|---|
| DocumentIR 4파일 | `~/Desktop/document_ir/{exchange,holding,major,periodic}.jsonl` | 킥오프에서 계산·기록 |
| DEV_TUNE 101 Gold | `data/eval/phase1_devtune_gold.v0.1.jsonl` | `7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b` |
| `data/corpus/universe.csv` | 확보·검증 완료 | `96560165c836b10e315cb253ab96a99b369478c3f71a0415d16b7b6fadbfa1dc` |
| `data/corpus/manifest.jsonl` | 확보·검증 완료 | `04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364` |
| conditions 파일 | `data/eval/devtune101_conditions.v1.jsonl` (§1-2) | 생성 후 기록 |
| 채점기 코드 + arm별 config | `scripts/fourarm/` (§1) | 실행 직전 HEAD SHA + config SHA 기록 |

---

## 1. 계약 ① — 4-arm 러너 출력 (소유: 각 arm 주인 / 소비: 공용 채점기)

### 1-1. 결과 파일 `results/{arm}.jsonl` — 문항당 1줄
```json
{"question_id": "author_0459b5f8f37b0192316cd77c",
 "arm": "B",
 "config_sha256": "…", "code_sha256": "…",
 "latency_ms": 812,
 "results": [
   {"rank": 1, "doc_id": "holding_20240403000410", "node_index": 1,
    "locator": "holding_20240403000410/20240403000410.xml#node=1",
    "chunk_id": "holding_20240403000410:n1:w0",
    "chunk_text_sha256": "…", "score": 17.42,
    "row": null, "col": null}
 ]}
```
- `arm` ∈ `A | B | C | D` (vFINAL 후보 ID: `A FIXED+FULL_DENSE`, `B LINE_WINDOW+LOW_ONLY_DENSE`, `C FIXED+DENSE_OFF`, `D LINE_WINDOW+DENSE_OFF`).
- `results`는 **20개까지** 보고(보고 k=5/10/20), 평가는 k=10 (vFINAL 15번). rank는 1부터.
- `chunk_text_sha256`는 `sha256(NFC 정규화 + 공백 제거한 청크 본문)`. 채점기가 원문 역참조로 대조할 때 쓴다.
- 문항 하나가 실패하면 `"results": []`에 `"error": "…"`를 붙이고 다음 문항으로. 실패 문항만 재실행 금지(15번).

### 1-2. 사전 계산 conditions 파일 `data/eval/devtune101_conditions.v1.jsonl` — 소유: 나, 네 arm 공통 입력
```json
{"question_id": "…", "segment": "LOW",
 "n_hard_conditions": 2,
 "conditions": {"corps": ["아모레퍼시픽"], "years": [2024], "year_months": [[2024,3]],
                "doc_groups": ["holding"], "periodic_subtypes": [], "exchange_subtypes": [],
                "major_labels": [], "correction": false, "wants_latest": false,
                "candidate_terms": ["보유비율", "…"]}}
```
- `conditions`는 `dart_corpus.retrieval.conditions.QueryConditions.as_dict()` 그대로.
- `n_hard_conditions` 계산 규칙(코드에 고정, 파일 헤더에 기록): `len(corps)` + (`years`∪`year_months` 비면 0 아니면 1) + (`doc_groups`∪`periodic_subtypes`∪`exchange_subtypes`∪`major_labels` 비면 0 아니면 1). `segment = LOW if n ≤ 2 else HIGH` (vFINAL 1번).
- **메타 필터 입력은 이 파일만** 쓴다. Gold의 `gold_document_ids`·`corp_codes`·`doc_groups`·slot 정보는 필터 생성에 사용 금지(vFINAL 20번, 위반 시 실험 INVALID). A/C도 자기 conditions 추출기를 돌리지 않는다.
- 파일 SHA를 킥오프에서 기록하고, 실행 후 변경 금지.

### 1-3. 실행 메타 `results/{arm}.run.json` — 1개
```json
{"arm": "B", "started_at": "…", "finished_at": "…", "host": "…",
 "config_sha256": "…", "code_sha256": "…",
 "input_sha256": {"gold": "7941144c…", "conditions": "…", "document_ir": {"exchange": "…", "holding": "…", "major": "…", "periodic": "…"}, "universe": "…"},
 "latency_ms": {"p50": 0, "p95": 0}, "peak_rss_mb": 0,
 "external_services": ["postgresql"]}
```
- latency/RSS 측정법은 vFINAL 18번(동일 warm-up 후 101문항, arm별 독립 프로세스 peak RSS). `external_services`는 배포 의존성 tie-break용.

### 1-4. UNRESOLVED 패킷 `results/unresolved/{packet_id}.json` — arm 라벨 제거해서 export (vFINAL 16번)
```json
{"packet_id": "u-0007", "question_id": "…", "slot_name": "evidence_2",
 "doc_id": "…", "node_index": 12, "chunk_text": "…", "reason": "locator가 다른 행을 가리키는 듯"}
```

### 1-5. 채점기 (소유: 나, 리뷰: 팀원1) — `scripts/fourarm/score.py`
입력 = Gold + conditions + `results/{arm}.jsonl` → 출력 = arm별 `{recall@5/10/20, all_required_slots_found (LOW/HIGH/전체), locator 치명/경미 건수, non_leak 검사 결과}` + 판정 체인 결과. 코드·config SHA를 실행 전에 고정.

---

## 2. 계약 ② — `/answer` 경계 (소유: 에이전트 함수 = 나 / HTTP·운영 = 팀원2)

### 2-1. 에이전트가 노출하는 함수 (딱 두 개)
```python
# src/dart_detective/answer_api.py  (신규 — 나)
def answer(question_id: str, question: str, *, deadline_s: float | None = None) -> dict[str, str]:
    """5개 str 필드만 반환. 어떤 내부 실패에도 예외를 던지지 않는다 —
    폴백(템플릿/발췌)으로 유효 응답을 만들고 think_trace에 실패 분류를 남긴다.
    deadline_s: 호출자가 남겨준 예산(초). 검색60/LLM40/합성30 소프트 컷은 이 안에서 나눈다."""

def readiness() -> dict:
    """{"ready": bool, "missing": [...], "pins": {"corpus_sha": …, "index_sha": …, "model_rev": …,
        "prompt_version": …, "config_sha": …}, "mode": "real" | "degraded"}  — vFINAL 19번·/ready용"""
```
반환 키는 정확히 `question_id, question, retrieved_context, think_trace, answer` (전부 `str`). 현재 `answer_wire.to_answer_wire`가 이미 이 모양이다.

### 2-2. 팀원2(qa_service)가 소유하는 것
- `GET /answer` 파라미터 검증(누락·빈 값·중복 → 400), `application/json`, 5필드 그대로 전달.
- 캐시: key = `question_id + sha256(question) + 설정 지문(readiness().pins)`. `mode == degraded`·폴백 결과는 캐시 금지 (`think_trace`에 `"fallback": true`면 제외).
- 세마포어 1 · 290초 데드라인(`deadline_s`로 남은 예산 전달) · 클라이언트 단절 시 취소 · 재시도 겹침 대응.
- `/health`(프로세스 생존) · `/ready`(`readiness().ready`) 분리 · 요청 전량 로깅(질문 원문·키 제외) · crash 자동 재기동.
- 기동 시 preload(`answer_api` import → 인덱스 로드) + 워밍업 1회 + `/ready` 검증.

### 2-3. 환경·실행 규약
| 항목 | 값 |
|---|---|
| Python | **3.12** (requirements-lock.txt가 3.12.2 기준) |
| 서버 | FastAPI + uvicorn, worker 1 |
| 포트 | 앱 8000, 외부 80은 팀원2 결정(직접 바인딩 또는 nginx) |
| 기존 환경변수 | `DART_QA_DOC_INDEX`, `DART_QA_DOCUMENTS`, `DART_QA_UNIVERSE`, `DART_QA_LOG_LEVEL`, `CLOVA_API_KEY`, `CLOVA_MODEL=HCX-005`, `CLOVA_ENDPOINT` |
| 신규 환경변수 | `DART_QA_ARM` (A/B/C/D — 어댑터 바인딩), `DART_QA_DOCUMENT_IR_DIR` (DocumentIR 4파일 디렉터리), `DART_QA_CONDITIONS` (선택), `DART_QA_DEADLINE_S=290`, `DART_QA_CACHE_DIR` |
| 비밀 | `.env`만, 커밋 금지, 로그에 마스킹(`scripts/qa_preflight.py` 방식) |

---

## 3. 계약 ③ — `retriever_adapter` (정의: 나 / 구현: B·D = 나, A·C = 팀원1)

```python
# src/dart_detective/retriever_adapter.py
from typing import Protocol, TypedDict

class Chunk(TypedDict):
    chunk_id: str
    doc_id: str
    node_index: int          # 0-based, DocumentIR nodes[]
    locator: str             # "{doc_id}/{rcept_no}.xml#node={node_index}"
    text: str                # 검색·표시용 본문(머리글 제외)
    header: str              # 표 머리글, 없으면 ""
    section_path: list[str]
    doc_group: str
    score: float
    metadata: dict           # corp_name, rcept_dt, report_nm, is_correction 등 문서 메타

class Node(TypedDict):
    doc_id: str
    node_index: int
    kind: str                # paragraph | table | heading …(DocumentIR node.kind 그대로)
    section_path: list[str]
    lines: list[str]         # 표는 행 단위, 문단은 줄 단위 — 근거 확정(⑤)이 여기서 값·연도열을 잡는다
    text: str

class RetrieverAdapter(Protocol):
    arm: str                                   # "A" | "B" | "C" | "D"
    def search(self, question: str, conditions: dict, k: int = 20) -> list[Chunk]: ...
    def fetch_node(self, doc_id: str, node_index: int) -> Node: ...
    def readiness(self) -> dict: ...           # {"ready", "pins": {...}, "external_services": [...]}

def bind(arm: str) -> RetrieverAdapter: ...    # DART_QA_ARM으로 선택
```
- `conditions`는 §1-2의 `conditions` dict 그대로(사전 계산본이 있으면 그것, 런타임엔 `extract_conditions`).
- 4-arm 러너는 **이 어댑터의 `search`만 호출**해서 §1-1을 쓴다 → 실험 코드와 배포 코드가 같은 경로를 탄다.
- `fetch_node`는 DocumentIR 4파일 위의 **byte-offset 색인**(`src/dart_corpus/retrieval/node_store.py`, 나 제공, 두 스택 공용)으로 구현. 8GB를 메모리에 올리지 않는다.
- B/D 바인딩 = `CorpusRetriever.retrieve` → `RetrievedChunk` → `Chunk` 변환(기존 코드 수정 없음). A/C 바인딩 = 팀원1이 pgvector 스택 위에 구현.

---

## 4. 계약 ④ — HCX Native Function Calling `submit_grounded_answer` (소유: FC 코드 주인 + 나)

```json
{"name": "submit_grounded_answer",
 "description": "검증된 근거 안에서만 답한다. 근거에 없는 값은 not_found_slots에 넣는다.",
 "parameters": {"type": "object", "required": ["claims", "not_found_slots", "uncertainty"],
  "properties": {
    "claims": {"type": "array", "items": {"type": "object", "required": ["text", "doc_id", "quote"],
      "properties": {
        "text":        {"type": "string",  "description": "한국어 사실 문장 1개"},
        "value":       {"type": ["string", "number", "null"], "description": "문장 속 핵심 수치(원문 표기 그대로)"},
        "unit":        {"type": ["string", "null"]},
        "period":      {"type": ["string", "null"], "description": "예 2024, 2024Q1, 2024-03-22"},
        "period_kind": {"type": ["string", "null"], "enum": ["FY", "Q", "H", "CUM", "AS_OF", null]},
        "doc_id":      {"type": "string"},
        "quote":       {"type": "string",  "description": "근거 원문 부분문자열(공백만 다를 수 있음)"}}}},
    "not_found_slots": {"type": "array", "items": {"type": "string"}},
    "uncertainty":     {"type": "string"}}}}
```
- 검증 게이트 대응: `quote` → quote_grounded · `value`/`unit` → numbers_bound/units_exact · `period` → period_bound · `doc_id` → citation_bound(실사용 근거 안에 있어야 함).
- 스키마가 곧 계약: 필드 추가·이름 변경은 검증기 재작성이므로 킥오프 후 동결(`prompts/VERSION`에 스키마 SHA 포함).
- HCX-005 · temperature 0.1 · seed 고정 · 호출 40초 · 429 백오프 1회 · maxTokens 타이트(TPM = input + maxTokens).

---

## 5. 킥오프에서 확인·결정할 것
1. ~~코퍼스 원본 부재~~ → **해결(2026-09-03).** 주최측 드라이브에서 `manifest.jsonl`·`universe.csv`를 확보했고 SHA가 `corpus_snapshot.json` 기록값과 일치한다(`docs/CONTEXT.md` §0). 재생성 우회로·`filer_name` 근사 채움은 **불필요**해졌다.
   남은 재생성 작업(코퍼스 원본 없이 가능, 신규 디스크 약 45MB):
   | 만들 것 | 재료 | 크기 |
   |---|---|---|
   | `data/index/doc_index.jsonl` | DocumentIR 스트리밍 + `data/corpus/manifest.jsonl` 조인, 문서당 본문 3,000자 | ~40MB |
   | `data/index/node_offsets.jsonl` | DocumentIR 4파일의 doc_id → (파일, byte offset, length) | ~400KB |
   예전 `doc_index.jsonl`(111MB)과는 다른 파일이므로 새 SHA를 기록하고, 예전 R@10 0.868과 직접 비교하지 않는다.
2. **Gold Owner** — DEV_CHECK 47 one-shot 실행자·UNRESOLVED arm-blind 판정자.
3. **A/C readiness 컷오프**(제안 9/4 12:00)와 미실행 arm 처리.
4. **PG 호스팅** 위치·비용.
5. A/C 청크의 `node_index` 결정 규칙(0-2) 확인 — Fixed-512 청크가 node 경계를 넘을 때.
