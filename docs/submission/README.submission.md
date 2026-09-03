# Disclosure Analyst — 공시 근거 기반 QA Agent

제10회 미래에셋증권 AI Festival "공시 Agent" 예선 제출물.

## 평가용 API 엔드포인트 (필수 기재)

```
http://49.50.141.174/answer
```

- `GET /answer?question_id={ID}&question={질의}` · 인증 헤더 없음 · 응답 `application/json`
- 응답 5필드 전부 문자열: `question_id`, `question`, `retrieved_context`, `think_trace`, `answer`
- 보조: `GET /health`(생존), `GET /ready`(데이터·프롬프트 지문 포함 준비 상태)
- 상세 명세: `docs/submission/api_spec.md`

## 시스템 한 줄 요약

제공된 DART 공시 코퍼스(4,204건)만 근거로, 질문 유형별 전략 라우팅 → BM25 검색(4-arm 사전등록
실험으로 선정) → 결정론 근거 선택 → Decimal 계산기 → HCX-005 Function Calling(claim 단위) →
claim별 근거 검증 게이트 → 3단 폴백으로 답한다. 원문에 없는 수치는 구조적으로 나가지 못한다.

<!-- TODO(4-arm 확정 후): 승자 arm 명시 + PROVISIONAL/FINAL 상태 -->

## 실행 (재현)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-serve.txt && .venv/bin/pip install -e .
# 데이터: DocumentIR 4파일(전처리 산출물 — 아래 링크)을 받아 색인 생성(133초)
DART_QA_DOCUMENT_IR_DIR=<document_ir 경로> .venv/bin/python scripts/build_index.py
# 환경변수: CLOVA_API_KEY(필수), DART_QA_DOCUMENT_IR_DIR
.venv/bin/uvicorn dart_detective.ops_service:app --host 0.0.0.0 --port 80 --workers 1
```

배포 절차 전문(서버 스펙·systemd·데이터 SHA 대조): `docs/team_deploy.md`
배포 검증: `python scripts/deploy_probe.py http://<IP>`

## 전처리 산출물

- DocumentIR(원본 XML 4,204건 파싱 결과, 8GB): <!-- TODO: 클라우드 스토리지 링크 -->
  - 파일별 SHA-256은 `data/index/index_manifest.json` 생성 시 자동 대조됨
- 소형 산출물(문서 메타데이터·평가셋·조건 파일)은 저장소에 포함

## 주요 수치 (자체 평가셋 DEV_TUNE 101, 실서버 리허설)

- 평가 방식 재현(순차·300s·재시도 2회) 101문항: HTTP 실패 0 · 5필드 계약 위반 0
- 지연 p50 13.7s · p95 48s · 최대 58.5s (예산 300s)
- 답변가능성(없음/유보 판별) 98/101 · 원문에 없는 수치로 나간 답 0
- 안전 세트 20문항(인젝션·투자의견·다의기업·초장문·기간 밖) 전부 통과

## 저장소 구조·설계 문서

- 설계서: `docs/specs/team-architecture-v4.txt` · 검색 코어 선정 실험: `docs/specs/4arm-vfinal-spec.txt`
- 기술제안서: <!-- TODO: 4-arm 확정 후 링크 -->
