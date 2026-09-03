"""②/⑨ 서버 경계 — interfaces.md §2-1: 에이전트가 밖에 노출하는 함수는 둘뿐이다.

    answer(question_id, question, *, deadline_s=None) -> dict[str, str]   5필드, 절대 예외 없음
    readiness() -> dict                                                    /ready·vFINAL 19번 pin

qa_service(팀원2 소유)가 이 둘만 부른다. 캐시·세마포어·290초 데드라인·로깅은 그쪽 소유고,
여기는 파이프라인(⓪ 정책 게이트 → 해석·검색·계산·LLM·검증 → 5-string 직렬화)만 책임진다.

추가로 answer_ex()는 (wire, meta)를 돌려준다 — meta.cacheable이 False면 캐시에 넣지 않는다
(v4 §14: 폴백·degraded 결과 캐시 제외). answer()는 wire만 돌려주는 얇은 껍데기다.

deadline_s: 호출자가 남겨준 예산(초). LLM 호출은 40초 상한(v4 §12)이므로 남은 예산이
LLM_MIN_BUDGET_S보다 작으면 LLM을 건너뛰고 결정론 경로(발췌·계산기)로 답한다 — 유효 JSON이
빈 답보다 낫고, 재시도(같은 question_id)가 오면 캐시로 즉시 답한다.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import traceback
from typing import Any

from . import answer_wire, policy_gate
from .agents import qa_agent
from .llm import get_llm
from .retriever_adapter import build_line_window_retriever

logger = logging.getLogger("dart_detective.answer_api")

LLM_MIN_BUDGET_S = 45.0        # LLM 호출 상한 40s + 직렬화 여유. 이보다 적게 남으면 LLM 생략.
DEFAULT_ARM = "D"              # B·D 판정 잠정 승자(PROVISIONAL_WINNER). 4-arm 확정 시 갱신.

_lock = threading.Lock()
_retriever = None
_store = None


def _get_retriever():
    """지연 로딩 싱글턴. 기동 preload는 qa_service가 readiness()를 불러서 한다."""
    global _retriever, _store
    with _lock:
        if _retriever is None:
            _retriever, _store = build_line_window_retriever()
    return _retriever


def reset(retriever: Any = None) -> None:
    """테스트용: 캐시를 버리거나 가짜 retriever를 주입한다."""
    global _retriever, _store
    with _lock:
        _retriever = retriever
        _store = None


def _refusal_wire(question_id: str, question: str, decision: policy_gate.Decision) -> dict[str, str]:
    trace = {
        "execution_mode": "EARLY_EXIT",
        "operations": [{"step": "policy_gate", **decision.to_dict()}],
        "calculation": {},
        "validation": {"answerability": "REFUSED", "status": "SUPPORTED", "checks": []},
    }
    return {
        "question_id": question_id,
        "question": question,
        "retrieved_context": "",
        "think_trace": json.dumps(trace, ensure_ascii=False),
        "answer": f"{policy_gate.REFUSAL_ANSWER}\n\n{policy_gate.REFUSAL_UNCERTAINTY}",
    }


def _error_wire(question_id: str, question: str, exc: BaseException) -> dict[str, str]:
    """어떤 내부 실패에도 유효한 5필드를 돌려준다(5xx는 재시도만 부른다 — 계약 위반이 더 나쁘다)."""
    trace = {"execution_mode": "EARLY_EXIT",
             "operations": [{"step": "internal_error", "type": type(exc).__name__}],
             "calculation": {}, "validation": {"answerability": "", "status": "ERROR", "checks": []}}
    return {
        "question_id": question_id,
        "question": question,
        "retrieved_context": "",
        "think_trace": json.dumps(trace, ensure_ascii=False),
        "answer": "내부 오류로 이 질문에 대한 근거 검색을 완료하지 못했다. 답변을 생성할 수 없다.",
    }


def _meta_of(state: Any, decision: policy_gate.Decision, llm_skipped: str | None) -> dict[str, Any]:
    llm = getattr(state, "llm", None) or {}
    degraded = bool(llm.get("degraded")) or bool(llm.get("error"))
    # 결정론 경로(계산기·규칙·유보·존재 판정)는 폴백이 아니라 정상 답이다 — 캐시 가능.
    # LLM이 있어야 했는데 실패·폐기·예산 부족으로 발췌 폴백이 된 경우만 캐시 제외.
    fallback = degraded or llm_skipped == "deadline"
    return {
        "cacheable": not fallback,
        "degraded": degraded,
        "llm_used": bool(llm.get("used")),
        "llm_skipped": llm.get("skipped") or llm_skipped,
        "policy": decision.to_dict(),
        "strategy": state.route.strategy if getattr(state, "route", None) else None,
        "validation_status": (getattr(state, "validation", None) or {}).get("status"),
    }


def answer_ex(question_id: str, question: str, *,
              deadline_s: float | None = None) -> tuple[dict[str, str], dict[str, Any]]:
    try:
        decision = policy_gate.screen(question)
        if decision.action == "refuse":
            return _refusal_wire(question_id, question, decision), {
                "cacheable": True, "degraded": False, "llm_used": False,
                "llm_skipped": "policy_refusal", "policy": decision.to_dict(),
                "strategy": None, "validation_status": "SUPPORTED"}

        llm_skipped = None
        llm = get_llm()
        if llm is not None and deadline_s is not None and deadline_s < LLM_MIN_BUDGET_S:
            llm, llm_skipped = None, "deadline"

        state = qa_agent.answer_question(question, _get_retriever(), llm=llm)
        if decision.notices:
            state.answer = state.answer + "\n\n" + "\n".join(decision.notices)
        out = state.to_dict()
        out.setdefault("route", {})
        # 정책 게이트를 trace 맨 앞에 기록한다(무력화·시점 해석의 근거).
        wire = answer_wire.to_answer_wire(question_id, question, out)
        if decision.reasons or decision.notices:
            trace = json.loads(wire["think_trace"])
            trace["operations"].insert(0, {"step": "policy_gate", **decision.to_dict()})
            wire["think_trace"] = json.dumps(trace, ensure_ascii=False)
        return wire, _meta_of(state, decision, llm_skipped)
    except Exception as exc:  # noqa: BLE001 — 계약: 절대 예외를 밖으로 던지지 않는다
        logger.error("answer_ex failed: %s\n%s", exc, traceback.format_exc())
        return _error_wire(question_id, question, exc), {
            "cacheable": False, "degraded": True, "llm_used": False,
            "llm_skipped": "error", "policy": {}, "strategy": None, "validation_status": "ERROR"}


def answer(question_id: str, question: str, *, deadline_s: float | None = None) -> dict[str, str]:
    wire, _ = answer_ex(question_id, question, deadline_s=deadline_s)
    return wire


def readiness() -> dict[str, Any]:
    """vFINAL 19번·/ready. 실패해도 예외 대신 ready=False."""
    try:
        retriever = _get_retriever()
        store = _store
        pins = dict(store.readiness()["pins"]) if store is not None else {}
        llm = get_llm()
        return {
            "ready": True,
            "mode": "real",
            "arm": os.environ.get("DART_QA_ARM", DEFAULT_ARM),
            "n_docs": len(store) if store is not None else None,
            "llm_provider": getattr(llm, "provider", None),
            "llm_enabled": llm is not None,
            "pins": {**pins,
                     "prompt_version": qa_agent.PROMPT_VERSION,
                     "prompt_fingerprint": qa_agent.prompt_fingerprint(),
                     "corpus_cutoff": policy_gate.CORPUS_CUTOFF},
        }
    except Exception as exc:  # noqa: BLE001
        logger.error("readiness failed: %s", exc)
        return {"ready": False, "mode": "degraded", "error": f"{type(exc).__name__}: {exc}", "pins": {}}
