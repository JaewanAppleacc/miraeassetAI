# DART Corpus Viewer

공시 Agent 전체 설계·진행 상태·Claude Code 인수인계는 `CLAUDE.md`를 먼저 확인합니다.

미래에셋증권 AI Festival 제공 공시 코퍼스를 원본 변경 없이 열람하는
로컬 뷰어입니다.

## 실행

```bash
npm install
npm run viewer
```

브라우저에서 `http://localhost:3000`을 엽니다.

기본 코퍼스 위치는 실행 디렉터리 기준 `./corpus`입니다(`scripts/viewer-api.mjs`).
개인 로컬 경로를 코드나 문서에 커밋하지 않고, 다른 위치를 쓰려면 항상 실행 전
환경변수로 지정합니다.

```bash
DISCLOSURE_CORPUS_ROOT="/새로운/corpus/경로" npm run viewer
```

## 기능

- `manifest.jsonl`을 이용한 보고서명·접수일·정정 여부 표시
- exchange, holding, major, periodic 문서군 탐색
- 기업·접수번호·보고서명 검색
- 실제 HTML/XML 형식 자동 판별
- 잘못된 HTML charset 선언 자동 교정
- DART XML의 제목·문단·표를 읽기 쉬운 HTML로 주문형 변환
- periodic 다중 첨부 파일 전환
- 렌더링 보기와 원문 보기

원본 `raw` 파일은 읽기만 하며 수정하거나 복제하지 않습니다.

## 공시 Agent 공식 API — GET /answer

경로와 파라미터는 고정입니다(주최측 API 공지 반영, 자세한 내부 계약은
`domain/interfaces/README.md`·`domain/evaluation-harness/README.md` 참고).

```text
GET /answer?question_id=Q-001&question=평가질의
```

- `question_id`, `question`은 각각 정확히 1개, 문자열, 공백이 아닌 값이어야 합니다.
  누락·빈 값·중복은 `400`입니다.
- 인증 헤더는 요구하지 않습니다.

응답은 항상 아래 5개 문자열 필드만 가진 JSON입니다
(`domain/interfaces/answer-wire-response.schema.json`,
`domain/interfaces/examples/answer-wire-response.example.json`):

```json
{
  "question_id": "Q-001",
  "question": "삼성전자의 2024년 11월 15일 자기주식취득결정 핵심 내용은 무엇인가?",
  "retrieved_context": "[{\"document_id\":\"major_20241115000375\",\"source_locator\":\"major_20241115000375/20241115000375.xml#node=3\",\"snippet\":\"1. 취득예정주식(주) 보통주식 50,144,628\"}]",
  "think_trace": "{\"execution_mode\":\"STRUCTURED\",\"operations\":[\"lookup_event\",\"resolve_latest_effective_version\"],\"calculation\":{},\"validation\":{\"evidence_supported\":true,\"version_valid\":true,\"answerability\":\"SUPPORTED\"}}",
  "answer": "2024년 11월 15일 이사회에서 자기주식 취득을 결정했습니다."
}
```

`retrieved_context`·`think_trace`는 내부 FinalResponse의 배열/객체를
`JSON.stringify()`한 문자열입니다. 호출자는 `JSON.parse()`로 복원해야 하며, 이
인코딩 방식은 고정입니다.

**Public Endpoint: `DEPLOYMENT_PENDING`** — 실제 공개 Endpoint URL은 아직 배포되지
않았습니다. 이 문서·config 예시는 실제 주소를 지어내지 않고 위 리터럴 문자열로
남겨 둡니다.

타임아웃·재시도(공식 실행 프로필: `timeout_ms=300000`, `concurrency=1`, `retries=2`):

- 외부(공식 클라이언트) 타임아웃: **300초**
- 이 handler 내부 deadline: **290초**(`DEFAULT_TIMEOUT_MS`) — 외부 타임아웃보다 항상
  먼저 `503`으로 안전하게 반환합니다
- 타임아웃 또는 HTTP 5xx만 최대 **2회 재시도**(총 3회 시도). 4xx, 2xx 계약 오류, question
  echo mismatch는 재시도하지 않습니다

`GET /health`는 프로세스 생존만 확인합니다. 실제 Seed artifact의 해시·스키마·snapshot
검증까지 성공했는지는 `GET /ready`가 `200`과 `{"status":"READY","ready":true}`를
반환하는지로 확인합니다. 배포 artifact를 소스 트리 밖에 마운트할 때는
`SEED_RUNTIME_ROOT` 또는 `SEED_STRUCTURED_MANIFEST_PATH`,
`SEED_CANONICAL_RELEASE_MANIFEST_PATH`, `SEED_PLAN_PATH`,
`SEED_PLAN_MANIFEST_PATH`를 사용할 수 있습니다. 지정된 파일도 기존 manifest 검증을
우회하지 않습니다.

현재 제출용 실행 프로필은 로컬 파일로 pin된 대용량 Seed artifact를 읽는 **Node HTTP
서버**입니다. `npm run start:agent`로 실행하며 `AGENT_HOST`(기본 `0.0.0.0`)와 `PORT`(기본
`3000`)를 사용할 수 있습니다. Vinext/Cloudflare Worker 빌드는 UI·계약 호환성 확인용으로
유지하지만 Worker에는 로컬 파일시스템이 없으므로, artifact를 R2/KV 등으로 이전하기 전에는
제출 런타임으로 사용하지 않습니다. 이 경우 `/ready`는 반드시 503으로 닫혀야 합니다.

### Release Gate

최종 제출 전에 아래를 확인합니다.

- [ ] 이 README와 관련 config의 `DEPLOYMENT_PENDING`을 실제 배포된 Public Endpoint
      주소로 교체했다.
- [ ] 교체한 주소로 `GET /answer?question_id=...&question=...`를 실제 호출해 5개
      문자열 필드 응답을 확인했다.
- [ ] 배포 서버의 `GET /ready`가 `200/READY`이고, Seed artifact를 제거하거나 변조한
      부정 테스트에서는 새 프로세스가 `503/SEED_RUNTIME_INIT_FAILED`로 닫히는지 확인했다.
- [ ] `work/domain-seed`를 로컬에만 둔 채 배포하지 않았고, manifest가 pin한 runtime
      artifact와 canonical DocumentIR shard가 모두 배포 이미지 또는 읽기 전용 mount에
      포함됐는지 확인했다.
