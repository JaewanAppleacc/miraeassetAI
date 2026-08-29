"""코퍼스 QA 엔드포인트 배선.

    POST /qa  {"question": "..."}  ->  {"answer": ..., "evidence": [...]}

게임 API(api.py)와 분리해 둔 이유는 두 가지다.
  1. 게임 쪽은 LangGraph·Case Pack이 필요하지만 QA는 코퍼스 인덱스만 있으면 된다.
  2. 코퍼스 인덱스(doc_index.jsonl 111MB)는 리포에 없다 — import 시점에 읽으면
     인덱스가 없는 환경에서 앱 자체가 못 뜬다. 그래서 **첫 요청에서 지연 로딩**하고,
     없으면 503으로 이유를 알려준다.

경로는 환경변수로 바꾼다(기본값은 로컬 실험 디렉터리):
    DART_QA_DOC_INDEX     Stage 1 문서 인덱스 jsonl
    DART_QA_DOCUMENTS     Stage 2용 DocumentIR jsonl
    DART_QA_UNIVERSE      기업 사전 universe.csv
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .agents import qa_agent
from .corpus_retriever import CorpusRetriever
from .llm import get_llm

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EXP_DIR = REPO_ROOT / "experiments" / "gold25_retrieval"

router = APIRouter(tags=["qa"])
logger = logging.getLogger("dart_detective.qa")
RESPONSE_SCHEMA_PATH = Path(__file__).resolve().parent / "qa_response.schema.json"
_lock = threading.Lock()
_retriever: CorpusRetriever | None = None


def qa_paths() -> dict[str, Path]:
    universe = os.environ.get("DART_QA_UNIVERSE")
    if not universe:
        found = sorted((REPO_ROOT / "data").rglob("universe.csv"))
        universe = str(found[0]) if found else str(REPO_ROOT / "data" / "universe.csv")
    return {
        "doc_index": Path(os.environ.get("DART_QA_DOC_INDEX",
                                         DEFAULT_EXP_DIR / "doc_index.jsonl")),
        "documents": Path(os.environ.get("DART_QA_DOCUMENTS",
                                         DEFAULT_EXP_DIR / "evidence_documents.jsonl")),
        "universe": Path(universe),
    }


def missing_paths() -> list[str]:
    return [name for name, path in qa_paths().items() if not path.exists()]


def qa_ready() -> bool:
    return not missing_paths()


def get_retriever() -> CorpusRetriever:
    """첫 호출에서만 인덱스를 읽는다. 테스트는 dependency_overrides로 갈아끼운다."""
    global _retriever
    missing = missing_paths()
    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"코퍼스 인덱스가 없다: {', '.join(missing)}. "
                   "DART_QA_DOC_INDEX / DART_QA_DOCUMENTS / DART_QA_UNIVERSE로 경로를 지정하라.",
        )
    with _lock:
        if _retriever is None:
            paths = qa_paths()
            _retriever = CorpusRetriever.from_paths(
                paths["doc_index"], paths["documents"], paths["universe"])
    return _retriever


def reset_retriever() -> None:
    """테스트/재로딩용. 캐시만 버린다."""
    global _retriever
    with _lock:
        _retriever = None


class QARequest(BaseModel):
    question: str = Field(min_length=1)
    k: int | None = Field(default=None, ge=1, le=100,
                          description="Stage 2에서 볼 청크 수(기본 20)")


@router.get("/qa/health")
def qa_health() -> dict[str, Any]:
    """키 값은 절대 내려보내지 않는다 — provider 이름과 준비 여부만."""
    llm = get_llm()
    return {
        "status": "ok" if qa_ready() else "index_missing",
        "index_ready": qa_ready(),
        "missing": missing_paths(),
        "loaded": _retriever is not None,
        "llm_provider": getattr(llm, "provider", None),
        "llm_enabled": llm is not None,
    }


@router.post("/qa")
def qa(req: QARequest,
       retriever: CorpusRetriever = Depends(get_retriever)) -> dict[str, Any]:
    state = qa_agent.answer_question(req.question, retriever, llm=get_llm(), k=req.k)
    out = state.to_dict()
    response = {
        "question": req.question,
        "answer": out["answer"],
        "evidence": out["evidence"],
        "evidence_matches": out["evidence_matches"],
        "slots": out["slots"],
        "conditions": out["conditions"],
        "uncertainty": out["uncertainty"],
        "validation": out["validation"],
        "llm": out["llm"],
        "timings": out["timings"],
        "prompt_version": out["prompt_version"],
        "n_retrieved": len(out["retrieval"]),
    }
    # 한 줄 요약 로그. 질문 원문과 키는 남기지 않는다.
    logger.info(
        "qa question_chars=%d retrieved=%d evidence=%d slots=%d validation=%s "
        "llm=%s provider=%s retrieval_ms=%s llm_ms=%s total_ms=%s prompt=%s",
        len(req.question), response["n_retrieved"], len(response["evidence"]),
        len(response["slots"]), (response["validation"] or {}).get("status"),
        (response["llm"] or {}).get("used"), (response["llm"] or {}).get("provider"),
        out["timings"].get("retrieval_ms"), out["timings"].get("llm_ms"),
        out["timings"].get("total_ms"), response["prompt_version"],
    )
    return response
