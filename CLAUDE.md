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

## 심사위원 모드 개선 이력 (2026-09-03 밤 · results/judge{,2,3}/)
- 1차(기준): 값 완전 32·부분 37·미포함 23 /92. 원인: 선택손실 28·검색손실 19·추출손실 13.
- 개선 1차(2e0a322 — MAX_EVIDENCE 8·전역 줄 선발): 슬롯 완비 33→37, 값은 불변 — 병목이 추출로 이동.
- 개선 2차(247b32c — FC 프롬프트 v2·claim 전멸 JSON 재시도·percent-of 계산기): **미포함 23→17, 부분 →41, 완전 →34, NUMERIC 15→18**.
- 검수 반영 라운드(2026-09-04, judge4·judge5 · 커밋 84d4b37~6961e97): 코덱스 전면 검수 14건 중 타당분 반영 —
  정책 게이트 우회 차단(매수추천+공시)·미래기간 OUT_OF_SCOPE·역질문·인젝션 스팬 제거·정정공시 고지 ·
  FC 기간-열 결합 게이트(당기/전기 매핑 포함)·확정값 보존·수치 답변 인용 요건(soft) ·
  서빙 arm 정직화(bind 경유·readiness 실값)·FC maxTokens 1024(512는 40001 하한 미달 — "동시 불가"는 오판)·
  pread·캐시 hit 5-string 검증·FC 지문 pin(캐시 자동 무효화)·판정기 require_arms·locator 문자열 파싱.
  실측: judge4에서 wanted [doc_id] 형식이 FC claim 악화(값 2개 합침→전멸)를 유발해 회귀(34→29) → 철회+
  claim 분리 규칙(fc-2026-09-04.1)로 judge5 **완전 32·부분 47·미포함 13**(j3 대비 미포함 17→13, 절단 0,
  churn 5↑/4↓ = 동등). 열 오귀속이 SUPPORTED로 통과하던 구멍이 닫혀 있으므로 완전 −2는 채점기(스왑을
  full로 셈)의 한계 안. 안전세트 24/24(매수추천 3·미래기간 1 추가).
- 검수 3차 반영(2026-09-04 · judge6): 재현 확인된 우회 전부 봉쇄 — 열 게이트 모호성 판단을
  "해석된 기간 열 수"로 교체(당기/전기·제N기 무연도 표 우회 차단) · 질문 숫자 허용을 날짜·기수형으로
  한정("매출액이 999인가?" echo 날조 차단) · ops_service 신규 응답 5-string 검증 · 단절 시
  세마포어 쥔 채 완주(취소 대신 — HCX 이중 호출 구조 제거) · 정책 우회 4문형(사는 게 맞아·매수해야·
  FY2027·회계연도) · score.py --final(A/B/C/D 완비·run.json input_sha256 대조·require_arms) ·
  pins에 llm/code_sha. judge6: 완전 33·부분 44·미포함 15(j5 대비 churn ±3 = 잡음, 게이트 조임에도
  지표 불변). 안전세트 28/28.
- 검수 4차 반영(2026-09-04 · judge7): 3차 보류분 포함 잔여 우회 전부 봉쇄 — 질문 날짜 숫자는
  claim/답변의 같은 문맥에서만 허용(날짜 토큰→값 전용 차단) · period 없는 다연도 값 claim은
  다기간 표에서 폐기(분리 강제) · ops 응답 정규화 try 포함(None/비dict도 200+유효 5필드) ·
  세마포어 획득 후 캐시 재확인(단절 재시도 중복 계산 제거) · **v4 §11 hard 준수: LLM 답 채택 시
  타문서 인용·수치 무인용 폐기(citation_unbound)** — 3차의 "H4 보류"는 스펙 위반이라 철회 ·
  --final pin 확대(universe·arm/파일명·config_sha·행 arm; doc_index는 스택 종속 제외) ·
  DART_QA_EVAL_PROFILE=1이면 HCX-005 **구성**+code_sha 없이는 ready=False(team_deploy.md 반영 —
  실연결 검증은 deploy_probe E2E가 담당, readiness는 구성 강제만).
  judge7: 완전 31·부분 49·**미포함 12**(4회 실행 밴드: 완전 31~34 진동, 미포함 17→12 단조 감소).
  잔여(공개 리스크): 데드라인 경로의 취소는 스레드를 못 멈춤(응답 의무상 유지 — 최대 계산 40s ≪
  예산 290s, 발생 실측 0회) · Anthropic 코드 경로는 존재하나 평가 프로필이 readiness에서 거부.
- 검수 5차 반영(2026-09-04 · judge8): 날짜·기수 허용을 **표현 전체 일치**로 교체("3월 22일"의
  22를 "계약기간은 22일"로 의미 전용하는 우회 차단) · 다연도+다숫자 claim은 value·표/문장 무관
  폐기(원문 그대로 재인용만 예외 — 순서가 원문에서 오므로 스왑 불가) · **LLM 답변은 인용 ≥1
  없으면 채택 안 함**(비수치 서술 포함, v4 §11) · --final에 results_sha256 파일 해시 대조·
  run.arm/행 arm 필수(이름 바꿔치기·사후 변조 검출 테스트 잠금).
  검수 주장 중 기각 2건(사유 기록): 행 수준 config/code SHA 요구는 §1-1 계약에 없음(파일 해시가
  실행 단위 무결성 담보) · readiness에 HCX 실호출 삽입은 폴링 경로에 지연·429 유발 — 실연결은
  deploy_probe E2E 담당. 자체 검수 발견 1건 추가 반영: 표현 일치를 문자열이 아니라 숫자 정규화
  동치로("2024-03-22" ↔ "2024년 3월 22일" 허용, "22일" 단독은 여전히 불허).
  judge8: **완전 33·부분 49·미포함 10**(최저) — 가중합(완전+부분/2) 54.5(j3)→57.5(j8)로 개선
  이력 중 최고. LLM_PATH_FAILED 42는 게이트 탈락분이 결정론 답으로 대체된 정직한 관측
  (안전성-완전성 교환이 값 지표를 깎지 않음을 실측).
- 검수 6차 반영(2026-09-04 · judge9): 표현 동치 키를 (종류, 자리) 구조화 튜플로("제3기"↔"3일"·
  "3월 22일"↔"22월 3일" 우회 차단, 표기 변형 동치는 유지) · 분리 규칙 기간 어휘를
  당기/전기(말)·제N기·분기/반기로 확장(당기/전기 스왑 차단, 당기순이익 오탐 방지) ·
  자체 대칭 구멍 봉쇄(단일 당기/전기 값 claim도 base_year 환산 열 대조) ·
  **정정: "행 SHA는 계약에 없음"은 내 오독**(§1-1 명시) — run_arm이 행마다 config/code SHA 기록,
  --final은 config.arm/label 대조·config_sha256 재계산·행 SHA 결박(완전 위조 시나리오 테스트 잠금).
  **B/D 새 러너로 재실행: 101문항 순위 차이 0건**(지표 완전 동일, D = PROVISIONAL_WINNER 유지).
  judge9: 완전 34·부분 47·미포함 11(가중 57.5 = 최고 동률) — 최강 게이트에서 기준선 완전 회복.
  ※ A/C 안내: 결과 행마다 arm·config_sha256·code_sha256 필수(§1-1) — --final이 강제한다.
- 검수 7차 반영(2026-09-04 · judge10→11): ① FC 실패 시 JSON 폴백이 claim 게이트를 통째로
  우회하던 구조 구멍 — check_generated_answer(채택 답변 문장 단위 기간-값 결박)로 차단(judge11
  실측 발동 7건) ② 기간 어휘 확장(전년 동기·직전/이번 보고서·영문 Q/H) + 연도 환산 불가
  머리글의 토큰→열 결박(tables.period_token_columns) ③ --final config 의미 대조(strategy·
  dense — config 전체 위조도 실제 설정 의미가 남아 검출) ④ 데드라인 janitor(취소 대신
  세마포어 유지 — 재현 조건 동시 실행 2→1 실측). judge10에서 어휘 확장의 일괄 폐기가
  대량보유(직전/이번) 계열 정답 claim까지 버려 중간 회귀(가중 54.0) → **(기간,값) 순서 쌍
  검증**(_verify_period_pairs: 전 쌍 열 대조 통과=허용·어긋남=스왑 폐기·불가=폐기)으로 교정.
  **judge11: 완전 35·부분 47·미포함 10·가중 58.5 — 3지표 역대 최고.** meta에
  llm_degraded_reason 추가(발동 분포: period_unbound 7·citation_unbound 15·unsupported 20).
- 검수 8차 반영(2026-09-04 · judge12): ① 문장 게이트를 **숫자별 인용 결박**으로 — 숫자 없는
  인용만 대기·정답 숫자 섞기("90 또는 100") 우회 차단 ② 기간 토큰 정규화 체계(직전 사업연도↔
  전기·Q1↔1분기·1H↔상반기, 머리글·claim 통일) + 다기간 표에서 토큰 미결박은 fail-closed
  ③ --final 외부 allowlist `results/fourarm/arm_registry.json`(git 추적; config/code/results
  SHA) — 디렉터리 안 자기일관 위조 차단, B/D 등록·A/C는 팀원1 run.json 도착 시 등록
  ④ 세마포어 대기를 남은 예산으로 제한·획득 후 잔여 0이면 계산 없이 폴백, janitor 회귀 테스트
  ⑤ 루프별 세마포어(테스트 순서 의존 제거). judge12: 완전 35·부분 44·미포함 13·가중 57.0
  (밴드 54~58.5 안, 3↑/4↓ 잡음). 발동: period_unbound 16·citation_unbound 14·unsupported 16.
- 코덱스 수정 커밋 검수(2026-09-04 · 9836a22→b9f16d0 · judge13): 역할 교대 — 코덱스가 고치고 내가 검수.
  수용 5건(무관 행 인용 차단·'90'⊂'190' 부분문자열 오류·지표-행 바꿔치기·데드라인 경계·--final ID 검사).
  재현으로 잡은 오탐 2건 교정: ① 다기간 표 규칙이 **문서의 다른 청크** 표까지 근거로 삼아 정기보고서
  문단 인용·주요사항보고서 단일값 행 인용을 폐기 → 인용이 든 청크로 한정 ② 문장 게이트가 날짜·기수
  숫자(3월 22일의 3·22)를 값으로 취급(8차 자체 버그, judge12 period_unbound 16 중 일부) → 문맥 표현
  숫자 제외. 토큰 완전일치는 수치 동치('5'=='5.00')로 완화. judge13: 완전 34·부분 47·미포함 11·
  가중 57.5(밴드 내, 3↑/2↓) · period_unbound 16→9(오폭 감소 실측) · 안전세트 28/28 · 테스트 514.
- 코덱스 검수(52cfa26) 3건 반영·최종 검증(2026-09-04 · 616ddb5 · judge14/15): ① 날짜·기수 숫자 면제를
  값 집합 → **표현 span 위치**로(strip_context_expressions) — "3월 22일 계약금액은 22원"의 날조 22원·
  "제100기 계약금액은 100원"의 100원이 claim·문장·최종 validator 셋 다에서 잡힘. 최종 validator는 전역
  허용 대신 질문 일치 표현만 자리에서 마스킹한 사본 검증 ② 인용을 담은 전 청크 스캔(청크 순서 의존 제거)
  ③ 수치 동치(validator.num_key, Decimal)를 claim·최종 validator까지 공유('5'=='5.00', '90'≠'190').
  **검증**: 코덱스 재현 3건 차단 + 자체 공격 프로브(값이 날짜 앞·붙여쓰기·기수 뒤 같은 값) 차단 + 정당
  케이스 허용 · 구/신 validator를 실답변 192건(judge13+14)에 되돌려 판정 변화 1건뿐(gold_b_606 — 구
  토큰화 오판 "03"≠"3"의 해소, 정당) · judge14 가중 55.0은 judge15 57.5(=judge13, churn 1↑/1↓)로 잡음
  판정 — 악화 5건은 전부 대량보유 계열 경로 혼합(결정론 발췌 full ↔ LLM 간결답 partial). 안전세트 28/28 ·
  테스트 517. judge summary에 llm_degraded_reason 분포 기록.
- **A/C 검수 반영 — 공통 scorer vFINAL 14·16 정합(2026-09-04)**: row/col 명시 상이를 경미→**치명**으로
  교정(원문 "다른 행/열 지시"=치명 — 종전은 오독) · text-method 매치(동일 근거 span, node/offset 상이)를
  경미로 **보고**(종전 무기록) · 16번 Owner 판정 입력 구현(score.py --resolutions:
  COMMON_SOURCE 공통 제외 한도 min(5,5%)·초과 BLOCKED·제외 전 리포트 보존·LOW<10 UNDERPOWERED,
  ARM_SPECIFIC slot 실패 재계산+치명 확정 반영, UNKNOWN·무판정은 자동 분류 없이 보류).
  B/D 재채점 실측: 치명 0 유지·지표/판정 완전 동일(D PROVISIONAL_WINNER)·결과 4파일 byte-identical·
  신규 경미 B 17/D 13(보고용). 회귀 테스트 12케이스(test_fourarm_vfinal14_16.py). 검색 재실행 없음.
- **A/C 검수 2차 반영 — slot-found span 결박(2026-09-04) · ⚠ 잠정 승자 D→B 반전**: (doc,node) 일치만으로
  slot 인정하던 과대 계상 제거 — node 일치여도 Gold span이 청크 본문에 있어야 verified, node 원문에는
  있는데 청크에 없으면 '옳은 node의 다른 창'=매치 아님, 둘 다 확인 불가(렌더링 차이)는 unverified 매치
  +UNRESOLVED 패킷(16번 Owner행). 같은 node 다중 source 전체 대조(결과 rc 일치 우선). 기간 오귀속은
  span+행열 결박이 커버(테스트 잠금). **기각 1건**: text-method(검증된 동일 근거 중복)를 일괄 치명 —
  경미 조항("동일 근거·범위 상이") 사문화 + 실측 B17·D13건 전부 치명 = 전 arm Hard 탈락이라 부적절,
  테스트에 의견 불일치 기록(Owner 재판정 대상). **재채점: B R@10 0.5944·LOW 11/19, D 0.5909·9/19 —
  LOW 차이 2 > 동률 한계 1 → B 선두(D에서 반전)**. B/D 결과 4파일 byte-identical 유지,
  검색 재실행 없음. 서빙은 A/C 합류 최종 판정까지 D 유지(B 전환 시 서버에 KURE 스택 필요 — 별도 decision).
- **A/C 검수 3차 반영 — different-node 규칙·부분 집합 상태명(2026-09-04)**: 2차의 "text-method=경미" 자동
  판정 철회 — "탈락하니까 완화"는 사전등록 실험에서 부적절한 논거였음(인정). 스펙 해석이 갈리는 다른-node
  동일 텍스트는 scorer가 결정하지 않고 **UNRESOLVED(duplicate_evidence_different_node) → Owner arm-blind
  판정**(14번 "판정 불가" 조항). Gold span 연도가 청크에 없고 청크가 다른 연도면 치명 확정. Owner 판정
  클래스에 EQUIVALENT_EVIDENCE 추가(동등 근거 확정 → 매치 유지·경미 강등; Gold 동결이라 source 추가 불가).
  동일 node·동일 셀의 정규화-only 일치는 경미 보고. **부분 집합 판정은 PARTIAL_SET_LEADER('leader', winner
  키 없음)** — PROVISIONAL_WINNER/OPERATIONAL_FALLBACK은 A/B/C/D 완비 시에만(vFINAL 17).
  재채점: B unresolved 17·D 13(전부 duplicate-node), arm-blind 패킷 17건, 판정 **PENDING_UNRESOLVED(후보 B)**.
  → Owner(팀 대표)가 results/fourarm/unresolved/resolutions.template.json을 채워 `score.py --resolutions`로
  재실행해야 B/D 진단이 닫힌다(COMMON_SOURCE 한도 5). 테스트 545 통과.
- **EQUIVALENT_EVIDENCE 철회·Owner 판정 공식 적용(2026-09-04) — B/D 진단 BLOCKED**: 3차 때 도입한
  '동등 근거 사면' 분류는 §16에 없는 발명(§21 절차 없는 사후 완화)이라 코덱스·A/C 검수 합치로 **철회**
  (허용 분류는 COMMON_SOURCE/ARM_SPECIFIC/UNKNOWN 원상복구, 거부 테스트 잠금). Owner(팀 대표)가 패킷
  17건 전수 판정: ARM_SPECIFIC+치명 2건(연결 질문에 별도 재무 청크 — 공통 머리글 줄에 span 매칭이 걸린
  scorer 과대 인정을 UNRESOLVED 장치가 포착) · 동등 근거 소견 15건은 분류 불가로 UNKNOWN 유지(보류).
  공식 재채점: B/D 치명 2씩 → **BLOCKED(no hard-safe arm)**. B/D 결과 4파일 불변. 함의: 4-arm 최종에서
  B/D는 Hard 탈락 상태 — A/C가 hard-safe면 그쪽에서 승자 선출 가능(실험 자체는 살아 있음). 열린 결정
  2건은 Owner 몫: ① 치명 2건을 §16 B의 'slot 실패' 옵션으로 재판정할지(§14 false-positive 조항 근거)
  ② UNKNOWN 15건의 종결 방법(§21로 사면 분류 신설 — A/C 결과 도착 전에만 정당화 여지).
  → **Owner 확정(2026-09-05)**: ① 치명 유지(연결 질문에 별도 재무 + 값 상이 = §14 claim 미지지 —
  비치명 강등은 결과 후 완화) ② UNKNOWN 15건 보류 유지(§21 신설 안 함 — B/D 결과를 이미 본 시점이라
  사전등록 변경으로 볼 수 없음). **B/D 진단 BLOCKED 최종. 재론 없음.** 4-arm 최종은 A/C hard-safe 여부로 진행.
- **표시층 정리 — 유보 전용 템플릿·발췌 정돈(2026-09-05 · judge16)**: 코덱스 조건부 승인 7조건 반영.
  ① WITHHELD는 withheld_answer 전용 템플릿(유보사항·사유·기한 + 유보 안 된 확정 값 보존, 원문 발췌
  전체 덤프 제거 — 원문은 retrieved_context가 byte 그대로) ② 발췌는 [슬롯] 태그 제거·공백 정규화 후
  **완전 동일** 줄만 중복 제거(유사 행 병합 금지)·표 '|' 원문 유지+칸 구분 안내문 ③ LLM 재호출 없음.
  회귀 테스트 7종(retrieved_context 무변경 포함). 실측: judge16 완전 35·부분 46·미포함 11·가중 58.0
  (j15 57.5 대비 밴드 내 +0.5, 악화 4건은 FC claim 수 변동으로 판별 — 표시층 무관) · NARRATIVE_THIN
  14→10 · 안전세트 28/28 · 테스트 552. 알테오젠 유보 답변 수천 자 → 5줄. **재배포 시
  DART_QA_CODE_SHA env 갱신 필수**(유보 답변이 캐시 대상이라 pins의 code_sha 변경으로 무효화).
- **대량보유 서식 파서 + 부분 답변(2026-09-05 · judge17 · 브랜치 feat/holding-parser)**:
  `docs/plans/2026-09-05-holding-parser.md` §3 구현, 커밋 3분할(파서→배선→통합 테스트).
  배경: 대량보유 33/101문항 전부에서 기존 쌍 계산기 발동 0(라벨 완전일치가 실서식 2종과 불일치).
  연혁표(2행 머리글 병합·라벨 '직전보고서')·요약표(라벨 둘째 칸) 판독 — 열은 머리글 **이름**으로
  확정(주권·의결권 그룹 배제, 고정 인덱스 금지), 문서는 질문 기준일('기준일'/'이번보고서' 앵커)·
  보고자(정규화 포함 비교)로 결박, 유일하지 않으면 미발동(fail-closed). 추출 행은 EvidenceMatch
  승격(retrieved_context·citations·프롬프트 공유), node 유래 행은 검증 sources에도 추가. 증감은
  쌍 완비+변동어일 때만 Derived(holding_change, 주/%p) — 다른 보고자 행으로 빈자리를 채우지
  않고 missing_slots를 "확인하지 못했다"로 명시. 폴백 덤프는 **소비한 행만** 숨김(exclude_texts —
  보유목적 등 다른 slot 근거 보존). describe는 increase_rate/pair_change 포함 "…에서 …로 N
  증가/감소(signed 병기)" 형식으로 통일. **실측(judge17): 완전 40·부분 43·미포함 9·가중 61.5 —
  3지표 모두 역대 최고**(종전 최고 58.5). paired diff: 대량보유 개선 6·악화 0, 비대량보유 churn 0,
  답변가능성 98/101, RETRIEVAL_MISS 63→52(승격 행이 근거 완전성도 개선), LLM_PATH_FAILED 55→41,
  period_unbound 10→3, 계산 발동 0→11/33. 안전세트 28/28 · 테스트 580. 판 §6(선별 발췌·presentation
  모듈화·프롬프트 문체 등)은 미구현 — 실측 후 재논의. 보유목적 줄이 기본 선발 예산(문서당 4줄)에서
  표 행에 밀리는 것은 파서 이전부터의 선발 동작(§6 범위 밖, 테스트 주석에 기록). **main 병합·push
  대기 — 재배포 시 DART_QA_CODE_SHA 갱신 필수**(pins 변경으로 캐시 자동 무효화).
- **최종 검수 4건 반영(2026-09-05 · judge18 · a3c824c)**: 코덱스 최종 검수(머지 보류 판정)의
  CRITICAL 2·HIGH 4 전부 수정 — ① 고려아연 확정 버그: 요약표를 기본 그룹 제목("보유주식등의 수 및
  보유비율")으로 결박, 주요계약체결·의결권 그룹과의 충돌 폐기 제거(실물 node 0·1 회귀:
  26,805주·0.13%p·표지 보고자 최윤범 추출·승격) ② 삼성전기 혼합 차단: LLM 발췌를 파서 확정 문서로
  제한 + 대상 외 holding 문서 인용 시 통째 폐기(holding_doc_unbound — judge18 실측 발동 0: 상류
  발췌 제한이 선차단) ③ 잔여 슬롯: derived 존재만으로 LLM을 끄지 않음 — 보유목적·보고사유·미확보
  보고자 요구 시 대상 문서 발췌로 보완, 채택 후에도 계산 문장 유지 ④ 표시 정리: 질문한 항목·기간만
  값 출력(_requested_topics)·파서 성공 시 answer 덤프 대상 문서 제한·retrieved_context 동일 행
  중복 제거+사용 근거 우선·신청/승인 이분 질문은 서식 필드(신청일·허가일) 결정론 판정.
  **judge18: 완전 43·부분 40·미포함 9·가중 63.0(역대 최고 경신, j16 58.0→+5.0)** — 대량보유
  개선 9·악화 0(j16 대비), 계산 발동 19/33, 비대량보유 악화 1(FC 실행 간 변동 계열, 밴드 내) ·
  실물 대조 5문항(삼성전기 혼합 소멸·고려아연 full·MFS/메리츠 타 보고자 행 소멸·알테오젠 직접
  판정) 전부 검수 기대와 일치 · 답변가능성 98/101 · 안전세트 28/28 · 테스트 594.
- **재검수(재배포 불가 판정) BLOCKER 3·HIGH 2 반영(2026-09-05 · judge19→20 · a74137f·d2d6c83)**:
  ① [B1] 파서가 문서를 확정하면 evidence_matches·검증 sources·FC claim sources 전부 그 문서로
  제한 — "다른 보고서 숫자 + 대상 문서 무해 인용 → SUPPORTED" 구멍 봉쇄(재현 테스트 잠금)
  ② [B2] 신규 보고 오귀속 차단(삼성전기 실물): 요약표 명시적 '-'는 해당 없음(연혁값 보충 금지),
  보고구분=신규면 직전 억제+안내 노트, 보고구분·보유목적·보고사유 서식 필드 결정론 추출, 표지
  전체 보고자명(대리인 표기 포함) 우선 ③ [B3] 신청/승인 이분 판정을 질문 날짜↔신청일/허가일 필드
  대조로("2023-02-07 공시는?"→신청 정답) ④ [H4] retrieved_context가 대상 문서만 담음(v4 "실제
  사용 근거만") ⑤ [H5] context 중복 키에 locator 포함(동일 문장·다른 node 보존).
  judge19에서 고려아연·시프트업 보유목적이 FC 변동으로 왕복 → 원인 실측: 두 문서에 '보유목적'
  텍스트가 없고 **일반서식 구분 문구가 유일한 근거** → 서식 의미를 결정론 규칙으로 이관(일반서식
  =경영권 영향, 명시 필드 우선, 약식 '아닌 경우'는 추론 금지). 효성중공업 j18의 partial은 타
  문서 보유목적(단순투자, gold는 경영권 영향)을 섞은 오답이었음이 확인 — 차단 후 j20에서 혼합
  없는 partial로 회복. **judge20: 완전 46·부분 37·미포함 9·가중 64.5(최고 경신)** — j18 대비
  개선 3·악화 0, j16 대비 대량보유 개선 11·악화 0 · 답변가능성 98/101 · 안전세트 28/28 ·
  테스트 604. 고려아연·시프트업·삼성전기 계열은 LLM 없이 결정론 full.
- **3차 재검수(BLOCKER 1·HIGH 2·WARN 1) + 자체 검증 보강(2026-09-05 · judge21~23 · 1c55195…b519e5e)**:
  [B1] 파서가 요구 항목을 전부 채웠으면 derived 없어도 LLM 미호출(holding_all_slots_filled) · 남은
  항목으로 LLM을 불러도 직전/이번·수량·비율 문맥의 숫자가 확정값·계산값·출처·질문 표현 밖이면
  hard reject(holding_value_conflict) · 부분 답변·신규 노트 채택 후 보존 [H2/H3] 인식한 연혁 행
  전부 consumed·retrieved_context는 실사용 근거만(값 slot·본문 행·LLM 인용·이분 근거) [WARN] 서술
  항목만 묻는 질문에 수량·비율 미출력. **자체 프로브 11종(실 코퍼스+가짜 LLM)으로 찾아 메운 것**:
  ① 숫자 없는 이름 주장("보고자는 영풍이다") 통과 → 서술 필드(보고자·보유목적·보고구분·보고사유)
  충돌 hard reject(holding_text_conflict) ② 알테오젠: 타 공시 유보 문구('개발대상품목') 오발동을
  폴백이 구제하던 경로 → 이분 판정 확정 시 유보 탐지 건너뜀+LLM 미호출(binary_verdict), SUPPORTED·
  캐시 가능 ③ gold 문형 날짜는 접수일(작성기준일은 하루 전)이라 결박이 비어 있었음 → 접수일 결박
  (기준일 명시 시 제외) — 효성중공업 파서 발동, gold 값 완전 일치 ④ 같은 날짜 보고서 2건이라
  파서 fail-closed해도 기준일/접수일 후보 집합으로 근거·발췌·검증·인용 결박(고려아연 12-19에서
  2024-03-15 보고서 인용 채택되던 경로 차단 — judge23 holding_doc_unbound 2회 실발동).
  **judge23: 완전 46·부분 37·미포함 9·가중 64.5·답변가능성 99/101**(j16 58.0/98) · j22 대비 개선
  3·악화 1(두산에너빌리티 FC 변동 계열) · 대량보유 계산 발동 23/33 · 안전세트 28/28 · 테스트 618.
  잔여(정직): 파서가 보고자를 못 찾은 문서에서 LLM의 이름 답은 대조 기준이 없어 검증 불가 ·
  미확정 수치 항목(특별관계자 수 등)이 직전/이번 문맥에 섞이면 fail-closed로 버려짐(안전 우선).
- **전수 테스트 인사이트 라운드(2026-09-05 · judge24→26 · e086b1b…c658c35)**: 101(j23)+gold25(실 HCX)
  미달 문항을 slot 단위로 분해 — 검색 자체 실패(54) < **검색됐지만 근거 선발 탈락(75)** < 스팬 청크 밖(29).
  ① 단일판매·공급계약 14문항(ctx 0/5): gold 문서가 Stage 1 **1위**인데 Stage 2에서 전멸 — ISO 날짜 분기에서
  접수일이 하루 뒤라 날짜 가산이 빗나가고 항목 가산이 미적용 → 접수일 ±1일·날짜 분기에도 항목 가산·접수일
  일치 1위 문서 청크 3개 보장(`corpus_retriever.retrieve`; 쿼터를 항상 적용하면 날짜 없는 질문에서 정정
  사업보고서가 정답 행을 밀어내는 회귀 3건 — 접수일 일치 시로 한정해 복구). 오프라인 미검색 54→19 slot.
  ② 분기/반기/누적 비교 7/9 미달: 연도만 맞으면 열 채택(2025 반기보고서 전전기=2023 연간 열)·1분기 질문에
  3분기보고서·원↔백만원 혼합(LIG넥스원 5,573만%)·"3개월|누적" 부머리글·요약표 4열 → 슬롯 연도=문서 기준연도
  +기준월 결박, 누적 열, 요약재무정보 우선(SUMMARY_TABLE_BONUS 2.0), 표 머리 단위 전달, 단위 미상 500배 괴리
  계산 중단, 기간 단어 없는 연도 질문은 사업보고서 우선(ANNUAL_BONUS) — LIG·현대제철·삼성전자 3Q·HMM·현대모비스
  gold 자릿수 일치. ③ 대량보유: 발행회사명·관계·작성기준일(사용 기간만)·보유목적 표현 병기·'X이 제출한' 보고자.
  **judge26: 완전 52·부분 35·미포함 5·가중 69.5·답변가능성 99·근거 완전성 45→63**(j23 64.5 대비 +5.0,
  j23 대비 paired 개선 8·악화 0) · gold25 핵심값 완전 4→5·미포함 5→4·회귀 0 · 테스트 631 · 안전세트 28/28.
  잔여·방향: 서술형 19문항(주요사항보고서 서식 필드 결정론화) · gold25 다중 문서 시계열 8문항(정정 chain
  검색+다문서 조립) · 같은 날 같은 보고자 2건(접수번호/일반·약식 2차 결박) · 근거 선발 예산 · 3분기 4열 요약표 ·
  단일판매 군집은 문서가 검색돼도 FC 채택/폐기가 실행마다 흔들림(j24 full↔j26 partial 2건) → 항목 slot 값이
  전부 확정되면 대량보유처럼 LLM을 건너뛰는 결정론 조립이 다음 레버.
- **B/D 4-arm 동결 인계 패키지(2026-09-05 · 브랜치 codex/fourarm-bd-final-handoff-v01 · 1a7c41f, base 56f776f)**:
  Turn BD-FINAL-HANDOFF-FOR-4ARM-INTEGRATION. A/C 완료 연락(브랜치 codex/fourarm-ac-vector-import-v01 · 44f0523 ·
  A/C readiness GREEN · 별개 히스토리, 무접촉)에 맞춰 B/D를 **재실행 없이** `handoff/fourarm_bd_final_v01/`(+결정론 zip,
  SHA f7c4c456…)로 고정. 내용: conditions v2·universe 원본, scorer 사본(50cc1aa git blob과 byte-identical —
  evaluation/·retrieval/ __init__은 의도적으로 제외해 namespace import), interfaces.md 계약, B/D result/run 4개
  (registry·run.json·디스크·패키지 SHA 전부 동일: B de661a1c… / D 0f111221…), 채점 리포트 8개, Owner 패킷 17 +
  resolutions.json, MANIFEST.json·SHA256SUMS·불변 증명·테스트 요약. 검증: bd_results+resolutions만으로 채점기 재실행 →
  results/fourarm 전 파일 byte-identical · scoped 72 passed · full 738 passed/0 failed(26 env error) · SHA256SUMS 55/55.
  판정 BLOCKED(ARM_SPECIFIC critical 2 · UNKNOWN 15 Owner 보류) 그대로. raw Gold/DEV_CHECK/HOLDOUT 비포함(pointer만).
  `ac_scorer_50cc1aa.zip` 실물은 이 호스트에 없어 commit에서 직접 추출. PR 없음. main에는 미병합(파일 추가만이라 충돌 없음).
- **재배포 검수 반영 라운드(2026-09-05 · judge27→28 · 3d3e2d4…2a456da)**: 코덱스 "재배포 불가" 판정
  (BLOCKER 2·HIGH 1·MEDIUM 1) + 성능 우선순위 전부 반영. [B2] corpus_retriever를 judge23(5f18ef8)으로
  복원 — 4-arm B/D가 공유하는 retrieve()는 승자 확정 전 불변(검색 개선은 perf/retrieval-stage2 bf00bb1에
  보존, 그 브랜치에서 HIGH 3 정확일자 우선·MEDIUM 4 승격 재정렬 점수까지 수정). [B1] 유보 문장 표 셀
  탐지(알테오젠 ALT-B4 병합 셀 실물 — WITHHELD가 SUPPORTED로 나가던 버그, 제목 셀 오발동 차단 테스트 포함).
  [P0] plan_slots 항목 우선(단일판매 14문항이 '매출액_연도' 하나로 변질되던 버그·'계약기간'→시작일/종료일
  확장·주요사항보고서 서식 어휘는 **에이전트 층 사전**으로만 — DISCLOSURE_ITEMS 불변) · 결정론 조립
  (items_all_slots_filled, LLM 생략) · 날짜+항목 질문의 대상 문서 원문 node 보충(검색 코어 무변경, 대량보유
  파서와 같은 방식) · 자유 자리 날짜 앵커(±1일, 문서 2건까지). **judge27 실측이 조립 오귀속 7건을 노출**
  (한글 날짜 미해석 → 같은 회사 다른 회차 확정: 현대차·SKT·아모레·메리츠, 요구 누락: 효성·삼성E&A·한미) →
  한글 날짜 파싱(question_dates_any)·항목 자리 질문 날짜(±1일) 결박·첫 자리 문서로 전 자리 일관 결박·같은 날
  서식 2건은 질문 고유 토큰(바이그램 ≥2, 전체 원문 대조)이 유일할 때만 해소(아니면 조립 금지)·항목이 못 덮는
  요구(_residual_asks) 남으면 LLM 유지로 전부 교정. **judge28: 완전 56·부분 31·미포함 5·가중 71.5·
  답변가능성 100/101·근거 완전성 73 — 전 지표 역대 최고**(j23 64.5 대비 paired 대량보유 개선 4·악화 1[같은 날
  2건 fail-closed의 정직한 결과 — j23 partial은 두 보고서 값이 섞인 덤프의 우연], 비대량보유 개선 7·악화 0;
  j26 69.5 대비 검색 개선 없이 +2.0) · gold25 r2: 핵심값 full 5·partial 17·zero 3(기존 4)·기대 문서 완전
  포함 10/25(기존 9) · 테스트 832·안전세트 28/28. 잔여: 삼성바이오 정정 체인 1건(원본은 상대방 유보,
  정정본이 창 밖 — 새 오분류지만 총 답변가능성은 순개선) · 같은 날 같은 보고자 대량보유 2건(고려아연 12-19) ·
  한미반도체·삼성E&A 같은 날 2건은 질문만으로 구분 불가(fail-closed 유지).
- **팀원 검수 브랜치 반영(2026-09-05 · review/qa-649d1cd-daeun → 6e3bea4 · judge29)**: 649d1cd(judge15
  시대) 기반 팀원 개선 4건 중 타당분 3건만 현재 코드에 이식 — ① 클린 클론 이식성(실측 산출물 의존
  test_score_final_cli skipif — 실측 파일 없는 worktree에서 4건 실패 관측·DocumentIR 경로 후보 체인)
  ② 요구 슬롯 미충족 시 1회 확장 재검색 k=40(현재 배선(bind_days·prefer_doc·원문 보충)에 맞춰 개작,
  채움이 늘 때만 채택·k 고정 시 금지, 경계 테스트 4종) ③ FC 지문 fc-2026-09-05.1(숫자 없는 요구 항목도
  claim으로 — 재배포 시 지문 pin 변경으로 캐시 자동 무효화). [기각] 라우팅 계산어 우선(a17b740) —
  v4 §7 전략 순서 예외를 만드는 스펙 사안 + 근거가 judge15 분석뿐 + 현 코드는 계산을 라우팅과 무관하게
  수행(재론 시 실측 먼저). **judge29: 완전 56·부분 31·미포함 5·가중 71.5·답변가능성 100 — judge28과
  동일(paired 1↑/1↓ 잡음, PASS)** · unsupported 외 게이트 발동 감소(citation_unbound 9→4·
  LLM_PATH_FAILED 20→17) · gold25 r3: full 5·partial 16·zero 4(r2 대비 Q06 1건 — FC 간헐 실패→JSON
  폴백의 실행 변동, 코드 무관) · 테스트 836·안전세트 28/28. 4-arm 최종: 팀원1 통보 — B/D
  HARD_GATE_FAILED(우리 동결 인계의 BLOCKED 판정과 일치), B/D 검색·scorer 작업 종료, 승자는 A/C에서.
  검색 코어 동결 사유는 최종 판정 종결 시 소멸 — perf/retrieval-stage2(bf00bb1) 적용은 Owner 결정 대기.
- **vFINAL 21번 변경 승인(2026-09-04, Owner=팀 대표)**: "FC Native Function Calling 경로에 한해
  전송 maxTokens 최소 1024 적용을 승인한다. 사유는 서비스 앱 API가 1024 미만 요청을 40001로
  거부하기 때문이다. JSON 경로의 v4 §7 예산은 변경하지 않으며 requested/sent 값을 구분해
  기록한다." — 구현: llm.py complete_tool(sent=max(1024, 예산)), usage.max_tokens_requested/sent.
- 남은 큰 덩어리: 검색손실(~19, 4-arm 승자 확정 후) · EVENT_TRACE(원장 필요, 조건부 — DEV_TUNE 강등 실측 0건이라 ledger는 DEV_TUNE 지표에 +0, 기각) · COMPARISON 열 선택(5/12) · 서술형 자동채점 한계.
- **서버 재배포 필요**(3차 반영 커밋까지): pins에 FC 지문·llm·code_sha가 들어가 재배포 시 캐시 자동 무효화 — 수동 삭제 불필요. 배포 시 `DART_QA_CODE_SHA` env 설정 권장(없으면 git HEAD 자동).

## 팀 병합 상태 (2026-09-03 저녁)
- 팀원2 산출물 병합 완료: ops_service(qa_service 실물, answer_ex 자동 연결)·deploy_probe·team_deploy.md·안전세트 v1(사람 판)·별칭 점검.
- 별칭 채택: `data/corpus/corp_aliases.v1.json` → 어댑터 `load_corp_dictionary`가 주입(검색 코어 무변경). 실측: LG엔솔→LG이노텍 오귀속이 LG에너지솔루션 정확 매칭으로 교정.
- conditions **v2 승격**(SHA `83d5b8a0…`): v1과 차이 1문항 candidate_terms뿐(corps·세그먼트 동일). **B/D는 v2로 재실행 필요**(pin 일치) — E2E 종료 후.
- 안전 세트: v1(팀원2, expected_behavior 서술) + v2(`safety_set.v2.jsonl`, 기계 검증판 20문항·러너 기본) — 20/20 통과.

## 작업 방식
- 수정은 한 번에 원자적으로. 배치를 나눠 오래 끌지 않는다.
- 피드백은 방어 없이 객관적으로 판정하고, 타당하면 즉시 반영한다.
- 설계 문서는 텍스트(txt/md)로 유지한다. HTML 재작성은 요청이 있을 때만.
