# Codex 검수 요청 — 4-arm 검색 실험 자산 일체 (색인·어댑터·B dense·조건 사전 계산·러너·채점기·판정 체인)

당신은 독립 검수자다. **코드를 수정하지 말고**, 체크리스트대로 검사한 뒤 보고서만 작성한다.
작업 폴더: 저장소 루트(`ai_festival`). Python은 `.venv/bin/python`. **HCX/CLOVA 호출 금지**(이번 범위엔 LLM이 없다).
KURE 모델 로드는 허용되나 필수는 아니다(테스트는 전부 가짜 encoder로 돈다). 8GB 기기이므로 KURE와 다른 대용량 작업을 동시에 띄우지 마라.

이 브리프는 `docs/reviews/codex-review-node-store-adapter.md`(초안)를 **대체**한다.

## 0. 먼저 읽을 것
1. `CLAUDE.md` — 절대 원칙·저장공간 원칙·현재 상태
2. `docs/specs/4arm-vfinal-spec.txt` — **1·2·4·5·6·7·10·11·12·14·15·16·17·18·20·21번** 전부
3. `docs/interfaces.md` — §0·§1(전부)·§3·§5-6~§5-8

## 1. 변경의 목적
vFINAL 4-arm 실험을 실제로 돌릴 수 있는 B/D 쪽 자산과 **네 arm 공용** 자산(조건 파일·채점기·판정 체인)을 만든다. 검색 코어의 기존 파일은 바꾸지 않는다.

## 2. 변경 범위 — 기준선 커밋 `056ed14` 이후 (`git diff 056ed14 --stat`, 미추적 파일은 `git status`)
| 파일 | 성격 |
|---|---|
| `src/dart_corpus/retrieval/node_store.py` | 신규. DocumentIR byte-offset 색인 + 지연 로딩 Mapping + raw→evidence document 변환 |
| `src/dart_corpus/retrieval/segments.py` | 신규. vFINAL 1번 LOW/HIGH **단일 정의** + conditions dict 역변환 |
| `src/dart_corpus/evaluation/fourarm.py` | 신규. 공용 채점기(slot found·Recall@k·all_found·locator 검사·UNRESOLVED 패킷) + 판정 체인 `judge` |
| `src/dart_detective/retriever_adapter.py` | 신규. Chunk/Node 계약·Protocol·`LineWindowAdapter`(B/D)·`bind(arm)` |
| `src/dart_detective/dense_rerank.py` | 신규. B arm LOW 세그먼트 KURE 재정렬(BM25 후보 50 → cosine) |
| `scripts/build_index.py` · `scripts/fourarm/{precompute_conditions,run_arm,score}.py` | 신규 CLI |
| `tests/retrieval/test_node_store.py` · `tests/agents/test_retriever_adapter.py` · `tests/agents/test_dense_rerank.py` · `tests/evaluation/test_fourarm.py` | 신규 35개 |
| `.gitignore` · `CLAUDE.md` · `docs/interfaces.md` · `docs/team-split.md` | 갱신 |

**byte 무변경이어야 하는 것**: `src/dart_corpus/retrieval/{conditions,document_index,chunk_index,lexical,chains,corp_dictionary}.py`, `src/dart_corpus/chunking/*`, `src/dart_detective/corpus_retriever.py`, `src/dart_detective/agents/*`, `docs/specs/*`.

## 3. 체크리스트 (PASS / FAIL / 판단불가 + file:line)

### A. vFINAL 정합 — 채점 정의와 판정 체인 (가장 중요)
- [ ] A1. `segments.hard_condition_count` = interfaces.md §1-2 규칙. LOW = ≤2. 정의가 **한 곳**뿐인가(`grep -rn "LOW" src/`)
- [ ] A2. `fourarm.slot_found`: 1순위 (doc_id, node_index ∪ node_indices) 일치, 2순위 같은 doc_id에서 evidence_span 한 줄(공백 제거·6자↑) 포함. Gold 두 locator 표기 모두 파싱(`parse_locator`)
- [ ] A3. Recall@k = slots_found/slots_total(micro), all_found@k = 필수 slot 전부 found 문항 수, 0-slot 문항 제외 — 코드와 docstring·interfaces.md §1-5가 일치하는가
- [ ] A4. locator 검사(14번): **slot-match 청크만** 검사하는가. 문서 없음·node 범위 밖 = 치명 · 텍스트 없음 또는 node 원문과 대조 불가 = UNRESOLVED(치명 아님) · Gold와 청크 모두 row/col이 있는데 다름 = 경미 · 청크에 row/col이 없음 = coarse(위반 아님, 정보). top-k 비관련 청크를 위반으로 세지 않는가
- [ ] A5. `judge` 순서가 vFINAL 판정 체인과 같은가: 14 locator 검사 여부(미검사 → INVALID) → 20 pins → 16 unresolved → 12 Hard → 12 Quality(hard-safe 최고 대비 차이 < 0.01 이어야 통과 — "0.01 이상 낮으면 탈락", 전체·HIGH) → 2 LOW all_found(LOW≥10) → 5 FINAL_TIE_SET(≤1) → dense-off 우선 → 11+18 C/D tie-break(경미→p95 ≤5%→RSS ≤5%→외부 서비스→D) → A/B 동률 B(PERFORMANCE_TIE_BREAK_SELECTION) → 3/8 LOW<10 의역 → 10 B fallback(두 gate+배포 가능성) → BLOCKED
- [ ] A6. 12번: Hard-failed arm 점수가 Quality 기준값에 **쓰이지 않는가**(hard_safe 안에서만 max)
- [ ] A7. 5번: 최고−2 이상 arm 탈락, FINAL_TIE_SET에 C/D 있으면 dense-off 우선, C·D 둘 다면 11번
- [ ] A8. 10번: B fallback은 B가 Hard·Quality 통과 **그리고** deployable일 때만. 성능 승자와 구분(`selection_type`)
- [ ] A9. 16번: UNRESOLVED 패킷에 arm 라벨이 없고 id가 내용 해시라 arm 간 충돌하지 않는가(`unresolved_packets`, score.py는 전 arm 패킷을 모아 한 번 기록). 승자에 unresolved가 있으면 상태 `PENDING_UNRESOLVED` + `candidate`(winner 없음)인가 — 16C 선택 보류
- [ ] A10. 17번: 결과가 PROVISIONAL_WINNER로만 표기되고 FINAL로 승격하는 코드가 없는가(DEV_CHECK는 이번 범위 밖)
- [ ] A11. 20번 non-leak: `precompute_conditions.py`가 Gold에서 `question_id`·`question`만 읽는가(`ALLOWED_GOLD_FIELDS`). `run_arm.py`가 Gold를 **열지 않는가**. 어댑터·NodeStore가 gold 파일을 읽지 않는가
- [ ] A12. 15번: 러너가 실패 문항만 재실행하지 않는가(예외 기록 후 계속). `run.json`에 config(= readiness pins **전부**)·config_sha·code_sha·`git_dirty`(src/·scripts/ 미커밋 변경 시 실행 거부, `--allow-dirty`는 디버그 전용)·input_sha(conditions·document_ir·doc_index·universe·manifest)가 있는가. **`code_sha256`가 실제 실행 코드를 담은 커밋인가**
- [ ] A13. 18번: warm-up 1회(미기록) 후 측정, p50/p95, arm별 독립 프로세스 peak RSS

### B. as-built·무변경
- [ ] B1. 위 "byte 무변경" 파일 확인
- [ ] B2. `LineWindowAdapter.search`가 D에서 `CorpusRetriever.retrieve` 결과 순서를 바꾸지 않는가. B·LOW에서만 pool(50) → 재정렬 → k 절단인가
- [ ] B3. B에 dense가 없으면 `readiness().ready=False` + LOW에서 예외(조용한 D 대체 금지). `bind("B")`는 KURE를 자동 구성하고 실패 시 명확히 에러
- [ ] B4. `dense_rerank`: model·revision(`4ed4540949c70b7da2c74004a915e1f2d5e46e4f`)·device·dtype·pool·max_seq·반올림 자릿수가 pins로 기록되는가. 동률을 BM25 순위로 푸는가(기기 간 재현)
- [ ] B5. `to_evidence_document`/`node_dict_to_text`가 `chunking.node_text.node_to_text`와 동치 — 대표 문서 11건 테스트 통과

### C. 저장공간·메모리 (사용자 요구)
- [ ] C1. `du -sh data/index` ≤ 50MB, DocumentIR 복사본 없음. 모델은 HF 캐시(홈)에만
- [ ] C2. `build_index` 스트리밍(문서 1건씩), NodeStore가 raw_cells/raw_rows를 캐시하지 않음, LRU 기본 32

### D. 실측 재현 (선택 — 시간이 있으면)
- [ ] D1. `scripts/fourarm/score.py --arms B D` 재실행 → `results/fourarm/summary.md`와 같은가(D: Recall@10 0.6049 / @20 0.6748 / LOW all_found 11/19 · B: Recall@10 0.6084 / LOW all_found 12/19 · 위반 0 · 판정 D PROVISIONAL_WINNER)
- [ ] D2. `results/fourarm/D.run.json`의 `input_sha256.conditions`가 `data/eval/devtune101_conditions.v1.meta.json`의 `output_sha256`과 같은가
- [ ] D3. interfaces.md §5-8의 주장 검증: `experiments/phase1/target_docs.json`이 정확히 Gold 정답 문서 106건인가(예전 97%의 측정 범위)

### E. 테스트
- [ ] E1. `.venv/bin/python -m pytest -q -m "not integration"` → **585 passed**, 23 errors(corpus root 부재, 기존 동일)
- [ ] E2. `test_fourarm.py`가 판정 체인의 각 분기(hard 탈락·BLOCKED·quality 마진·tie_set·dense-off·C/D latency·A/B→B·LOW_UNDERPOWERED→fallback/BLOCKED·INVALID·PENDING)를 최소 1건씩 덮는가
- [ ] E3. `test_retriever_adapter.py`가 세그먼트 규칙("매출액"→문서군 추론→HIGH)을 존중하는가

### F. 금지
- [ ] F1. HCX 호출 없음 · DEV_CHECK/HOLDOUT 접근 없음(`grep -rn "DEV_CHECK\|HOLDOUT" src scripts` 는 주석·문자열뿐)
- [ ] F2. `data/index/`·`results/**/*.results.jsonl`·`work/` 커밋 제외
- [ ] F3. 폐기 표현 없음

## 4. 보고 형식
```
판정: 승인 / 조건부 승인 / 반려
요약: (3줄 이내)
발견 사항 (심각도 순): [FAIL|WARN] 항목ID — file:line — 문제 — 이유
PASS 항목: (ID 나열)
판단불가 항목과 이유:
git diff 056ed14 --stat / git status 결과:
pytest 결과 (passed / failed / errors):
```

## 5. 하지 말 것
코드·테스트·문서 수정 금지 · HCX 호출 금지 · `docs/specs/` 수정 금지 · `results/fourarm/*.results.jsonl` 수정 금지(실험 원본) · 4-arm 러너 재실행은 `--limit 5`까지만(B는 KURE 로드 25s + 문항당 최대 20s).
