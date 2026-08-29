"""FastAPI endpoint.

실행:
    PYTHONIOENCODING=utf-8 uvicorn dart_detective.api:app --reload --port 8000
    (src/를 PYTHONPATH에 넣거나 `pip install -e .` 후)
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .errors import CaseNotFoundError, SessionNotFoundError
from .graph import GameServer
from .qa_service import qa_ready, router as qa_router
from .state import ACTION_COST

app = FastAPI(
    title="DART Detective — Agent Backend",
    version="0.1.0",
    description="Case Pack 기반 금융 탐정게임. 모든 검색은 simulation_date로 차단된다.",
)

# 공개 배포용 노브. 세션은 프로세스 메모리에 있으므로 반드시 단일 워커로 띄운다.
server = GameServer(
    use_llm=os.environ.get("DART_DETECTIVE_LLM", "").lower() not in {"off", "0", "false"},
    max_sessions=int(os.environ.get("DART_DETECTIVE_MAX_SESSIONS", "50")),
    session_ttl_sec=int(os.environ.get("DART_DETECTIVE_SESSION_TTL", "1800")),
)


# 코퍼스 QA(/qa) — 게임 세션과 무관한 단발 질의응답. 배선은 qa_service에 있다.
app.include_router(qa_router)


class StartRequest(BaseModel):
    case_id: str
    session_id: str | None = None
    points_enabled: bool = True


class ActionRequest(BaseModel):
    action: str = Field(description="research | hint | term | decision | replay | open_document")
    question: str | None = None
    level: int | None = None
    term: str | None = None
    document_id: str | None = None
    collect: list[str] | None = None
    option_id: str | None = None
    used_evidence_ids: list[str] | None = None


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "llm_enabled": server.use_llm,
        "action_cost": ACTION_COST,
        "cases": len(server.list_cases()),
        "qa_index_ready": qa_ready(),
        **server.stats(),
    }


@app.get("/cases")
def list_cases() -> dict[str, Any]:
    return {"cases": server.list_cases()}


@app.get("/cases/{case_id}")
def get_case(case_id: str) -> dict[str, Any]:
    try:
        return server.store.load(case_id).briefing()
    except CaseNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/sessions")
def start_session(req: StartRequest) -> dict[str, Any]:
    try:
        session = server.start(req.case_id, req.session_id,
                               points_enabled=req.points_enabled)
    except CaseNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "session_id": session.session_id,
        "briefing": session.pack.briefing(),
        "state": session.act("term")["state"],  # 용어 목록 조회는 0포인트 — 초기 상태 확인용
    }


def _session(session_id: str):
    try:
        return server.get(session_id)
    except SessionNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/sessions/{session_id}/state")
def get_state(session_id: str) -> dict[str, Any]:
    from .state import public_state
    return public_state(_session(session_id).state())


@app.post("/sessions/{session_id}/actions")
def do_action(session_id: str, req: ActionRequest) -> dict[str, Any]:
    session = _session(session_id)
    payload = {k: v for k, v in req.model_dump().items()
               if k != "action" and v is not None}
    result = session.act(req.action, **payload)
    if result["error"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@app.get("/sessions/{session_id}/documents/{document_id}")
def get_document(session_id: str, document_id: str) -> dict[str, Any]:
    session = _session(session_id)
    doc = session.pack.document(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"문서 없음: {document_id}")
    if document_id not in (session.state().get("opened_documents") or []):
        raise HTTPException(status_code=403,
                            detail="아직 열지 않은 문서다. open_document 액션을 먼저 실행하라.")
    return doc


@app.get("/sessions/{session_id}/evidence")
def get_collected_evidence(session_id: str) -> dict[str, Any]:
    """수집한 단서만 상세히 반환한다 — 아직 못 찾은 단서는 내려보내지 않는다."""
    session = _session(session_id)
    found = set(session.state().get("found_evidence") or [])
    return {
        "session_id": session_id,
        "evidence": [
            {
                "evidence_id": e["evidence_id"],
                "document_id": e["document_id"],
                "text": e["text"],
                "category": e["category"],
                "importance": e["importance"],
                "educational_reason": e["educational_reason"],
            }
            for e in session.pack.evidence if e["evidence_id"] in found
        ],
        "total": len(session.pack.evidence),
        "total_critical": len(session.pack.critical_evidence()),
    }


@app.get("/sessions/{session_id}/trace")
def get_trace(session_id: str) -> dict[str, Any]:
    return {"session_id": session_id, "trace": _session(session_id).trace()}


@app.post("/sessions/{session_id}/reset")
def reset_session(session_id: str) -> dict[str, Any]:
    """시연용 Reset — 같은 사건을 처음부터 다시 시작한다."""
    session = server.reset(_session(session_id).session_id)
    return {"session_id": session.session_id, "briefing": session.pack.briefing()}


@app.delete("/sessions/{session_id}")
def end_session(session_id: str) -> dict[str, Any]:
    _session(session_id)
    server.end(session_id)
    return {"session_id": session_id, "ended": True}


# --- 웹 데모(정적 파일) ---------------------------------------------------
# 새 프론트엔드 프레임워크를 추가하지 않는다. FastAPI가 그대로 서빙한다.
_STATIC_DIR = Path(__file__).resolve().parent / "static"
if _STATIC_DIR.exists():
    app.mount("/app", StaticFiles(directory=_STATIC_DIR, html=True), name="app")

    @app.get("/", include_in_schema=False)
    def index() -> RedirectResponse:
        return RedirectResponse(url="/app/")
