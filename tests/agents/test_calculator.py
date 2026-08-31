"""결정론적 계산기 — 산술은 코드가 한다(LLM 아님).

Q12 실측 배경: HyperCLOVA X가 올바른 원문 행 4개를 인용하고도 증가율을
2.95% / 46.67%로 계산했다. 정답은 3.145% / 46.276%다(팀 Gold의 rounding=3 기준).
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from dart_detective.agents import calculator

# Q12의 실제 값
REV_2023, REV_2025 = "59,254,361", "61,118,127"
OP_2023, OP_2025 = "2,295,284", "3,357,456"


def values(**kw) -> dict:
    return dict(kw)


# ---------- Q12 단위 테스트 ----------

def test_q12_revenue_rate():
    got = calculator.compute("매출액", "매출액_2023", REV_2023, "매출액_2025", REV_2025)
    rate = next(d for d in got if d.kind == "increase_rate")
    assert rate.value == "3.145"         # LLM이 낸 2.95가 아니다
    assert rate.unit == "%"
    assert rate.source_slots == ("매출액_2023", "매출액_2025")
    assert rate.source_values == (REV_2023, REV_2025)


def test_q12_operating_profit_rate():
    got = calculator.compute("영업이익", "영업이익_2023", OP_2023, "영업이익_2025", OP_2025)
    rate = next(d for d in got if d.kind == "increase_rate")
    assert rate.value == "46.276"        # LLM이 낸 46.67이 아니다


def test_q12_rejects_llm_numbers():
    """LLM이 만든 값은 계산 결과로 인정되지 않는다."""
    got = calculator.compute("매출액", "매출액_2023", REV_2023, "매출액_2025", REV_2025)
    allowed = calculator.allowed_numbers(got)
    assert "3.145" in allowed
    assert "2.95" not in allowed
    assert "46.67" not in allowed


def test_increase_amount_is_reported_too():
    got = calculator.compute("매출액", "매출액_2023", REV_2023, "매출액_2025", REV_2025)
    amount = next(d for d in got if d.kind == "increase_amount")
    assert amount.value == "1,863,766"
    assert amount.formula == "61,118,127 - 59,254,361"


# ---------- 정상 케이스 ----------

def test_decrease_rate_is_negative():
    got = calculator.compute("매출액", "매출액_2023", "1,000", "매출액_2025", "800")
    rate = next(d for d in got if d.kind == "increase_rate")
    amount = next(d for d in got if d.kind == "increase_amount")
    assert rate.value == "-20.000"
    assert amount.value == "-200"


def test_parenthesis_is_read_as_negative():
    assert calculator.parse_number("(40,391)") == Decimal("-40391")
    assert calculator.parse_number("1,461,202") == Decimal("1461202")
    assert calculator.parse_number("해당사항 없음") is None


def test_rounding_is_half_up_and_fixed_to_two_decimals():
    got = calculator.compute("x", "x_2023", "10000", "x_2025", "10125")
    assert next(d for d in got if d.kind == "increase_rate").value == "1.250"


# ---------- 예외 — 계산하지 않는다 ----------

def test_zero_base_is_not_calculated():
    assert calculator.compute("x", "x_2023", "0", "x_2025", "100") == []


def test_missing_slot_is_not_calculated():
    got = calculator.derive("2023년 대비 2025년 매출액 증가율은?",
                            ("매출액_2023", "매출액_2025"),
                            {"매출액_2023": REV_2023})      # 2025 값 없음
    assert got == []


def test_uncertain_column_means_no_value_means_no_calculation():
    """열을 확정하지 못하면 selector가 값을 안 넘긴다 → 계산하지 않는다."""
    assert calculator.derive("증가율은?", ("매출액_2023", "매출액_2025"), {}) == []


def test_metrics_are_not_mixed():
    got = calculator.derive("2023년 대비 2025년 증감률은?",
                            ("매출액_2023", "영업이익_2025"),
                            {"매출액_2023": REV_2023, "영업이익_2025": OP_2025})
    assert got == []                     # 지표가 서로 달라 짝이 안 맞는다


def test_mixed_units_are_not_calculated():
    got = calculator.derive(
        "2023년 대비 2025년 매출액 증가율은?",
        ("매출액_2023", "매출액_2025"),
        {"매출액_2023": "1,000", "매출액_2025": "2,000"},
        {"매출액_2023": "매출액 | 1,000 (단위: 백만원)",
         "매출액_2025": "매출액 | 2,000 (단위: 원)"})
    assert got == []


def test_non_comparison_question_is_not_calculated():
    got = calculator.derive("2025년 매출액은 얼마인가?",
                            ("매출액_2023", "매출액_2025"),
                            {"매출액_2023": REV_2023, "매출액_2025": REV_2025})
    assert got == []


@pytest.mark.parametrize("question,expected", [
    ("2023년 대비 2025년 매출액 증가율은?", True),
    ("2023년과 2025년 영업이익이 어떻게 변했는지 설명해줘", True),
    ("두 기업의 매출액 차이는?", True),
    ("2025년 자기주식 소각 주식수는?", False),
])
def test_comparison_question_detection(question, expected):
    assert calculator.is_comparison_question(question) is expected


def test_plan_comparisons_needs_two_years_of_same_metric():
    q = "2023년 대비 2025년 증가율은?"
    assert calculator.plan_comparisons(q, ("매출액_2023", "매출액_2025")) == [
        ("매출액", 2023, 2025)]
    assert calculator.plan_comparisons(q, ("매출액_2025",)) == []
