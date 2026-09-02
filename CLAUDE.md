# ai_festival — 공시 Agent 구현 폴더

미래에셋증권 AI Festival "공시 Agent (Disclosure Analyst)" 제출용 구현 폴더. 마감 **2026-09-06 23:59 KST**.
"최종 설계" 세션의 결정을 이 폴더에서 구현한다. 새 설계는 하지 않는다.

## 필독 순서
1. `docs/CONTEXT.md` — 대회 규격·제약·제출물, 최종 결정 요약, 코드 출처
2. `docs/specs/team-architecture-v4.txt` — 설계서 (SHA `cd5241fa…f14dc9`)
3. `docs/specs/4arm-vfinal-spec.txt` — 4-arm 실험 동결 스펙 (SHA `1a856dad…42da9f5`). byte 수정 금지
4. `docs/team-split.md` — 팀 분담안
5. `docs/interfaces.md` — 팀 코드 접점 4곳 계약 (초안)

## 현재 상태 (2026-09-03)
- 코드 가져옴: `share/dart-qa-handoff` HEAD `0c3123f` 위에 이 폴더를 git 저장소로 초기화(`origin` = jiyoung04lee/demo_ai_fesfival). `src/dart_corpus`(파싱·B/D 검색 코어) + `src/dart_detective`(에이전트 층).
- 가상환경 `.venv` (Python 3.12, requirements-lock.txt). 실행은 `.venv/bin/python`.
- DEV_TUNE 101 Gold: `data/eval/phase1_devtune_gold.v0.1.jsonl` (gold 브랜치 릴리스 v0.1 그대로, SHA `7941144c…f102b`). DEV_CHECK/HOLDOUT은 없음(접근 금지).
- 코퍼스 메타데이터 확보: `data/corpus/manifest.jsonl`(4,204행)·`universe.csv`(70기업). SHA가 `corpus_snapshot.json` 기록값과 일치 검증됨. `docs/CONTEXT.md` §0.
- 원본 XML(5.19GB)은 풀지 않았다. `work/corpus.zip`(432MB)에 압축된 채로 있고 git 제외 대상이다. DocumentIR이 있으므로 평시에는 필요 없다.
- 아직 없는 것: 문서 인덱스와 노드 위치표. 둘 다 DocumentIR + manifest로 재생성한다(`docs/interfaces.md` §5).
- 팀 계약 초안: `docs/interfaces.md` (킥오프에서 확정).
- **구현 1건 완료(2026-09-03)**: ③ 라우팅·LLM 예산 — `src/dart_detective/routing.py`(v4 §7 전략 7종 + 실행 매트릭스), `llm.py` 호출별 `max_tokens`, `qa_agent.py` 연결. 테스트 `tests/agents/test_routing.py` 27개. 프롬프트 동결 지문 불변. Codex 검수 대기: `docs/reviews/codex-review-routing-budget.md`.
- 구현 순서와 분담: `docs/team-split.md`.
- 입력 데이터: DocumentIR 4,204건 `/Users/ijiyeong/Desktop/document_ir/`(4 파일, 8GB). 그대로 사용, 재파싱 금지. `docs/CONTEXT.md` §0.

## 절대 원칙
- vFINAL 원문은 byte 수정 금지. 변경은 21번 절차로만. 요약과 충돌하면 원문 우선.
- 신·구 스펙 공존 금지. 폐기된 규칙(LOW 합산, Fixed 선확정, PG 불가 시 B 자동 전환 등)을 문서·코드 어디에도 남기지 않는다.
- 상태 라벨 혼용 금지(MEASURED / IMPLEMENTED / READY / PROPOSED / PENDING / NOT YET RUN / BLOCKED / LOCKED·SEALED). 실측 없이 완료 표시 금지.
- DEV_CHECK 47·HOLDOUT 59 접근 금지. 검색 실험은 DEV_TUNE 101만.
- 메타필터에 Gold 유래 정보 사용 금지(vFINAL 20번). 발견 시 실험 INVALID.
- 대회 규정: LLM은 HyperCLOVA X만. 코퍼스 외 데이터·외부 API 금지. 응답 5필드 전부 문자열.

## 저장공간 원칙 (디스크 절약 — 사용자 요청)
- 8GB DocumentIR을 **복사·변환해서 새 대용량 파일을 만들지 않는다**. byte-offset 색인으로 원본을 제자리에서 읽는다.
- 이 폴더가 새로 만드는 산출물 총량 목표: **200MB 이하**. 단일 파일 100MB 초과 시 먼저 이유를 설명한다.
- 임베딩·벡터 인덱스(.npy, pgvector dump)는 이 폴더에 두지 않는다. A/C 스택 담당자 환경에만 둔다.
- 중간 캐시·실험 산출물은 `work/`에 두고 `.gitignore`한다. 끝나면 지운다.
- 큰 파일을 만들기 전에 `df -h`로 여유를 확인한다.

## 작업 방식
- 수정은 한 번에 원자적으로. 배치를 나눠 오래 끌지 않는다.
- 피드백은 방어 없이 객관적으로 판정하고, 타당하면 즉시 반영한다.
- 설계 문서는 텍스트(txt/md)로 유지한다. HTML 재작성은 요청이 있을 때만.
