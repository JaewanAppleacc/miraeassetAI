"""
QA 전용 FastAPI 엔트리 — /qa, /answer, /health를 띄운다.

실행:
    PYTHONIOENCODING=utf-8 uvicorn dart_detective.qa_api:app --port 8000
"""

from __future__ import annotations

from fastapi import FastAPI

from .qa_service import qa_ready, router as qa_router

app = FastAPI(title="DART QA", version="1.0")
app.include_router(qa_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "qa_ready": qa_ready()}
