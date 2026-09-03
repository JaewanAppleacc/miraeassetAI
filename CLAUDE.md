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
- 색인 완료: `data/index/`(git 제외, `scripts/build_index.py`로 133초에 재생성). doc_index.jsonl 22.5MB · node_offsets.jsonl 0.5MB · index_manifest.json(DocumentIR 4파일 SHA). 실행은 `.venv/bin/python scripts/build_index.py`.
- **B arm 구성 완료**: torch 2.x + sentence-transformers(.venv, 약 1GB) · KURE-v1 rev `4ed4540…e4f`(HF 캐시 2.1GB) · `src/dart_detective/dense_rerank.py`(LOW 세그먼트에서 BM25 후보 50개를 cosine 재정렬, MPS fp16, max_seq 512, 점수 3자리 반올림·동률은 BM25 순). `bind("B")`가 자동 구성. 실측: 20청크 재정렬 8.1s(MPS), CPU 대비 순서 동일.
- **4-arm 실험 자산 완료**: 조건 사전 계산(`data/eval/devtune101_conditions.v1.jsonl`, SHA `6ff1b4fc…`, LOW 20/HIGH 81 → 의역 세트 불필요) · 러너 `scripts/fourarm/run_arm.py` · 채점기+판정 체인 `src/dart_corpus/evaluation/fourarm.py` + `scripts/fourarm/score.py`.
- **D arm 실측(전체 코퍼스)**: Recall@10 0.605 · @20 0.675 · LOW all_found@10 11/19 · 치명/경미/미해결 0 · p95 4.3s · RSS 1.24GB. **예전 "슬롯 97%"는 정답 문서 106건만 청킹한 풀의 수치였다** — `docs/interfaces.md` §5-8.
- **B arm 실측**: Recall@10 0.6084 · LOW all_found@10 12/19. **B·D 판정: D = PROVISIONAL_WINNER**(dense-off 우선, 동률). A/C 대기. 최종 pin: 코드 `c950a00` · conditions **v2** `83d5b8a0…`(별칭 채택 반영 재실행 — 지표 완전 동일). `results/fourarm/summary.md`.
- **실 HCX E2E 3회 완주**(101문항·서비스앱 키): 계약 위반 0 · 답변가능성 98/101 · UNSUPPORTED로 나간 답 0 고정. 3차(FC→재시도→JSON 2중 안전망): 간헐 40009 오류 17→0, 캐시 가능 65→**81**/101, p95 38.9s(예산 290s). 남은 LLM 실패는 JSON 추출 불가 2건뿐(결정론 답으로 회복). `results/e2e/summary.json`.
- 팀 계약 초안: `docs/interfaces.md` (킥오프에서 확정).
- **통합 E2E(LLM 없음) 실측 완료(2026-09-03)**: 서빙 경계(answer_ex) 그대로 101문항 — 계약 위반 0 · 답변가능성 98/101 · 검증 SUPPORTED 93·PARTIALLY 8·UNSUPPORTED 0(폴백 1건이 template로 회복) · 캐시 가능 100/101 · p95 4.2s. 전략 분포 DIRECT 49·NARRATIVE 40·CALC 7·EXISTENCE 5. `results/e2e/summary.json`, 러너 `scripts/run_e2e_devtune.py`(키 있으면 그대로 실 E2E).
  - 어긋난 3문항(전부 알테오젠·LGES 유보 계열): 예전 실측은 정답문서 106건 풀 기준이라 유보 판정 규칙이 다른 발췌를 봤다. HCX 켠 E2E에서 재확인 — `results/e2e/devtune101.jsonl`의 7b9dd4·40322d·e549bb.
- **구현 6건 완료(2026-09-03)**: ⑧ HCX Native FC(`grounded_answer.py` + `ClovaLLM.complete_tool` — claim 단위 생성·claim별 bound 게이트·코드 조립·인라인 출처, FC 지문 fc-2026-09-03.1, 기존 JSON 지문 불변) + ⑨ 3단 폴백(`fallback.py` — UNSUPPORTED일 때만 수리(OFF)→템플릿→발췌, 발동 시 캐시 제외). 실 HCX 미검증 — 키 확보 후 E2E에서 확인.
- **구현 4건 완료(2026-09-03)**: ⓪ 정책 게이트(`policy_gate.py` — 투자의견 거절·인젝션 무력화·컷오프 고지, 규칙 기반) + ② 서버 경계(`answer_api.py` — answer/answer_ex/readiness, 절대 예외 없음, deadline 시 LLM 생략, meta.cacheable로 캐시 제외). qa_service(팀원2)는 answer_ex만 부르면 됨 — `docs/interfaces.md` §2-1.
- **구현 2건 완료(2026-09-03)**: ④ node_store(DocumentIR byte-offset 지연 로딩, `src/dart_corpus/retrieval/node_store.py`, 검색 코어 기존 파일 무변경) + segments(vFINAL 1번 LOW/HIGH 단일 정의) + retriever_adapter(B/D 바인딩, `bind(arm)`). 실측: D arm bind 2.8s, 문항당 검색 0.9~3.1s, Gold 8/8 상위20 포함, Gold locator 345개 전부 색인에서 해석.
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

## 팀 병합 상태 (2026-09-03 저녁)
- 팀원2 산출물 병합 완료: ops_service(qa_service 실물, answer_ex 자동 연결)·deploy_probe·team_deploy.md·안전세트 v1(사람 판)·별칭 점검.
- 별칭 채택: `data/corpus/corp_aliases.v1.json` → 어댑터 `load_corp_dictionary`가 주입(검색 코어 무변경). 실측: LG엔솔→LG이노텍 오귀속이 LG에너지솔루션 정확 매칭으로 교정.
- conditions **v2 승격**(SHA `83d5b8a0…`): v1과 차이 1문항 candidate_terms뿐(corps·세그먼트 동일). **B/D는 v2로 재실행 필요**(pin 일치) — E2E 종료 후.
- 안전 세트: v1(팀원2, expected_behavior 서술) + v2(`safety_set.v2.jsonl`, 기계 검증판 20문항·러너 기본) — 20/20 통과.

## 작업 방식
- 수정은 한 번에 원자적으로. 배치를 나눠 오래 끌지 않는다.
- 피드백은 방어 없이 객관적으로 판정하고, 타당하면 즉시 반영한다.
- 설계 문서는 텍스트(txt/md)로 유지한다. HTML 재작성은 요청이 있을 때만.
