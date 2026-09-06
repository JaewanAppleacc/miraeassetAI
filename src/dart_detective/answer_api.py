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
import re
import threading
import traceback
from typing import Any

from . import (answer_wire, arm_a4_a3_binder_evidence_v2_adapter, arm_a4_a3_live_adapter,
               arm_a4_a3_remediation_binder_evidence_v2_adapter, arm_a_live_adapter,
               arm_a_serving_bridge, grounded_answer, policy_gate)
from .agents import qa_agent
from .llm import get_llm
from .retriever_adapter import build_serving_retriever

logger = logging.getLogger("dart_detective.answer_api")

LLM_MIN_BUDGET_S = 45.0        # LLM 호출 상한 40s + 직렬화 여유. 이보다 적게 남으면 LLM 생략.
DEFAULT_ARM = "D"              # B·D 판정 잠정 승자(PROVISIONAL_WINNER). 4-arm 확정 시 갱신.

_lock = threading.Lock()
_retriever = None
_store = None
_arm: str | None = None        # 실제 서빙 arm — readiness는 env 문자열이 아니라 이 값을 보고한다.
_arm_pins: dict[str, Any] = {}

# retrieval_backend(Turn A-PLUS-QA-LIVE-WIRING-V1): 기본값 DEFAULT = 기존 build_serving_retriever
# 경로(동작 불변). ARM_A_FIXED_RRF = arm_a_serving_bridge(호출자가 주입한 text_resolver 필수).
# 선택은 configure() 인자 > env DART_QA_RETRIEVAL_BACKEND > DEFAULT.
_retrieval_backend: str | None = None
_text_resolver: Any = None
_backend_options: dict[str, Any] = {}


def configure(*, retrieval_backend: str | None = None, text_resolver: Any = None,
              **backend_options: Any) -> None:
    """서빙 검색 백엔드를 고르고 A 경로의 text_resolver·옵션(results_path 등)을 주입한다.

    인자 없이 부르면 env 기반 기본 상태로 되돌린다. 호출 때마다 retriever 캐시를 버린다
    (백엔드가 바뀌면 pins가 바뀌고, qa_service의 캐시 키(pins 해시)도 따라 바뀐다).
    """
    global _retrieval_backend, _text_resolver, _backend_options
    with _lock:
        _retrieval_backend = retrieval_backend
        _text_resolver = text_resolver
        _backend_options = dict(backend_options)
    reset()


def _resolve_backend() -> str:
    backend = (_retrieval_backend or os.environ.get(arm_a_serving_bridge.RETRIEVAL_BACKEND_ENV)
               or arm_a_serving_bridge.RETRIEVAL_BACKEND_DEFAULT).upper()
    if backend not in arm_a_serving_bridge.RETRIEVAL_BACKENDS:
        raise ValueError(f"알 수 없는 retrieval_backend: {backend} "
                         f"(허용: {', '.join(arm_a_serving_bridge.RETRIEVAL_BACKENDS)})")
    return backend


def _build_retriever() -> tuple[Any, Any, str, dict[str, Any]]:
    backend = _resolve_backend()
    # ARM_A_FIXED_RRF와 ARM_A_FROZEN_REPLAY는 같은 frozen-replay 경로다(Turn
    # A-PLUS-QA-LIVE-RETRIEVER-V1 — 이름만 명시적으로 분리, 858658e의 기존 동작은 그대로).
    if backend in (arm_a_serving_bridge.RETRIEVAL_BACKEND_ARM_A,
                   arm_a_serving_bridge.RETRIEVAL_BACKEND_ARM_A_FROZEN_REPLAY):
        return arm_a_serving_bridge.build_arm_a_serving_retriever(
            text_resolver=_text_resolver, **_backend_options)
    if backend == arm_a_serving_bridge.RETRIEVAL_BACKEND_ARM_A_LIVE:
        return arm_a_live_adapter.build_arm_a_live_serving_retriever(**_backend_options)
    if backend == arm_a_serving_bridge.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE:
        return arm_a4_a3_live_adapter.build_arm_a4_a3_live_serving_retriever(**_backend_options)
    if backend == arm_a_serving_bridge.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2:
        return (arm_a4_a3_binder_evidence_v2_adapter
                .build_arm_a4_a3_binder_evidence_v2_serving_retriever(**_backend_options))
    if backend == arm_a_serving_bridge.RETRIEVAL_BACKEND_ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE:
        return (arm_a4_a3_remediation_binder_evidence_v2_adapter
                .build_arm_a4_a3_remediation_binder_evidence_v2_serving_retriever(**_backend_options))
    # 기존 경로 — 인자·호출 그대로(동작 불변).
    return build_serving_retriever(os.environ.get("DART_QA_ARM", DEFAULT_ARM))


def _get_retriever():
    """지연 로딩 싱글턴. 기동 preload는 qa_service가 readiness()를 불러서 한다."""
    global _retriever, _store, _arm, _arm_pins
    with _lock:
        if _retriever is None:
            _retriever, _store, _arm, _arm_pins = _build_retriever()
    return _retriever


def reset(retriever: Any = None) -> None:
    """테스트용: 캐시를 버리거나 가짜 retriever를 주입한다."""
    global _retriever, _store, _arm, _arm_pins
    with _lock:
        _retriever = retriever
        _store = None
        _arm = None
        _arm_pins = {}


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


def _out_of_scope_wire(question_id: str, question: str,
                       decision: policy_gate.Decision) -> dict[str, str]:
    """코퍼스 기간 밖의 미래 연도 — 검색·LLM 없이 종료(v4 §6). 역질문으로 재질문을 유도한다."""
    year = ""
    for r in decision.reasons:
        if r.startswith("future_period:"):
            m = re.search(r"20[2-9][0-9]", r)
            year = m.group(0) if m else r.split(":", 1)[1].strip()
    trace = {
        "execution_mode": "EARLY_EXIT",
        "operations": [{"step": "policy_gate", **decision.to_dict()}],
        "calculation": {},
        "validation": {"answerability": "OUT_OF_SCOPE", "status": "SUPPORTED", "checks": []},
    }
    return {
        "question_id": question_id,
        "question": question,
        "retrieved_context": "",
        "think_trace": json.dumps(trace, ensure_ascii=False),
        "answer": policy_gate.OUT_OF_SCOPE_ANSWER_TEMPLATE.format(
            year=year, cutoff=policy_gate.CORPUS_CUTOFF),
    }


def _error_wire(question_id: str, question: str, exc: BaseException) -> dict[str, str]:
    """어떤 내부 실패에도 유효한 5필드를 돌려준다(5xx는 재시도만 부른다 — 계약 위반이 더 나쁘다)."""
    op: dict[str, Any] = {"step": "internal_error", "type": type(exc).__name__}
    # 브리지 오류(TEXT_RESOLUTION_REQUIRED 등)는 식별자를 trace에 남긴다 — fail-closed 사유가 보이게.
    code = getattr(exc, "code", "")
    if isinstance(code, str) and code:
        op["code"] = code
    trace = {"execution_mode": "EARLY_EXIT",
             "operations": [op],
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
    fallback_stage = getattr(state, "fallback_stage", "") or ""
    # 결정론 경로(계산기·규칙·유보·존재 판정)는 폴백이 아니라 정상 답이다 — 캐시 가능.
    # LLM 실패·폐기·예산 부족, 또는 ⑨ 폴백 체인 발동(v4 §11 ②③ 캐시 금지)만 캐시 제외.
    fallback = degraded or llm_skipped == "deadline" or bool(fallback_stage)
    usage = llm.get("usage") or {}
    claims = llm.get("claims") or llm.get("fc_claims_all_dropped") or {}
    return {
        "cacheable": not fallback,
        "fallback_stage": fallback_stage,
        "degraded": degraded,
        "llm_used": bool(llm.get("used")),
        "llm_skipped": llm.get("skipped") or llm_skipped,
        "llm_error": llm.get("error"),
        "llm_degraded_reason": llm.get("degraded_reason"),
        "policy": decision.to_dict(),
        "strategy": state.route.strategy if getattr(state, "route", None) else None,
        "validation_status": (getattr(state, "validation", None) or {}).get("status"),
        # 대상 문서 결박 관측(B안: 월 단위 결박·해소 문서·결정론 렌더링) — 없으면 None.
        "binding": (dict(getattr(state, "binding", None) or {}) or None),
        # Late Expansion 발동 관측(재검수 HIGH 3: 효과·회귀 추적용) — 미발동이면 None.
        "late_expansion": ({k: (getattr(state, "timings", None) or {}).get(k)
                            for k in ("late_expansion_supplement", "expanded_retrieval")
                            if (getattr(state, "timings", None) or {}).get(k)} or None),
        # FC 경로 관측(judge4 진단 공백 교정): claim 채택/폐기·전멸 후 JSON 대체·절단 여부.
        "fc": {"claims_total": claims.get("total"), "claims_kept": claims.get("kept"),
               "all_dropped": "fc_claims_all_dropped" in llm,
               "fallback_json": bool(llm.get("fc_fallback_json")),
               "preserved_values": llm.get("preserved_values"),
               "stop_reason": usage.get("stop_reason"),
               "truncated": bool(usage.get("truncated"))} if llm.get("used") else None,
    }


def answer_ex(question_id: str, question: str, *,
              deadline_s: float | None = None) -> tuple[dict[str, str], dict[str, Any]]:
    try:
        decision = policy_gate.screen(question)
        if decision.action == "refuse":
            return _refusal_wire(question_id, question, decision), {
                "cacheable": True, "fallback_stage": "", "degraded": False, "llm_used": False,
                "llm_skipped": "policy_refusal", "policy": decision.to_dict(),
                "strategy": None, "validation_status": "SUPPORTED"}
        if decision.action == "out_of_scope":
            return _out_of_scope_wire(question_id, question, decision), {
                "cacheable": True, "fallback_stage": "", "degraded": False, "llm_used": False,
                "llm_skipped": "out_of_scope", "policy": decision.to_dict(),
                "strategy": None, "validation_status": "SUPPORTED"}

        llm_skipped = None
        llm = get_llm()
        if llm is not None and deadline_s is not None and deadline_s < LLM_MIN_BUDGET_S:
            llm, llm_skipped = None, "deadline"

        # 인젝션 탐지 시 지시문 스팬을 지운 질문으로 파이프라인을 돌린다(wire 에코는 원문 유지).
        pipeline_q = decision.sanitized_question or question
        state = qa_agent.answer_question(pipeline_q, _get_retriever(), llm=llm)
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
        code = getattr(exc, "code", "")
        return _error_wire(question_id, question, exc), {
            "cacheable": False, "fallback_stage": "error", "degraded": True, "llm_used": False,
            "llm_skipped": "error", "policy": {}, "strategy": None, "validation_status": "ERROR",
            "error_code": code if isinstance(code, str) else ""}


def answer(question_id: str, question: str, *, deadline_s: float | None = None) -> dict[str, str]:
    wire, _ = answer_ex(question_id, question, deadline_s=deadline_s)
    return wire


_code_sha: str | None = None


def _get_code_sha() -> str:
    """캐시 pin용 코드 식별자. 배포 env(DART_QA_CODE_SHA) 우선, 없으면 git HEAD(1회 조회)."""
    global _code_sha
    if _code_sha is None:
        v = os.environ.get("DART_QA_CODE_SHA", "")
        if not v:
            try:
                import subprocess
                v = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                                   capture_output=True, text=True, timeout=5,
                                   cwd=os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
                                   ).stdout.strip()
            except Exception:  # noqa: BLE001
                v = ""
        _code_sha = v
    return _code_sha


def readiness() -> dict[str, Any]:
    """vFINAL 19번·/ready. 실패해도 예외 대신 ready=False."""
    try:
        retriever = _get_retriever()
        store = _store
        pins = dict(store.readiness()["pins"]) if store is not None else {}
        llm = get_llm()
        ready = True
        profile_error = ""
        if os.environ.get("DART_QA_EVAL_PROFILE", "").lower() in ("1", "true", "on"):
            # 평가 프로필(배포 env에서 켠다): HCX-005 실연결·코드 식별자 없이는 ready가 아니다
            # (검수 3·4차 발견 — 대회 규정 'HCX만'을 런타임에서 강제). 로컬 테스트 기본값은 off.
            if getattr(llm, "provider", None) != "clova" or getattr(llm, "model", None) != "HCX-005":
                ready, profile_error = False, f"eval_profile: LLM이 HCX-005가 아니다 ({getattr(llm, 'provider', None)}:{getattr(llm, 'model', None)})"
            elif not _get_code_sha():
                ready, profile_error = False, "eval_profile: code_sha 없음 (DART_QA_CODE_SHA 설정 필요)"
        if ready and _arm_pins.get("arm_ready") is False:
            # A 경로: text_resolver 미주입 등 — 백엔드가 스스로 준비 안 됐다고 하면 ready가 아니다.
            ready = False
            profile_error = ("retrieval_backend not ready: "
                             + (arm_a_serving_bridge.TextResolutionRequired.code
                                if not _arm_pins.get("text_resolver_configured")
                                else "arm_ready=False"))
        return {
            "ready": ready,
            **({"error": profile_error} if profile_error else {}),
            "mode": "real",
            "retrieval_backend": _resolve_backend(),
            # env 문자열이 아니라 실제 구성된 arm(검수 발견 3) — 주입 테스트 등 arm 미구성 시 기본값.
            "arm": _arm or os.environ.get("DART_QA_ARM", DEFAULT_ARM),
            "n_docs": len(store) if store is not None else None,
            "llm_provider": getattr(llm, "provider", None),
            "llm_model": getattr(llm, "model", None),
            "llm_enabled": llm is not None,
            "pins": {**pins, **_arm_pins,
                     "prompt_version": qa_agent.PROMPT_VERSION,
                     "prompt_fingerprint": qa_agent.prompt_fingerprint(),
                     # FC 경로(주 경로) 지문 — 캐시 키가 pins 해시라, FC 프롬프트를 바꾸면
                     # 재배포 시 캐시가 자동 무효화된다(검수 발견 10: 종전엔 수동 삭제 필요).
                     "fc_prompt_version": grounded_answer.FC_PROMPT_VERSION,
                     "fc_fingerprint": grounded_answer.fc_fingerprint(),
                     # 모델·코드가 바뀌면 캐시가 자동 무효화되도록 pin에 넣는다(검수 3차 발견 8).
                     "llm": f"{getattr(llm, 'provider', '')}:{getattr(llm, 'model', '')}",
                     # 검색 동작을 바꾸는 플래그는 캐시 키에 들어가야 한다(재검수 3차 HIGH 3:
                     # 같은 code SHA에서 OFF↔ON 전환 시 이전 모드 캐시 재사용 차단).
                     "late_expansion": qa_agent.late_expansion_enabled(),
                     "expanded_retrieval": qa_agent.expanded_retrieval_enabled(),
                     "code_sha": _get_code_sha(),
                     "corpus_cutoff": policy_gate.CORPUS_CUTOFF},
        }
    except Exception as exc:  # noqa: BLE001
        logger.error("readiness failed: %s", exc)
        return {"ready": False, "mode": "degraded", "error": f"{type(exc).__name__}: {exc}", "pins": {}}
