# DART 공시 QA 서버.
#
#   docker build -t dart-qa .
#   docker run -p 7860:7860 dart-qa   ->  GET /health, POST /qa, GET /answer
#
# 주의: 문서 캐시(evidence_documents.jsonl 등)는 이미지에 넣지 않는다 —
# experiments/ 볼륨을 마운트하거나 DART_QA_DOCUMENTS로 경로를 지정한다.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app/src PORT=7860 DART_DETECTIVE_LLM=off

WORKDIR /app

RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn[standard]>=0.30" "pydantic>=2.7"

# 앱 소스 — QA는 dart_corpus(검색·평가)와 dart_detective(agent)만 있으면 된다.
COPY src/dart_corpus/ /app/src/dart_corpus/
COPY src/dart_detective/ /app/src/dart_detective/

# 임포트 스모크 — 깨진 이미지를 배포하지 않는다.
RUN python -c "from dart_detective.qa_api import app; print(0)"

EXPOSE 7860

CMD ["sh", "-c", "uvicorn dart_detective.qa_api:app --host 0.0.0.0 --port ${PORT} --workers 1"]
