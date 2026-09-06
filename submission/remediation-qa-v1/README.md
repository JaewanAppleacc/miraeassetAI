# DART 공시 QA — A4-R4-A3-Remediation-QA 런타임

런타임 파일만 선별(allowlist)한 제출용 패키지다. git 히스토리, 평가 데이터, 다른 작업 트리,
자격증명은 포함하지 않는다.

## 모델 구조 (기본 백엔드: `ARM_A4_A3_REMEDIATION_LIVE`)

```
A4 광역 후보 풀  (BM25 top-100 + dense top-100, KURE-v1)
  -> R4_wide_rrf_centric 재정렬기
  -> A3 모순 가드 / 안정 보충
  -> Remediation 정책 (REMEDIATION_V1_POLICY: 근거 기반 승격을 동반한 opt-in 서브타입
     완화 패스, 접수일자별 검색 창 라운드로빈 병합, BM25 0점 후보 제거)
  -> QA (라우팅 / 근거 결박 답변 생성 / 검증 / 5필드 응답)
```

`ARM_A4_A3_LIVE`(remediation 이전 기준선)도 함께 포함되어 있다 — `answer_api.py`가 무조건
import하기 때문이며, 기본 백엔드는 아니다.

## 소스 SHA

```
model_source_sha=b5f9443f7ca3ec2d57c2d17453070ab23c4a6341
```

개발 저장소 브랜치 `codex/a4-a3-remediation-integration-v01`의 위 커밋에서 가져왔고, 패키징
시점에 두 개발 원격에서 동일함을 확인했다. 이후 제출용 주석 정리(주석 한국어화, 내부 작업
흔적 제거)만 적용했으며 동작 코드는 수정하지 않았다. 파일별 출처는
`MODEL_SOURCE_MANIFEST.md`, 이 패키지 내용물의 파일별 해시는 `SHA256SUMS`에 있다.

## 설치

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
npm install    # package-lock.json의 pg, ajv, ajv-formats
```

## 환경변수

이름만 나열한다. `.env.example` 참조 — 실제 값, API 키, 절대 경로는 포함하지 않는다.

## KURE / Postgres / 색인 요구사항

- **KURE-v1 고정판** (Postgres에 이미 적재된 임베딩과 일치해야 하며, 불일치 시 워커가 기동을
  거부한다): `repository=nlpai-lab/KURE-v1`,
  `revision=4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, `dimension=1024`.
- **PostgreSQL**: 이 코퍼스의 청크 임베딩을 담은 pgvector 인스턴스(개발 저장소의 테스트는
  PostgreSQL 16 대상).
- **DocumentIR** (미포함): 파싱된 코퍼스 jsonl 파일. 경로는 `DART_QA_DOCUMENT_IR_DIR`로
  지정한다 — 노드/행 원문 조회에 쓰이며 검색 순위에는 관여하지 않는다.
- **1단 색인** (미포함): `python scripts/build_index.py`로 생성한다(DocumentIR + 동봉된
  `data/corpus/manifest.jsonl`/`universe.csv` 필요). 산출 위치는 `DART_QA_INDEX_DIR`
  (기본 `data/index/`).
- **Postgres 벡터 색인 + BM25 캐시** (미포함, 이 패키지가 만들지 않음):
  `ARM_A4_A3_REMEDIATION_LIVE_RETRIEVAL_INDEX_ID` / `_CORPUS_SNAPSHOT_ID` /
  `_BM25_CACHE_DIR`를 이미 존재하는 위치로 지정한다.

## 실행

```bash
cp .env.example .env   # 실제 값 채우기
export $(grep -v '^#' .env | xargs)
PYTHONPATH=src python scripts/run_server.py
```

`:${PORT:-8000}`에서 서빙한다(`GET /health`, `GET /ready`,
`GET /answer?question_id=...&question=...`).
`python scripts/deploy_probe.py http://<host>:<port>`는 더 완전한 준비 상태 점검을,
`python scripts/qa_preflight.py`는 네트워크 호출 없이 환경/색인 경로 상태를 점검한다.

## 알려진 제약

- **백엔드 디스패치 등록.** 원본 커밋 시점에 `ARM_A4_A3_REMEDIATION_LIVE`는 구현이 끝났지만
  `answer_api.py`의 백엔드 디스패치 표에는 등록되지 않았다(백엔드를 추가한 변경의 범위 밖).
  그 파일들의 동작 코드를 패치하는 대신 `scripts/run_server.py`가 공개 빌더 함수로 검색기를
  만들어 기존 공개 훅 `answer_api.reset()`으로 주입한 뒤 서빙한다. 부작용:
  `readiness()["retrieval_backend"]`는 무관한 기본값 `"DEFAULT"`를 보고한다 — 정확한 필드는
  `readiness()["arm"]`(`"A4_A3_REMEDIATION"`)과
  `readiness()["pins"]["retrieval_backend"]`(`"ARM_A4_A3_REMEDIATION_LIVE"`)다.
- **코퍼스/색인 미포함** — 위 요구사항 참조.
- **대회 규정상 HCX만 사용** — `llm.py`에 미사용 로컬 개발용 Anthropic 경로가 있으며, LLM
  미구성 시 결정론(비 LLM) 답변으로 폴백한다.
- **폴백 순서**: 규칙 기반 수리 -> 고정 템플릿 -> 근거 원문 발췌. 저하된 결과는 캐시 제외로
  표시된다.
- **dense 재정렬 arm B 코드 미포함**(`dense_rerank.py` 제외 — 이 백엔드의 dense 점수는 Node
  워커의 Postgres/pgvector + KURE 경로에서 계산되므로 쓰지 않는다).
- **평가 데이터 미포함.** 이 모델을 기본값으로 선정한 비교 실행은 개발 저장소의 문서 전용
  커밋 `16289e2a`에 기록되어 있으며, 해시로만 참조하고 여기 포함하지 않는다.
