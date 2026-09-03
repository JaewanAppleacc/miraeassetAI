# API 서버 정보 — 요청/응답 명세

## 엔드포인트

| 항목 | 값 |
|---|---|
| Base URL | `http://49.50.141.174` |
| 평가 경로 | `GET /answer` (고정) |
| 인증 | 없음 (공지 준수) |
| 포트 | 80 (HTTP 표준) |
| Content-Type | `application/json; charset=utf-8` |

## 요청

`GET /answer?question_id={질의 ID}&question={평가 질의}`

- 두 파라미터 모두 정확히 1개, 비어 있지 않은 문자열. 누락·빈 값·중복 → **400**.

```bash
curl -G "http://49.50.141.174/answer" \
  --data-urlencode "question_id=Q-001" \
  --data-urlencode "question=평가 질의"
```

## 응답 (5필드, 전부 문자열)

```json
{
  "question_id": "요청 echo",
  "question": "요청 echo",
  "retrieved_context": "실사용 근거 목록의 JSON 직렬화 문자열 — 근거마다 document_id, source_locator(문서/노드), 인용 원문",
  "think_trace": "실행 요약의 JSON 직렬화 문자열 — 조건 해석→전략→검색→근거→(계산)→LLM→검증 단계와 검증 체크 결과",
  "answer": "최종 답변. 사실 문장마다 (공시명, 접수번호, 일자) 인라인 표기. 확인 불가 시 명시"
}
```

## 운영 특성 (평가 호출 방식 대응)

- 순차 호출 전제 · 서버 내부 데드라인 290초(외부 300초 대비 여유) · 남은 예산 부족 시 LLM 생략 후 결정론 답변
- 재시도(동일 question_id) 대비: 완결 답변은 캐시되어 재요청 시 즉시 응답(실측 0.05초). 폴백·저하 답변은 캐시하지 않아 재시도가 완전한 답을 다시 시도
- 5xx를 반환하지 않도록 설계: 내부 오류도 유효한 5필드 JSON으로 응답
- `GET /health` 프로세스 생존 · `GET /ready` 데이터 SHA·프롬프트 지문 포함 준비 상태
- 장애 시 systemd 자동 재기동(결과물 변경 없는 단순 재기동 — 공지 허용 범위)
