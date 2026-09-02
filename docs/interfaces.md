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
| conditions 파일 | `data/eval/devtune101_conditions.v1.jsonl` (§1-2) | **`6ff1b4fce45bb46db0179d79439a310bcbb95cb3c1e1b2e2ddb2acd165137cf5`** (2026-09-03 04:24, code 056ed14) |
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
    "text": "…(선택·권장) 청크 본문 — 채점기의 2순위 텍스트 대조와 UNRESOLVED 검토용",
    "node_indices": [1, 2], "row": null, "col": null}
 ]}
```
- `node_indices`(선택): Fixed-512처럼 청크가 여러 node에 걸치면 걸친 node 전부. 채점기는 `node_index` ∪ `node_indices`로 대조한다.
- `segment`(문항 레벨, 선택): 사전 계산 파일의 세그먼트를 그대로 echo. `dense_reranked`·`pool`(B만).
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
- **생성 완료(`scripts/fourarm/precompute_conditions.py`)**: 101문항 = **LOW 20 / HIGH 81** (확정 조건 1개 2문항, 2개 18, 3개 80, 4개 1). 기업 미검출 5문항(답변가능성·함정 문항 계열). 메타 파일 `devtune101_conditions.v1.meta.json`에 gold·universe SHA·코드 HEAD·규칙 문자열 기록.
- **LOW ≥ 10 이므로 vFINAL 3번 LOW_UNDERPOWERED가 발동하지 않는다** → frozen paraphrase set(9·13번) 작성·독립 검수 절차 **불필요**. 단, 16A 공통 제외 후 LOW가 10 미만으로 떨어지면 되살아난다.

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

### 1-5. 채점기 (소유: 나, 리뷰: 팀원1) — `src/dart_corpus/evaluation/fourarm.py` + `scripts/fourarm/score.py`
입력 = Gold + conditions + `results/fourarm/{arm}.results.jsonl` + `{arm}.run.json` → 출력 = `score.{arm}.json`, `judgement.json`, `summary.md`, `unresolved/u-x-NNN.json`(arm 라벨 제거).
**채점 정의(고정)**:
- slot found@k: 1순위 (doc_id, node_index ∪ node_indices) 일치 · 2순위 같은 doc_id에서 Gold evidence_span의 한 줄(공백 제거·6자 이상)이 청크 `text`에 포함.
- Recall@k = slots_found@k / slots_total (micro) · 전체/HIGH/LOW. all_found@k = 필수 slot 전부 found인 문항 수(LOW 주 판정).
- 제외: required slot 0개 문항(Recall 분모 제외, 수 보고).
- locator 검사(14번): slot-match 청크만. 문서 없음·node 범위 밖 = 치명 · 청크 텍스트가 node 원문과 대조 불가 = UNRESOLVED(16번 패킷) · row/col 차이 = 경미.
- 판정 체인(judge): 20 pins → 16 unresolved 표시 → 12 Hard → 12 Quality(−0.01) → 2 LOW all_found@10 → 5 FINAL_TIE_SET(≤1) → dense-off 우선 → 11+18 C/D tie-break → A/B 동률=B → 3/8 LOW<10 의역 → 10 B fallback → BLOCKED.
러너: `scripts/fourarm/run_arm.py --arm B|D` (Gold를 열지 않음 — 조건 파일만 읽음, non-leak 구조 보장).

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
   | `data/index/doc_index.jsonl` | DocumentIR 스트리밍 + `data/corpus/manifest.jsonl` 조인, 문서당 본문 3,000자 | **22.5MB (완료)** |
   | `data/index/node_offsets.jsonl` | DocumentIR 4파일의 doc_id → (파일, byte offset, length) | **0.5MB (완료)** |
   완료(2026-09-03 04:11, 133초). `data/index/index_manifest.json`에 DocumentIR 4파일 SHA-256·manifest SHA·텍스트 규칙(`node_texts_joined_v1`, cap 3000)·doc_index SHA `c93c18f7…`가 기록됐다. 예전 `doc_index.jsonl`(111MB)과는 다른 파일이므로 예전 R@10 0.868과 직접 비교하지 않는다.
2. **Gold Owner** — DEV_CHECK 47 one-shot 실행자·UNRESOLVED arm-blind 판정자.
3. **A/C readiness 컷오프**(제안 9/4 12:00)와 미실행 arm 처리.
4. **PG 호스팅** 위치·비용.
5. A/C 청크의 `node_index` 결정 규칙(0-2) 확인 — Fixed-512 청크가 node 경계를 넘을 때.
6. ~~B arm의 dense 재정렬 실행 환경~~ → **해결(2026-09-03, 선택지 ①).** torch + sentence-transformers(.venv) · KURE-v1 rev `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`(HF 캐시 2.1GB) · `src/dart_detective/dense_rerank.py`. B as-built 구성: LOW 세그먼트에서만 BM25 후보 **50개**(dense_pool) → KURE cosine 재정렬 → k 절단. MPS fp16 · max_seq_length 512 · 점수 소수 3자리 반올림, 동률은 BM25 순위(CPU fp32와 순서 동일 확인). HIGH는 D와 동일 경로. 실측 재정렬 20청크 8.1s.
8. **예전 실측 숫자의 범위 — 전체 코퍼스 성능이 아니다(2026-09-03 확인).** `experiments/phase1/run_retrieval_only.py`는 Stage 2 문서 풀로 `candidate_documents.jsonl`(= `target_docs.json`, **정답 문서 106건 딱 그것**)을 썼다. Stage 1은 전체 문서 인덱스였지만 청킹·근거 선택은 정답 문서에서만 이뤄졌으므로 "정답 문서 상위20 100% · 슬롯 97.0%"는 **정답 문서 풀 안에서의 수치**다. 전체 코퍼스(4,204건)에서 같은 코드로 잰 D arm은 **Recall@10 0.605 · Recall@20 0.675 · LOW all_found@10 11/19**(2026-09-03 04:30, config `4b217240…`). 팀원1의 "Fixed R@10 0.868(bounded retrieval)"도 같은 종류의 bounded 수치일 수 있으니 킥오프에서 측정 범위를 확인한다. **4-arm 실험이 전체 코퍼스 위의 첫 정직한 비교다.**
   - 손실 위치(D, 놓친 슬롯 97/286): 전부 Stage 1 풀(50문서) 안에 있고 청크 순위 경쟁에서 밀림 — 전체 순위 21~50위 33개, 51~200위 49개, 200위 밖 15개. 문서군별 exchange 55·holding 28·major 8·periodic 6. Stage 1 실패 0.
   - **B arm 실측(2026-09-03 04:50, config `4f2edea2…`)**: Recall@10 0.6084 · @20 0.6818 · HIGH R@10 0.588 · LOW R@10 0.75 · LOW all_found@10 12/19 · 치명 0 · 미해결 0 · p95 19714ms · RSS 2240.6MB. D 대비 LOW all_found +1, 전체 R@10 +0.0035 — dense 재정렬의 효과는 미미하다.
   - **B·D 2-arm 판정(A/C 대기)**: 둘 다 Hard·Quality 통과 → LOW all_found 12 vs 11 → FINAL_TIE_SET {B, D} → dense-off 우선 → **D = PROVISIONAL_WINNER(PERFORMANCE_WINNER)**. `results/fourarm/judgement.json`. A/C 결과가 오면 4-arm으로 재판정한다.
   - 이는 as-built 동작이며 버그가 아니다. DEV_TUNE은 튜닝 자유(v4 §10)이므로 **config 동결(체크리스트 1번) 전에는** B/D 조정이 허용된다. 조정하면 config SHA를 새로 기록한다.
7. Gold locator 대조 실측: 345개 locator 전부 (doc_id, node_index)로 해석됨. 다만 32건은 `evidence_span` 표기가 우리 표 렌더링과 다르다(병합 셀을 Gold는 1회, DocumentIR normalized_rows는 colspan만큼 반복). 노드 번호는 맞다. → 채점기의 slot-match는 **노드 번호 일치를 1순위**, 텍스트 대조는 공백·중복 셀 정규화 후 2순위로 한다(phase1 `slot_hit` 방식 유지).
