"""신뢰도 점수 — 이미 측정한 사실로만 만든 규칙 점수다.

수상작이 "신뢰도 0~100%"를 보여준 자리지만, 우리는 모델 확률을 쓰지 않는다.
없는 값을 만들어 보여주는 것은 이 시스템이 지키려는 원칙과 반대다.
"""
from __future__ import annotations

from dart_detective.agents import confidence


def val(status: str) -> dict:
    return {"status": status, "checks": []}


def test_supported_answer_with_evidence_is_high():
    got = confidence.assess(validation=val("SUPPORTED"), n_evidence=3,
                            llm={"used": True})
    assert got["score"] >= confidence.HIGH
    assert got["level"] == "높음"


def test_unsupported_answer_is_low():
    got = confidence.assess(validation=val("UNSUPPORTED"), n_evidence=2)
    assert got["level"] == "낮음"


def test_no_evidence_drops_the_score_hard():
    with_ev = confidence.assess(validation=val("SUPPORTED"), n_evidence=2)
    without = confidence.assess(validation=val("SUPPORTED"), n_evidence=0)
    assert without["score"] < with_ev["score"] - 30


def test_code_calculation_raises_the_score():
    plain = confidence.assess(validation=val("SUPPORTED"), n_evidence=2,
                              llm={"used": True})
    derived = confidence.assess(validation=val("SUPPORTED"), n_evidence=2, n_derived=2,
                                llm={"used": True})
    assert derived["score"] == plain["score"] + confidence.DERIVED_BONUS


def test_corp_warning_lowers_the_score():
    clean = confidence.assess(validation=val("SUPPORTED"), n_evidence=3)
    warned = confidence.assess(validation=val("SUPPORTED"), n_evidence=3,
                               warnings=["corp_unspecified"])
    assert warned["score"] == clean["score"] - confidence.CORP_WARNING_PENALTY
    assert any("corp_unspecified" in r for r in warned["reasons"])


def test_degraded_llm_answer_lowers_the_score():
    kept = confidence.assess(validation=val("PARTIALLY_SUPPORTED"), n_evidence=2,
                             llm={"used": True})
    dropped = confidence.assess(validation=val("PARTIALLY_SUPPORTED"), n_evidence=2,
                                llm={"used": True, "degraded": True})
    assert dropped["score"] < kept["score"]


def test_score_stays_inside_the_range():
    best = confidence.assess(validation=val("SUPPORTED"), n_evidence=9, n_derived=5)
    worst = confidence.assess(validation=val("UNSUPPORTED"), n_evidence=0,
                              warnings=["corp_mismatch"], llm={"degraded": True})
    assert 0 <= worst["score"] <= best["score"] <= 100


def test_every_score_carries_its_reasons():
    got = confidence.assess(validation=val("SUPPORTED"), n_evidence=1, n_derived=1,
                            warnings=["corp_unspecified"], llm={"degraded": True})
    assert len(got["reasons"]) == 5          # 검증 · 근거 · 계산 · 경고 · 폐기
    assert all(isinstance(r, str) and r for r in got["reasons"])


def test_missing_validation_does_not_crash():
    got = confidence.assess(validation={}, n_evidence=1)
    assert 0 <= got["score"] <= 100


# ---------- 발췌 답변과 못 채운 자리 ----------

def test_excerpt_answer_scores_lower_than_a_kept_llm_answer():
    """발췌는 원문 그대로라 검증을 당연히 통과한다 — 그게 좋은 답이라는 뜻은 아니다."""
    llm_answer = confidence.assess(validation=val("SUPPORTED"), n_evidence=3,
                                   llm={"used": True})
    excerpt = confidence.assess(validation=val("SUPPORTED"), n_evidence=3,
                                llm={"used": False})
    assert excerpt["score"] == llm_answer["score"] - confidence.EXCERPT_PENALTY
    assert any("발췌" in r for r in excerpt["reasons"])


def test_code_calculation_is_not_treated_as_excerpt():
    calc = confidence.assess(validation=val("SUPPORTED"), n_evidence=2, n_derived=2,
                             llm={"used": False, "skipped": "deterministic_calculation"})
    assert not any("발췌" in r for r in calc["reasons"])


def test_unfilled_item_slots_lower_the_score():
    filled = confidence.assess(validation=val("SUPPORTED"), n_evidence=2,
                               llm={"used": True},
                               slots=["계약금액", "해지일자", "answer"],
                               filled_slots=["계약금액", "해지일자"])
    missing = confidence.assess(validation=val("SUPPORTED"), n_evidence=2,
                                llm={"used": True},
                                slots=["계약금액", "해지일자", "answer"],
                                filled_slots=["계약금액"])
    assert missing["score"] == filled["score"] - confidence.UNFILLED_SLOT_PENALTY
    assert any("해지일자" in r for r in missing["reasons"])


def test_free_slot_alone_is_not_counted_as_missing():
    got = confidence.assess(validation=val("SUPPORTED"), n_evidence=1,
                            llm={"used": True}, slots=["answer"], filled_slots=[])
    assert not any("못 채운" in r for r in got["reasons"])
