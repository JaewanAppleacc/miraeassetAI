# 프로젝트 컨텍스트 — 미래에셋 AI Festival 공시 Agent

이 폴더(`ai_festival`)는 "최종 설계" 세션의 결정을 구현하는 폴더다.
이전 세션에서 가져온 것은 두 가지뿐이다: ① 대회 정보 ② 팀이 최종 확정한 설계.
중간 논의, 폐기된 후보, v3 이전 문서는 의도적으로 가져오지 않았다.

## 0. 고정 입력 — DocumentIR (그대로 사용, 재파싱 없음)

- 위치: `/Users/ijiyeong/Desktop/document_ir/` (리포 밖. 환경변수로 주입)
- 파일 4개 = 문서군 4개, 총 **4,204건**, 약 8.0 GB. schema 1.0 / parser 1.0.0 / snapshot `snap_7484a10220422056`.

| 파일 | 건수 |
|---|---|
| `exchange.jsonl` | 1,469 |
| `holding.jsonl` | 1,083 |
| `major.jsonl` | 598 |
| `periodic.jsonl` | 1,054 |

- 레코드 구조: `doc_id`, `schema_version`, `parser_version`, `corpus_snapshot_id`, `source_files[]`, `nodes[]`, `warnings[]`, `parse_quality{}`.
- 4-arm 실험의 네 arm과 에이전트 층 모두 **이 파일을 공통 corpus로 읽는다**(vFINAL 6번 Same inputs). 아무도 재파싱하지 않는다.
- 킥오프 체크리스트 1번(input SHA 고정)에서 이 4개 파일의 SHA-256을 함께 기록한다.

### 코퍼스 메타데이터 (2026-09-03 확보, `data/corpus/`)
주최측 구글 드라이브의 `3.공시.zip`(442MB)에서 소형 파일만 꺼냈다. 원본 XML 5.19GB는 풀지 않았다.

| 파일 | 크기 | SHA-256 | 검증 |
|---|---|---|---|
| `manifest.jsonl` | 2.4MB · 4,204행 | `04750795…aba3364` | `corpus_snapshot.json` 기록값과 **일치** |
| `universe.csv` | 10.7KB · 70개 기업 | `96560165…fbfa1dc` | `corpus_snapshot.json` 기록값과 **일치** |
| `universe.xlsx` | 14KB | `87ed0050…` | (csv와 동일 내용) |
| `README.md`, `data_filter.md` | 10KB | — | 주최측 코퍼스 설명 |

지문이 일치하므로 **DocumentIR 4,204건이 이 코퍼스에서 만들어진 것이 증명됐다.** 이전 실측과 같은 입력이다.
이로써 `filer_name`(보고자) 결손이 해소됐다 — 지분공시 1,083건 전부 채워져 있고, 보고자가 대상 70개 기업인 경우도 있다(예: 삼성물산).
`base_year`/`base_month`는 정기공시 1,054건에 채워져 있다.

## 1. 대회 정보 (주최측 공지·과제소개자료 기준)

- 대회: 제10회 2026 미래에셋증권 AI Festival, 과제 "공시 Agent (Disclosure Analyst)". 네이버클라우드 공동 주최.
- 과제: 제공된 DART 공시 코퍼스(2023.01 ~ 2026 1Q)만 근거로 검색·비교·계산·정정이력·정보한계 대응을
  하는 근거 기반 QA Agent를 공개 API로 배포. 주최측이 비공개 질의를 호출해 채점.
- 마감: **2026-09-06 23:59 KST**. 마감 후 커밋·재배포 등 결과물 변경은 실격. 장애로 인한 단순 재기동은 허용.
- 평가: 09.07 ~ 09.30. 서버 운영 기간은 09.07 ~ 09.20 중 별도 공지(최대 1주), 가동 시간대도 공지 예정.
  결과 10.01 → 본선 6팀 → 결선 10월(PT + 라이브 시연).

### 호출·응답 규격
- `GET {endpoint}/answer?question_id=...&question=...` · 경로 `/answer` 고정 · 인증 헤더 없음
  (접근 제어는 주최측 발신 IP 허용 방식, 대역은 추후 공지).
- 순차 1건씩(동시 요청 없음) · 타임아웃 300초 · 타임아웃/5xx 시 최대 2회 재시도.
- 응답 `application/json`, 5필드 **전부 문자열**: `question_id`, `question`, `retrieved_context`,
  `think_trace`, `answer`. 길이 제한 없음(극단적 길이는 초과분 미반영). 빈 문자열 허용. think_trace 형식 자유.
- 서버: HTTP 80 또는 HTTPS 443(자체서명 허용). 도메인 불필요(공인 IP 제출). Public 망 접근 필수.
  환경 자유(NCP, 개인 서버, 터널링).

### 제약
- LLM: 답변 생성 LLM과 Agent workflow의 LLM은 **HyperCLOVA X 계열만**(위반 시 평가 제외).
  임베딩·리랭커·형태소분석기·규칙 NLP는 제한 없음.
- 금지: 코퍼스 외 데이터(뉴스·리포트·위키), OpenDART 등 외부 API 런타임 호출, 주가 예측·투자의견·종목 추천.
- 확인 불가 시 "공시에서 확인되지 않음"을 명시(정보한계 대응).
- 데이터 함정: `raw/` 한글 폴더명은 NFD, `manifest.jsonl`·`universe.csv`는 NFC.
  정규화 없이 매칭하면 에러 없이 빈 결과.

### 평가
- 문제: 3 Task(검색·정보추출 / 다중조회·비교·연산 / 복합문서 추론) × Closed/Open-ended × 난이도 상·중·하.
- 질의별 지표 8: 정확성 / 근거 완전성 / 요구사항 충족 / 근거 기반(환각) / 추론 논리성 /
  안전성·신뢰성(프롬프트 공격 대응) / 정보한계 대응 / 근거 공시 표시.
- 정성평가: 문제정의, 기술완성도·성능, 창의성·확장성, 답변 정확성·완결성, 현업 활용성·리스크 관리.

### 제출물 (주최측 GitHub Organization private repo에 push)
1. 소스코드 + 재현 환경(`requirements.txt` 필수, Dockerfile 선택) + README(**API 엔드포인트 URL 필수**, 환경 구성·실행 명령).
2. 기술제안서(분량·양식 자유).
3. API 서버 정보(엔드포인트 + 요청/응답 JSON 명세).
- 전처리 산출물도 제출 대상. 대용량은 클라우드 스토리지 링크로 대체.

### 인프라·비용
- 팀당 NCP 크레딧 20만원 1회(부가세 포함, 서버·네트워크 포함, 유효 2026-09-30, 대표 1인 신청 후 쿠폰 직접 등록).
  크레딧 미적용 상품은 일반 과금. 초과분 자비.
- CLOVA Studio 429가 실질 리스크. 한도 확대 불가. 서비스앱 신청 시 테스트앱 대비 상향
  (HCX-005: 60 RPM / 60K TPM → 300 / 180K). TPM은 input + maxTokens로 계산되므로 maxTokens를 타이트하게.
- 주최측 예시 아키텍처(정형·청크·정정이력 3저장소 + function calling 툴 7종, 최대 8스텝)는 참고용. 자유 변경 가능.

## 2. 최종 확정 설계 (팀 동결)

권위 문서 2개. `docs/specs/`에 있고 SHA-256으로 고정(`docs/specs/SHA256SUMS`).

| 파일 | SHA-256 | 역할 |
|---|---|---|
| `4arm-vfinal-spec.txt` | `1a856dad…42da9f5` | 검색 코어 4-arm 실험 사전 등록 스펙(규칙 1~21 + 판정 체인). byte 수정 금지. 변경은 21번 절차로만. |
| `team-architecture-v4.txt` | `cd5241fa…f14dc9` | Team Architecture v4(v3 SUPERSEDED). 요약이 vFINAL과 충돌하면 vFINAL 우선. |

핵심 결정 요약(상세는 v4 본문):
- 검색 코어는 **선확정 없음**. 4-arm 실험으로 확정:
  A `FIXED+FULL_DENSE` / B `LINE_WINDOW+LOW_ONLY_DENSE` / C `FIXED+DENSE_OFF` / D `LINE_WINDOW+DENSE_OFF`.
  DEV_TUNE 결과 = PROVISIONAL_WINNER. DEV_CHECK(47) one-shot 통과 후에만 FINAL.
  PG 불가 시 B 자동 선택 없음(vFINAL 10번: 두 gate + 최소 배포 가능성 통과 시만 OPERATIONAL_FALLBACK, 아니면 BLOCKED).
- 파이프라인: ⓪ 정책 게이트 → ① 해석 → ② 답변가능성 조기 판정 → ③ answer_type(CLOSED/OPEN_ENDED)·strategy 7종
  → ④ 선정 코어 검색 → ⑤ Node 역참조 근거 선택 → ⑥ as-of 정정 → ⑦ Decimal 계산 → ⑧ HCX-005 Native FC(유일한 LLM 구간)
  → ⑨ 검증 hard5+soft2 + 3단 폴백(코드 단독 승인) → ⑩ 5-string 직렬화·캐시.
- HCX 출력은 Native v3 Function Calling `submit_grounded_answer`(스키마 합의 필요). LLM 산술 금지.
- 운영: 캐시 key = question_id + sha256(question) + 설정 지문. 폴백·degraded 결과는 캐시 제외.
  세마포어 1, 290초 데드라인(검색 60 / LLM 40 / 합성 30), `/health`·`/ready` 분리, crash 자동 재기동.
- 평가 세트: Gold 207 = DEV_TUNE 101(튜닝 자유) / DEV_CHECK 47(LOCKED, one-shot) / HOLDOUT 59(SEALED). 전부 팀 자체 제작.
- 상태 라벨 혼용 금지: MEASURED / IMPLEMENTED / READY / PROPOSED / PENDING / NOT YET RUN / BLOCKED / LOCKED·SEALED.
- 현재 상태(v4 §1): DocumentIR 4,204 MEASURED · 검색 loader/retriever 코드 IMPLEMENTED · 실측 shard 750문서/1,144청크 READY ·
  전체 KURE/pgvector 인덱스 PENDING · DEV_TUNE-101 retrieval MEASURED(Fixed 스택 R@10 0.868, 근거 회수 성능일 뿐) ·
  통합 E2E NOT YET RUN · HCX FC 15/15 MEASURED · PG 배포 가용성 BLOCKED(최우선 확인).

## 3. 코드 출처

- 계보 B(내 스택 — B/D arm + 에이전트 층): `github.com/jiyoung04lee/demo_ai_fesfival`
  브랜치 `share/dart-qa-handoff`(전체 이력) / `qa/dart-qa-standalone`(정리본). `src/dart_corpus`, `src/dart_detective`.
- 계보 A(팀원 스택 — A/C arm 후보: Fixed-512 + KURE(4ed4540) + pgvector, M-트랙: as-of 정정·한국어 합성·HCX FC):
  같은 저장소 `codex/common-baseline-v020-handoff` + `issue-1-agent-development-m1~m4` 계열.
  v4 §15.5는 "별도 저장소·브랜치"로 표기 — 정확한 위치는 팀원1 확인.
- 두 계보는 git 공통 조상이 없다. 머지가 아니라 `retriever_adapter`로 통합한다.
- 이 폴더는 `share/dart-qa-handoff`(HEAD `0c3123f`)를 그대로 가져온 git 저장소다. gold 브랜치도 fetch되어 있다(`origin/codex/gold-phase1-207-evaluation-v01`).
