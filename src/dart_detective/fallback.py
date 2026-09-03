"""⑨ 3단 폴백 — v4 §11: ①수리 재생성(조건부·기본 OFF) → ②코드 템플릿 → ③원문 발췌.

발동 조건: 최종 답변의 검증이 UNSUPPORTED일 때만(qa_agent 끝에서 부른다). 평상시 답변
(계산기·템플릿·LLM 통과분)은 이 모듈을 지나가지 않는다 — 폴백은 안전망이지 기본 경로가 아니다.

각 단계는 만든 답을 validator로 재검증하고, UNSUPPORTED가 아니면 채택한다(v4: "전 단 게이트 재통과").
어느 단계가 답했는지 stage로 돌려준다 — answer_api가 stage != ""이면 캐시에서 제외한다(v4 §14).

① 수리: 기본 OFF(env DART_QA_REPAIR=on일 때만). 같은 근거로 1회 재생성 — 새 evidence·숫자·날짜
   생성 금지를 프롬프트로 지시하고, 결과는 다시 게이트를 통과해야 한다. 게이트 미통과 시 ②로.
② 템플릿: qa_agent.fallback_answer + calculator.describe — 값·인용 전부 원문 그대로라 사실상 항상
   grounded다. (합성층 이식 전까지의 템플릿 구현이다 — v4 §15 "합성 이식"은 조건부 게이트 뒤.)
③ 발췌: 요구 slot의 근거 줄만, 문서당 3줄 · 총 12줄(v4 §11). 유보(WITHHELD) 문항은 여기 오기 전에
   조기 종료되므로 자연히 제외된다.
셋 다 실패하면(이론상 발췌는 원문 그대로라 실패하지 않는다) 안전 문구를 돌려준다.
"""
from __future__ import annotations

import os
from typing import Any, Mapping, Sequence

from .agents import calculator, validator

MAX_LINES_PER_DOC = 3
MAX_LINES_TOTAL = 12

REPAIR_SYSTEM_SUFFIX = (
    "\n\n[수리 지시] 직전 답변이 검증에 실패했다. 같은 발췌 근거만 사용해 다시 답하라. "
    "새 근거·새 숫자·새 날짜를 추가하는 것은 금지다. 발췌에 없는 값은 '확인 못 함'으로 적어라.")

SAFE_ANSWER = "검색된 근거로는 검증을 통과하는 답변을 만들지 못했다. 질문을 좁히거나 기간·기업 조건을 명시해야 한다."
SAFE_UNCERTAINTY = "생성 답변이 근거 검증(원문 대조)을 통과하지 못해 폐기했다."


def repair_enabled() -> bool:
    return os.environ.get("DART_QA_REPAIR", "").lower() in {"on", "1", "true"}


def excerpt_answer(matches: Sequence[Any]) -> tuple[str, str]:
    """③ 원문 발췌 — 요구 slot 줄만. 문서당 MAX_LINES_PER_DOC줄 · 총 MAX_LINES_TOTAL줄."""
    per_doc: dict[str, int] = {}
    lines: list[str] = []
    for m in matches:
        text = (getattr(m, "evidence_text", "") or "").strip()
        doc_id = getattr(m, "doc_id", "") or ""
        if not text:
            continue
        if per_doc.get(doc_id, 0) >= MAX_LINES_PER_DOC or len(lines) >= MAX_LINES_TOTAL:
            continue
        per_doc[doc_id] = per_doc.get(doc_id, 0) + 1
        lines.append(f"- {text}")
    if not lines:
        return SAFE_ANSWER, SAFE_UNCERTAINTY
    return ("질문이 요구한 항목의 공시 원문 발췌는 다음과 같다.\n" + "\n".join(lines),
            "생성 답변이 검증을 통과하지 못해 원문 발췌로 대체했다. 출처는 evidence에 있다.")


def resolve(*, matches: Sequence[Any], sources: list[dict[str, Any]],
            derived: Sequence[Any] = (), llm: Any = None, system_prompt: str = "",
            user_prompt: str = "", template: tuple[str, str] | None = None,
            answer_schema: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """UNSUPPORTED 답변을 대체할 답을 단계 순서대로 찾는다.

    반환: {"answer", "uncertainty", "stage", "validation", "attempts": [...]}.
    template: 이미 만들어 둔 (답변, 불확실성) — qa_agent의 기본 발췌/계산 답. 그 답이 방금
    UNSUPPORTED였다면 넘기지 말 것(중복 검증 방지). None이면 여기서 새로 만든다.
    """
    derived_numbers = calculator.allowed_numbers(list(derived))
    citations: list[dict[str, Any]] = []          # 폴백 답변은 인용을 답 본문에 담는다 — 별도 인용 없음
    attempts: list[dict[str, Any]] = []

    def gate(stage: str, answer: str, uncertainty: str) -> dict[str, Any] | None:
        check = validator.validate(answer, citations, sources, derived=derived_numbers)
        attempts.append({"stage": stage, "status": check["status"]})
        if check["status"] != "UNSUPPORTED":
            return {"answer": answer, "uncertainty": uncertainty, "stage": stage,
                    "validation": check, "attempts": attempts}
        return None

    # ① 수리 재생성 (기본 OFF · 1회)
    if repair_enabled() and llm is not None and user_prompt and answer_schema is not None:
        try:
            result = llm.complete_json(system_prompt + REPAIR_SYSTEM_SUFFIX, user_prompt,
                                       dict(answer_schema))
            repaired = str((result.data or {}).get("answer") or "")
            if repaired:
                out = gate("repair", repaired, str((result.data or {}).get("uncertainty") or ""))
                if out:
                    return out
        except Exception:  # noqa: BLE001 — 수리 실패는 다음 단계로 (v4: 즉시 템플릿)
            attempts.append({"stage": "repair", "status": "ERROR"})

    # ② 코드 템플릿
    if template is not None:
        out = gate("template", template[0], template[1])
        if out:
            return out

    # ③ 원문 발췌
    answer, uncertainty = excerpt_answer(matches)
    out = gate("excerpt", answer, uncertainty)
    if out:
        return out

    check = validator.validate(SAFE_ANSWER, [], sources, derived=derived_numbers)
    attempts.append({"stage": "safe", "status": check["status"]})
    return {"answer": SAFE_ANSWER, "uncertainty": SAFE_UNCERTAINTY, "stage": "safe",
            "validation": check, "attempts": attempts}
