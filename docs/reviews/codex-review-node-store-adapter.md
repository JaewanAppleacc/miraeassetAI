# Codex 검수 요청 — ④ NodeStore(지연 로딩 색인) + segments + retriever_adapter(B/D 바인딩)

당신은 독립 검수자다. **코드를 수정하지 말고**, 체크리스트대로 검사한 뒤 보고서만 작성한다.
작업 폴더: 저장소 루트(`ai_festival`). Python은 `.venv/bin/python`. HCX/CLOVA 호출 금지(비용 0).

## 0. 먼저 읽을 것
1. `CLAUDE.md` — 절대 원칙 + **저장공간 원칙**(8GB DocumentIR 복사·변환 금지, 새 산출물 200MB 이하)
2. `docs/specs/4arm-vfinal-spec.txt` **1번(Segmentation)·6번(Same inputs)·7번(As-built)·14번(locator)·20번(non-leak)**
3. `docs/interfaces.md` **§0-2(locator)·§1-2(conditions 파일·세그먼트 규칙)·§3(retriever_adapter)·§5-6·§5-7**

## 1. 변경의 목적
전체 코퍼스(DocumentIR 4,204건·8GB) 위에서 기존 B/D 검색 코어(`CorpusRetriever`)를 **메모리에 다 올리지 않고** 돌리고, 에이전트·4-arm 러너가 검색 코어를 `RetrieverAdapter` 하나로 부르게 한다. **검색 점수·조건 추출·청킹 로직은 바꾸지 않는다.**

## 2. 변경 범위 — 기준선은 커밋 `056ed14` 이후 (`git diff 056ed14 --stat`)
| 파일 | 성격 |
|---|---|
| `src/dart_corpus/retrieval/node_store.py` | **신규.** byte-offset 색인 빌드 + `NodeStore`(Mapping, LRU) + raw→evidence document 변환 |
| `src/dart_corpus/retrieval/segments.py` | **신규.** vFINAL 1번 LOW/HIGH 단일 정의 + conditions dict 역변환 |
| `src/dart_detective/retriever_adapter.py` | **신규.** Chunk/Node 계약, Protocol, `LineWindowAdapter`(B/D), `bind(arm)` |
| `scripts/build_index.py` | **신규.** 색인 빌더 CLI |
| `tests/retrieval/test_node_store.py`, `tests/agents/test_retriever_adapter.py` | **신규.** 17개 |
| `.gitignore` | `data/index/` 추가 |
| `CLAUDE.md`, `docs/interfaces.md` | 상태 갱신 |

**`src/dart_corpus/retrieval/` 의 기존 파일(conditions.py·document_index.py·chunk_index.py·lexical.py·chains.py·corp_dictionary.py)과 `src/dart_detective/corpus_retriever.py`는 byte 무변경이어야 한다.** `git diff 056ed14 -- src/dart_corpus/retrieval/conditions.py …` 로 확인.

## 3. 체크리스트 (PASS / FAIL / 판단불가 + file:line)

### A. 설계·스펙 정합
- [ ] A1. `segments.hard_condition_count`가 interfaces.md §1-2의 계산 규칙과 정확히 같은가(len(corps) + 기간 유무 1 + 문서군/서브타입/라벨 유무 1). `LOW = ≤2`(vFINAL 1번)
- [ ] A2. 세그먼트 정의가 **한 곳**에만 있는가(arm별 재계산 금지 — vFINAL 1번). `grep -rn "<= 2\|LOW" src/` 로 다른 정의가 없는지
- [ ] A3. `node_index`가 DocumentIR `nodes[]`의 0-based 위치인가(§0-2). Gold locator 두 표기(`#node=N`, `::nN`)가 같은 번호를 가리키는가 — `docs/interfaces.md` §5-7의 실측(345/345 해석)을 재현할 수 있으면 재현
- [ ] A4. `locator_of`가 `{doc_id}/{rcept_no}.xml#node={node_index}` 정본 표기를 만드는가(§0-2). rcept_no는 doc_id 뒤 숫자
- [ ] A5. B arm: LOW 세그먼트에서만 dense 재정렬, HIGH에서는 BM25 그대로(v4 §8 "B만 LOW-confidence 시 KURE 재정렬"). dense가 없으면 **B를 D로 조용히 대체하지 않고** `readiness().ready=False` + LOW에서 예외인가(as-built 위장 금지)
- [ ] A6. 사전 계산 conditions(dict)가 주어지면 **재추출하지 않고** 그대로 쓰는가(vFINAL 20번·§1-2). 없을 때만 `retriever.conditions()` 호출
- [ ] A7. 메타 필터 입력에 Gold 유래 정보가 들어갈 경로가 없는가(20번). 어댑터·NodeStore가 gold 파일을 읽지 않는가

### B. 검색 코어 무변경(as-built)
- [ ] B1. 위 기존 파일들 byte 무변경
- [ ] B2. `LineWindowAdapter.search`가 `CorpusRetriever.retrieve`를 **그대로** 호출하고 점수·순서를 바꾸지 않는가(D arm). 잘라내기(`[:k]`)는 dense 재정렬 뒤에만
- [ ] B3. `to_evidence_document`가 만드는 형식이 옛 `evidence_documents.jsonl`(chunk_index.chunk_document 주석)과 같은가: `{doc_id, doc_group, nodes:[{node_index, kind, text, section_hierarchy}]}`
- [ ] B4. `node_dict_to_text`가 `chunking.node_text.node_to_text`와 **동치**인가 — `tests/retrieval/test_node_store.py::test_dict_text_matches_node_to_text_on_representative_documents`(대표 문서 11건 실데이터) 통과. 규칙 차이가 있으면 지적(표 제목 조건, normalized_rows 빈 경우 raw_rows fallback)

### C. 저장공간·메모리
- [ ] C1. 새 산출물 총량: `du -sh data/index` ≤ 50MB. DocumentIR을 복사·변환한 대용량 파일이 없는가
- [ ] C2. `build_index`가 문서 한 건씩 스트리밍하는가(전체 로드 없음). `_iter_lines_with_offsets`의 offset이 `readline` 직전 `tell()`인가
- [ ] C3. `NodeStore`가 raw_cells·raw_rows(크기 89%)를 캐시에 남기지 않는가(evidence document만 캐시)
- [ ] C4. LRU 크기 기본값(32)과 Stage 1 k=50의 관계가 주석에 설명되어 있는가. 재읽기 발생 가능성이 감춰지지 않았는가

### D. 무결성·관측
- [ ] D1. `index_manifest.json`에 DocumentIR 4파일 SHA-256·bytes·n_docs, manifest SHA, text_recipe·text_cap이 기록되는가(체크리스트 1번 input SHA 근거)
- [ ] D2. `NodeStore.__init__`가 파일 크기 불일치를 감지해 실패하는가(전체 SHA 재계산은 8GB라 하지 않음 — 그 한계가 주석에 있는가)
- [ ] D3. `readiness()`가 pins(document_ir SHA·manifest SHA·text_recipe·strategy·k·dense_model_rev)와 `external_services`를 돌려주는가(vFINAL 18·19번)
- [ ] D4. `bind()`가 A/C에 대해 `NotImplementedError`로 **명시적으로** 위임하는가(B/D로 대체 금지)

### E. 테스트
- [ ] E1. `.venv/bin/python -m pytest -q -m "not integration"` → 기존 550 + 신규 17 = **567 passed**, 23 errors(corpus root 부재, 기존과 동일)
- [ ] E2. 어댑터 테스트가 실제 세그먼트 규칙을 존중하는가 — "매출액"이 문서군을 추론해 HIGH가 되는 케이스가 주석으로 설명되어 있는가(`test_d_arm_search_returns_chunk_contract`)
- [ ] E3. B arm 테스트가 dense 호출 횟수로 "LOW에서만 재정렬"을 검증하는가

### F. 금지 사항
- [ ] F1. HCX 호출 없음 · DEV_CHECK/HOLDOUT 접근 없음
- [ ] F2. `data/index/`가 커밋 대상이 아닌가(.gitignore) · `work/corpus.zip`이 커밋되지 않았는가
- [ ] F3. 폐기 표현 없음("Fixed-512 최종", "PG 불가 시 B 자동 전환", "LIST 유형")

## 4. 실측 참고 (검수자가 재현 가능)
```
.venv/bin/python - <<'PY'
from dart_detective import retriever_adapter as ra
ad = ra.bind("D"); print(ad.readiness()["ready"], ad.readiness()["n_docs"])
print(len(ad.search("삼성전자의 2024년 매출액은 얼마인가?", k=20)))
PY
```
기록된 실측: bind 2.8s · Gold 8문항 검색 평균 1.7s/최대 3.1s · Gold 8/8 상위20 포함 · 정기공시 16MB 문서 로드+변환 0.23s.

## 5. 보고 형식
```
판정: 승인 / 조건부 승인 / 반려
요약: (3줄 이내)
발견 사항 (심각도 순): [FAIL|WARN] 항목ID — file:line — 문제 — 이유
PASS 항목: (ID 나열)
판단불가 항목과 이유:
git diff 056ed14 --stat 결과:
pytest 결과 (passed / failed / errors):
```

## 6. 하지 말 것
코드·테스트·문서 수정 금지(제안은 글로만) · HCX 호출 금지 · `docs/specs/` 수정 금지 · `data/index/` 재빌드는 해도 되나 133초·디스크 23MB가 든다(선택).
