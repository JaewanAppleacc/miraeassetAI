"""답변을 얼마나 믿을 수 있는지 사용자에게 알린다.

수상작(Fin Guard AI)이 "신뢰도 0~100%"를 보여준 자리다. 다만 우리는 모델 확률을
쓰지 않는다 — 우리에게 그런 값이 없고, 없는 걸 만들어 보여주는 건 이 시스템이
지키려는 원칙과 반대다. 대신 **이미 측정한 사실들**로 규칙 점수를 만든다:

    검증 결과 · 근거 개수 · 코드 계산 여부 · 기업 경고 · LLM 폐기 여부

각 항목이 점수를 얼마나 올리고 내렸는지 `reasons`에 남긴다. 숫자만 보여주면
"왜 60%인가"에 답할 수 없기 때문이다.
"""
from __future__ import annotations

from typing import Any, Mapping, Sequence

# 검증 결과가 출발점이다. 원문 대조를 통과했는지가 가장 큰 신호다.
BASE_BY_STATUS: dict[str, int] = {
    "SUPPORTED": 80,
    "PARTIALLY_SUPPORTED": 55,
    "UNSUPPORTED": 20,
}
UNKNOWN_BASE = 40

EVIDENCE_BONUS = 5          # 근거 줄 하나당(최대 3줄까지만 센다)
MAX_EVIDENCE_BONUS = 15
DERIVED_BONUS = 10          # 코드가 계산한 값이 있다 — LLM 산술이 아니다
CORP_WARNING_PENALTY = 25   # 기업을 특정 못 했거나 근거의 회사가 다르다
DEGRADED_PENALTY = 10       # LLM 답을 버리고 원문 발췌로 대체했다
NO_EVIDENCE_PENALTY = 40    # 근거가 아예 없다
# 발췌 답변은 원문 그대로라 검증을 당연히 통과한다 — 검증 통과가 곧 "질문에 답했다"는
# 뜻이 아니다. 실측에서 이 감점이 없으니 발췌 답변도 95점이 나왔다(변별력 없음).
EXCERPT_PENALTY = 25
UNFILLED_SLOT_PENALTY = 10  # 질문이 요구한 항목 자리를 못 채운 만큼


def _unfilled_slots(slots: Sequence[str], filled: Sequence[str]) -> list[str]:
    want = [s for s in slots if s != "answer"]
    return [s for s in want if s not in set(filled)]

HIGH, MEDIUM = 75, 50


def level_of(score: int) -> str:
    if score >= HIGH:
        return "높음"
    if score >= MEDIUM:
        return "보통"
    return "낮음"


def assess(*, validation: Mapping[str, Any], n_evidence: int,
           n_derived: int = 0, warnings: Sequence[str] = (),
           llm: Mapping[str, Any] | None = None,
           slots: Sequence[str] = (), filled_slots: Sequence[str] = ()) -> dict[str, Any]:
    """0~100 점수와 그 이유. 확률이 아니라 규칙 점수다."""
    llm = llm or {}
    status = str(validation.get("status") or "")
    score = BASE_BY_STATUS.get(status, UNKNOWN_BASE)
    reasons: list[str] = [f"검증 {status or '미실행'} (기준 {score})"]

    if n_evidence:
        bonus = min(n_evidence, 3) * EVIDENCE_BONUS
        bonus = min(bonus, MAX_EVIDENCE_BONUS)
        score += bonus
        reasons.append(f"원문 근거 {n_evidence}줄 (+{bonus})")
    else:
        score -= NO_EVIDENCE_PENALTY
        reasons.append(f"원문 근거 없음 (-{NO_EVIDENCE_PENALTY})")

    if n_derived:
        score += DERIVED_BONUS
        reasons.append(f"코드가 계산한 값 {n_derived}건 (+{DERIVED_BONUS})")

    if warnings:
        score -= CORP_WARNING_PENALTY
        reasons.append(f"기업 경고 {','.join(warnings)} (-{CORP_WARNING_PENALTY})")

    if llm.get("degraded"):
        score -= DEGRADED_PENALTY
        reasons.append(f"LLM 답변을 근거 미달로 폐기 (-{DEGRADED_PENALTY})")

    if not llm.get("used") and not n_derived:
        score -= EXCERPT_PENALTY
        reasons.append(f"답변이 원문 발췌 나열 (-{EXCERPT_PENALTY})")

    missing = _unfilled_slots(slots, filled_slots)
    if missing:
        penalty = min(len(missing) * UNFILLED_SLOT_PENALTY, 30)
        score -= penalty
        reasons.append(f"못 채운 항목 {','.join(missing)} (-{penalty})")

    score = max(0, min(100, score))
    return {"score": score, "level": level_of(score), "reasons": reasons}
