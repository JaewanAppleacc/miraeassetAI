# 팀 분담안 (초안 v1) — 2026-09-03

- 마감 **09-06 23:59 KST**. 오늘 포함 4일. 3인.
- 전제: `Team Architecture v4` + `vFINAL` 스펙을 그대로 실행한다. 새 설계 없음.
- 입력: DocumentIR 4,204건(`~/Desktop/document_ir/`, 4 파일)을 그대로 쓴다. 재파싱 없음. 네 arm과 에이전트 모두 같은 파일을 읽는다.
- 호칭: 팀원1(A/C 스택 주인), 팀원2(배포·운영), 나(B/D 스택 + 에이전트 층).

## 한 눈에 보기 (쉬운 말)

최종 산출물은 **질문을 받아 답하는 서버 하나**다. 그 서버는 세 덩어리로 되어 있다.

1. **검색기** — 4,204개 문서에서 질문에 맞는 조각을 찾는다. 후보가 둘이다(팀원1 것 = A, 내 것 = B). 어느 쪽을 쓸지는 아직 안 정했고, 9/4 하루 실험으로 정한다.
2. **에이전트** — 질문 해석 → 검색기 호출 → 근거 고르기 → 계산 → HCX가 문장 작성 → 검증 → 5필드 포장. 내 `dart_detective`가 골격이고 새 부품 몇 개를 붙인다.
3. **서버·배포·제출** — 공인 IP 80포트에 `/answer` 띄우기, 캐시·타임아웃·재기동, README·제출 push. 아직 아무도 안 했다.

그래서 사람 셋이 이렇게 나눈다.

| 사람 | 맡는 덩어리 | 한 줄 요약 |
|---|---|---|
| 팀원1 | 검색기 후보 A | 인덱스 완성 → 실험에서 A 돌리기(dense 켠 것/끈 것 = A, C) → A가 이기면 에이전트에 꽂을 어댑터 함수 2개 |
| 팀원2 | 서버·배포·제출 | 오늘 더미 서버 공개망에 띄우기 → 운영 로직(캐시·타임아웃·재기동) → 서비스앱 신청 → 마지막 날 리허설·push. 검색 실험과 무관한 사람이라 의역 문항 검수와 안전 문항 작성도 맡는다 |
| 나 | 검색기 후보 B + 실험 도구 + 에이전트 전부 | 실험 공통 입력(질문별 조건 파일)과 채점기(이미 내 코드에 있음) → 실험에서 B 돌리기(B, D) → 승자를 에이전트에 꽂기 → 에이전트 새 부품 → 101문항 E2E |

**실험(4-arm)이 뭔가.** 같은 101문항, 같은 문서, 같은 채점기로 검색기 4개(A, B, 그리고 각각 dense를 끈 C, D)를 돌려서, 미리 동결한 규칙(vFINAL)대로 승자 하나를 고르는 것. 9/4 하루에 끝낸다.

**왜 먼저 4개를 맞춰야 하나.** 세 사람 코드가 만나는 지점이 4곳이고, 거기 모양이 다르면 금요일에 못 합친다.
① 실험 결과 파일 모양(채점기 하나가 네 결과를 읽어야 함) ② 서버가 내 에이전트를 부르는 함수 하나 ③ 에이전트가 검색기를 부르는 함수 둘(A가 이기든 B가 이기든 같은 모양) ④ HCX에게 시킬 출력 스키마. 각각 예시 한 개씩 붙여 `interfaces.md` 한 장에 적으면 끝.

## 0. 나누는 원칙

1. **스택 주인이 그 arm의 러너를 만든다.** A/C = 팀원1, B/D = 나. vFINAL 7번 as-built 원칙과 일치하고 서로 코드를 만지지 않는다.
2. **공용 자산은 한 명이 만들고 다른 한 명이 리뷰한다.** 채점기, conditions 사전 계산, config-diff.
3. **격리가 필요한 역할은 검색 실험에서 가장 먼 사람에게.** 의역 세트 독립 검수(vFINAL 13번) = 팀원2.
4. **배포는 오늘, 별도 사람이.** 되거나 안 되거나의 리스크라 품질 작업과 분리한다. 팀원2.
5. **에이전트 층은 한 사람이 통째로.** 밖으로 노출되는 경계는 `answer()` 함수와 `retriever_adapter` 둘뿐. 나.

## 1. 분담표

### 팀원1 — A/C 스택 + 인덱스 READY

| # | 일 | 산출물 | 기한 |
|---|---|---|---|
| 1 | 전체 KURE/pgvector 인덱스 로드 완료 → READY 증빙(load session ID · status READY · 행 수 · model rev/dim · corpus/chunker/index/config SHA) | READY 증빙 파일 | **9/4 12:00 컷오프** |
| 2 | PG 배포 가용성 확정 — 어디서 서빙할지, 서버 스펙(약 2GB 인덱스), 크레딧 내 가능한지. 팀원2와 협의 | 결정 기록 | 9/3 |
| 3 | A/C 러너: config 2개(dense ON/OFF만 다름), 공용 출력 스키마(§2-1), 메타필터는 **사전 계산 conditions 파일만** 사용(vFINAL 20번) | runner + config JSON + SHA | 9/4 |
| 4 | A↔C config-diff 검증 + 채점기 리뷰(체크리스트 2번) | 리뷰 기록 | 9/4 오전 |
| 5 | A/C 실행 + latency p95 / peak RSS 측정(18번 프로토콜) + UNRESOLVED 패킷 arm 라벨 제거 export | 결과 JSON | 9/4 |
| 6 | `retriever_adapter` 인터페이스(§2-3)의 A/C 구현 — A/C 승리 시 통합용 | 어댑터 | 9/5 |
| 7 | (Gold Owner인 경우 — §2 결정 a) DEV_CHECK 47 one-shot 실행·판정, UNRESOLVED arm-blind 판정, HOLDOUT 봉인 유지 | 판정 기록 | 9/4 저녁 ~ 9/5 |

### 팀원2 — 배포·운영·제출·독립 검수

| # | 일 | 산출물 | 기한 |
|---|---|---|---|
| 1 | 배포 스켈레톤: NCP 서버 + ACG + 공인 IP + 80포트, `GET /answer` 더미(5필드 문자열), `/health`·`/ready`, 요청 전량 로깅. 외부에서 curl 확인 | 공개 URL | **9/3** |
| 2 | `qa_service` 소유: 캐시(question_id + sha256(question) + 설정 지문, 폴백·degraded 제외), 세마포어 1, 290초 데드라인, 클라이언트 단절 시 취소, 실패 분류 로깅, crash 자동 재기동 | qa_service | 9/4 |
| 3 | CLOVA Studio 서비스앱 신청(429 한도 상향), 크레딧 쿠폰 등록 확인, HCX-005 키는 환경변수(secret 비노출) | 완료 확인 | 9/3 신청 |
| 4 | PG 호스팅(팀원1 협의) — A/C 승리 대비 | 서버 | 9/4 |
| 5 | vFINAL 19번 최소 배포 가능성 프로브 스크립트(SHA pin 일치 · mock 아님 · `/ready` · synthetic probe로 `/answer` 계약 · secret 비노출 · locator 해석) + 배포 리허설(재시도 겹침 · 재기동 · 인덱스 READY) | probe 스크립트 + 리허설 기록 | 9/5 ~ 9/6 |
| 6 | ~~frozen paraphrase 독립 검수(vFINAL 13번)~~ **불필요해짐** — 조건 사전 계산 결과 LOW 20문항(≥10). 16A 공통 제외로 LOW<10이 되면 되살아남 | — | — |
| 7 | 기업 별칭 커버리지 점검(70개) + 안전 세트 문항(인젝션 · 투자의견 · 다의 기업 · 빈/초장문 · 기간 밖) 작성 | 문항 파일 | 9/4 |
| 8 | 제출 패키징: README(엔드포인트 URL 필수 · 실행 명령), `requirements.txt`, 전처리 산출물 스토리지 링크, API 명세, 기술제안서 초안(v4 기반) → 주최측 GitHub Org private repo push | 제출물 3종 | 9/5 초안, **9/6 push** |

### 나 — B/D 스택 + 공용 실험 자산 + 에이전트 층 전체

| # | 일 | 산출물 | 기한 |
|---|---|---|---|
| 1 | `conditions.py` 사전 계산 → conditions 파일 + SHA 배포(LOW/HIGH 세그먼트, 메타필터 조건). 네 arm 공통 입력(vFINAL 1·20번) | 파일 + SHA | **9/3** |
| 2 | 공용 채점기: DEV_TUNE 101 required-slot 발견 · Recall@5/10/20 · LOW count · locator 치명/경미 판정(14번 범위) · metadata non-leak 검사. config + 코드 SHA 동결. 팀원1 리뷰 | scorer + SHA | 9/3 |
| 3 | B/D 러너: config 2개(LOW-only dense ON/OFF만 다름), 공용 출력 스키마 | runner + config + SHA | 9/4 |
| 4 | B/D 실행 + p95/RSS 측정 + UNRESOLVED export | 결과 JSON | 9/4 |
| 5 | ~~frozen paraphrase set 작성~~ **불필요해짐**(LOW 20문항) | — | — |
| 6 | 판정 체인(Hard → Quality → LOW → FINAL_TIE_SET → …)은 채점기 스크립트가 기계적으로 산출. 나 + 팀원1 공동 확인 후 PROVISIONAL_WINNER 동결 | 판정 기록 | 9/4 저녁 |
| 7 | 에이전트 층 코어: `policy_gate` ⓪ · `routing` ③(+복구) · `retriever_adapter` 인터페이스 정의 + B/D 바인딩 + Node 역참조 · `fallback` ⑨(수리 OFF) · validator bound 계열 · prompts + VERSION · `answer(question_id, question)` → 5필드 | dart_detective 신규 모듈 | 9/4 |
| 8 | HCX Native FC 클라이언트 이식 + `submit_grounded_answer` 스키마 확정(FC 코드 주인과) | llm.py | 9/4 |
| 9 | 조건부 게이트 항목(v4 §3): event ledger / ENUMERATION·COUNT·EXISTENCE, as-of 정정 이식, OPEN_ENDED 2-call, 동의어 — 게이트 통과 시만 포함 | 조건부 | 9/4 ~ 9/5 |
| 10 | 승자 코어 통합 + DEV_TUNE-101 **통합 E2E**(현재 NOT YET RUN) + 실패 태깅 | E2E 리포트 | 9/5 |
| 11 | 최종 코드 동결 + 팀원2 리허설 지원 | — | 9/6 |

## 2. 킥오프에서 맞출 것 (30분, 흩어지기 전)

### 합의 4건 → `interfaces.md` 한 장으로 고정

1. **러너 출력 스키마 + locator 규약 + conditions 파일 SHA**
   ```json
   {"question_id": "...", "arm": "A",
    "results": [{"rank": 1, "doc_id": "...", "locator": "...", "chunk_text_sha": "...", "score": 0.0}],
    "latency_ms": 0, "peak_rss_mb": 0}
   ```
   locator는 A/C·B/D 모두 같은 규약(예: `doc_id#node=N`). 채점기와 치명 위반 판정이 여기에 걸린다.
2. **`/answer` 경계**: `answer(question_id: str, question: str) -> dict` (5개 str 필드).
   캐시·세마포어·데드라인은 `qa_service`(팀원2) 소유. 환경변수 이름(`DART_QA_*`), Python 버전, 포트.
3. **`retriever_adapter`**: `search(conditions) -> list[Chunk{text, doc_id, locator, score}]`, `fetch_node(locator) -> Node`.
   승자가 누구든 에이전트 층은 바인딩만 바꾼다.
4. **HCX FC 스키마** `submit_grounded_answer`: `claims[{text, value?, unit?, period?, period_kind?, doc_id, quote}]`, `not_found_slots[]`, `uncertainty`.
   검증 게이트(numbers_bound 등)가 이 필드에 직접 걸린다.

### 결정 3건 (팀이 정해야 함)

- **a. Gold Owner 지정.** DEV_CHECK 47 one-shot 실행자이자 UNRESOLVED arm-blind 판정자(vFINAL 16·17번). 봉인 세트를 쥔 사람이어야 한다.
- **b. A/C readiness 컷오프와 미실행 arm 처리.** vFINAL 6번은 동일 corpus를 요구하므로 shard로 대체할 수 없다.
  컷오프(제안: 9/4 12:00)까지 전체 인덱스가 READY가 아니면 어떻게 할지 지금 정한다. 스펙 21번 ①(실행 불가 결함)에 해당하면 변경 로그를 남긴다.
- **c. PG 호스팅 위치·비용.** 크레딧 20만원 안에서 A/C 인덱스 서빙이 가능한지.

체크리스트 1~2번(input/config/code/filter SHA 고정, A↔C·B↔D config-diff)은 킥오프 자리에서 같이 처리한다.

## 3. 일정

| 날짜 | 공통 | 팀원1 | 팀원2 | 나 |
|---|---|---|---|---|
| 9/3 (D-3) | 킥오프 30분 → interfaces.md | 인덱스 로드, PG 결정 | 스켈레톤 공개 URL, 서비스앱 신청 | conditions + 채점기 SHA, B/D 러너 착수 |
| 9/4 (D-2) | 12:00 A/C 컷오프 → 4-arm 실행(고정 seed 교차 배치) → 판정 체인 → 저녁 PROVISIONAL_WINNER 동결 → DEV_CHECK one-shot | A/C 실행·측정 | qa_service, PG 호스팅, 검증 문항, 의역 검수 | B/D 실행, 에이전트 층 코어, FC 이식 |
| 9/5 (D-1) | 승자 코어 통합 | 어댑터 A/C 구현(승리 시) | 프로브 스크립트, 제출물 초안, 기술제안서 | 통합 E2E, 안전 세트, 조건부 게이트 판정 |
| 9/6 (D-day) | 코드 동결 → 19번 프로브 + 배포 리허설 → README 엔드포인트 → 주최측 repo push → 23:59 | 리허설 지원 | push 담당 | 리허설 지원 |

## 4. 사전 합의 불필요 (완전 병렬)

각자 스택 내부 구현, 스켈레톤 내부 구조, 내 프롬프트·합성·폴백·routing 로직, 검증 문항 작성, NCP 세팅·방화벽.

## 5. 리스크

- 전체 KURE 인덱스가 9/4 정오까지 READY가 아니면 A/C 미실행. 결정 b가 필요한 이유.
- HCX 429: 서비스앱 승인이 늦으면 테스트앱 한도(60 RPM)로 E2E. 평가는 순차 호출이라 실전 리스크는 작다.
- 통합 E2E가 9/5에 처음 도는 것. 9/4 밤에 B 스택으로 어댑터 검증용 E2E를 한 번 먼저 돌려 회귀 기준선을 확보하는 것을 권장(승자 선택과 무관, 스펙 위반 아님).
