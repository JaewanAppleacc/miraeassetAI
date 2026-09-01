# DART Corpus — Workstream A Handoff

Workstream A(Manifest/Universe Loader, Corpus Snapshot, Canonical Parser, DocumentIR)의
코드와 handoff 산출물. Workstream B(Chunking/Retrieval)와 C(Artifact Loader/Experiment
Runner)가 여기서 시작한다.

**전제**
- 원본 DART corpus는 이 저장소에 없다 — B/C 모두 각자 로컬에 이미 보유하고 있다는 전제.
- 전체 DocumentIR(실측 약 8.61GB, `data/artifacts/document_ir/*.jsonl`)도 이 저장소에 없다
  (`.gitignore` 참고). 아래 명령으로 로컬에서 재생성하거나 별도 공유 저장소를 쓴다.
- B용/C용 파일을 따로 두 벌 만들지 않는다 — 이 저장소 하나가 공통 source of truth다.

## 저장소 구조(핵심만)

```
schemas/document_ir_schema_v0.json         DocumentIR JSON Schema(status: proposed)
docs/document_ir_contract.md               필드설명+ID규칙+저장형식+parser_version 등 통합 계약 문서
src/dart_corpus/                           Workstream A 소스(contract/, parsing/)
scripts/run_full_corpus.py                 전체 4204건 파싱 실행
scripts/generate_handoff_samples.py        대표 샘플 11건 생성
scripts/generate_parser_gold_candidates.py Parser Gold 후보(90건) 생성 — 후보일 뿐 정답 아님
scripts/compute_document_ir_hashes.py      DocumentIR canonical hash manifest 생성
scripts/build_a_handoff_manifest.py        handoff 색인(a_handoff_manifest.json) 생성
data/artifacts/corpus_snapshot.json        Corpus Snapshot(해시+게이트 리포트)
data/artifacts/parse_summary.json          tier/doc_group/warning 분포 집계
data/artifacts/parse_audit.jsonl           문서별 파싱 감사 기록
data/artifacts/parser_gold_candidates.jsonl / parser_gold_annotation_template.csv
data/artifacts/handoff/                    B/C 공통 handoff 색인 + 대표 샘플 + hash manifest
data/artifacts/document_ir/*.jsonl         전체 DocumentIR(.gitignore로 제외, 로컬 전용)
```

## 설치

```bash
pip install -e .
pip install -r requirements-lock.txt   # 정확한 버전(재현성) — pyproject.toml은 범위(>=)만 고정
```

## 테스트

```bash
pytest -m "not integration"   # 빠름(수 초) — 실제 corpus 없이도 돎(합성 fixture 위주)
pytest -m integration         # 느림(실제 corpus 필요, 전체 4204건 스캔 포함)
```

---

## Workstream B(Chunking/Retrieval) 사용법

전체 DocumentIR이 필요하다. 두 가지 방법:

1. **이미 생성된 artifact 사용**(로컬에 있으면): `data/artifacts/document_ir/{periodic,major,exchange,holding}.jsonl`
2. **동일 parser_version으로 로컬 재생성**:
   ```bash
   PYTHONIOENCODING=utf-8 python3 scripts/run_full_corpus.py --out-dir data/artifacts
   # 실측 36.3분(네트워크 마운트 기준 — 로컬 디스크면 더 빠를 수 있음)
   ```

사용할 재현성 키: `data/artifacts/handoff/a_handoff_manifest.json`의
`corpus_snapshot_id` / `parser_version` / `parser_config_hash`. doc_group별 문서 수는
`doc_group_counts` 필드 참고.

**재생성 후 검증**:
```bash
# 1) corpus_snapshot_id 비교(원본 corpus가 같으면 항상 같은 값이어야 함)
python -c "import json; print(json.load(open('data/artifacts/corpus_snapshot.json', encoding='utf-8'))['corpus_snapshot_id'])"

# 2) 전체 문서 수 4204 확인
python -c "import json; s=json.load(open('data/artifacts/parse_summary.json', encoding='utf-8')); print(s['total_documents'], s['n_success'], s['n_failed'])"

# 3) document_ir_hash_manifest 재계산 후 비교(8.61GB를 다시 읽어야 함 — 한 번만)
python3 scripts/compute_document_ir_hashes.py --out-dir data/artifacts
python -c "import json; a=json.load(open('data/artifacts/handoff/document_ir_hash_manifest.json', encoding='utf-8')); print(a['corpus_document_ir_hash'], a['group_hashes'])"
# 위 corpus_document_ir_hash/group_hashes가 git에 커밋된 값과 다르면 재현 실패 — parser_config_hash와
# dependency 버전(requirements-lock.txt)부터 비교할 것

# 4) 테스트
pytest -m "not integration"
```

---

## Workstream C(Artifact Loader/Experiment Runner) 사용법

우선 스키마 + 대표 샘플 11건만 있으면 개발을 시작할 수 있다. 전체 DocumentIR은
**통합 테스트 단계에서만** 연결한다.

- 스키마: `schemas/document_ir_schema_v0.json`
- 대표 샘플: `data/artifacts/handoff/representative_documents.jsonl`(11건 — dart3/dart4 ×
  periodic/major/holding, exchange HTML-in-.xml, pdf+viewer HTML, 첨부 포함, sanitizer 사용,
  fallback, TABLE-GROUP 내부 TITLE, rowspan/colspan, 다중 header 전부 커버)
- 필드 설명/ID 규칙/source_locator 규칙/warning 형식: `docs/document_ir_contract.md`

**schema validation**:
```bash
pip install jsonschema   # 또는 pip install -e .[dev]
python -c "
import json, jsonschema
schema = json.load(open('schemas/document_ir_schema_v0.json', encoding='utf-8'))
validator = jsonschema.Draft202012Validator(schema)
with open('data/artifacts/handoff/representative_documents.jsonl', encoding='utf-8') as f:
    for line in f:
        doc = json.loads(line)
        errors = list(validator.iter_errors(doc))
        print(doc['doc_id'], 'OK' if not errors else errors)
"
```

---

## 알려진 이슈 — periodic 문서 parse_quality 주의

**periodic 1054건 전체가 `structured`가 아니다**(partial 975 + fallback 79, structured 0).
원인을 오해하지 않도록 정확히 구분해서 봐야 한다(전수, `data/artifacts/parse_audit.jsonl`
실측):

| 원인 | 문서 수 | `text_preservation_ratio` 평균 | 실질 텍스트 손실? |
|---|---|---|---|
| sanitizer 사용(bare `&`/`<` 이스케이프)만으로 partial | 972 | **1.02** | **없음** — 파싱 성공, tier만 규칙상 강등 |
| pdf+html 강제 partial(PDF 자체는 안 읽음) | 3 | 0.30 | 있음(3건 중 2건은 `<table>` 0개라 완전 손실(ratio 0.0), 1건만 실질 파싱) |
| fallback(XML well-formed 실패, 태그 벗겨낸 raw text만 보존, 20000자 절단) | 79 | 0.14 | 있음(큼) |

즉 **partial 975건 중 972건은 사실상 structured와 다름없다**(정보 손실 없음, tier
판정 규칙이 sanitizer 사용 여부에만 민감하기 때문). 실제로 걱정해야 할 대상은
**fallback 79건 + pdf+html 3건 = 82건**뿐이다. fallback 79건과 pdf+html 중 완전
손실 2건(둘 다 `parse_failed` 경고 있음)은 **서로 다른 별개 문서 집합**이다 — 혼동
방지용 상세 목록은 `data/artifacts/handoff/parse_failure_cases.jsonl`. 상세: `docs/document_ir_contract.md`
§ periodic parse quality.

## QA 서버 (공시 질의응답)

코퍼스 Retrieval 위에 얹은 QA 백엔드. `src/dart_detective/`.

```bash
pip install -e ".[agent]"
PYTHONIOENCODING=utf-8 uvicorn dart_detective.qa_api:app --port 8000
# GET /health, POST /qa {"question": "..."}, GET /answer (팀 wire 계약)
python -m pytest tests/agents -q
```

- **2단계 검색**: Stage 1 BM25 + 기업·기간 하드필터(4,204 -> 50) 뒤
  Stage 2 음절 bigram BM25 재정렬(+섹션·행 라벨 가중).
- **슬롯 근거매칭**: 질문을 기업/연도/지표로 쪼개 표에서 연도열을 판독하고
  연결/별도 재무제표를 구분해 맞는 셀을 집는다.
- **결정론 계산기**: 증감률·기업 간 차이·직전/이번 변동은 LLM 없이 Decimal로 계산.
- **Evidence Validator**: 답변 속 숫자를 원문과 대조해 `SUPPORTED /
  PARTIALLY_SUPPORTED / UNSUPPORTED` 판정. 원문에 없는 숫자가 나오면 답변을
  폐기하고 발췌 답변으로 되돌린다. LLM은 HCX-005를 문항당 1회만 호출한다.
- **신뢰도 점수**: 규칙 기반 0~100 + 낮은 이유 노출.

## 문서 색인

| 문서 | 내용 |
|---|---|
| `docs/document_ir_contract.md` | 필드설명 / section_path / table_group_id·table_id·row_id / source_locator / warning 형식 / 저장형식 / parser_version / 재현성 / gap 전체 |
| `data/artifacts/handoff/a_handoff_manifest.json` | 이 handoff의 단일 색인(버전/해시/경로/재생성 명령/known_gaps) |
| `data/artifacts/handoff/document_ir_hash_manifest.json` | doc_group별 + 전체 corpus canonical hash(8.61GB 재다운로드 없이 재현성 검증용) |
