"""공시 항목 슬롯 + 단위 자릿수 검사.

배경: 수상작(Fin Guard AI)이 "정기공시 28개 항목 구조화"로 얻은 효과를 우리 데이터에
맞춰 가져온 것이 항목 슬롯이다. 우리 코퍼스의 계약·투자·해지 공시는 서식이 정해져
있어 항목명이 원문에 그대로 적힌다.

단위 검사는 실측(N11)에서 나온 구멍이다 — 원문 "19,300,000,000"을 답변이
"19,300억 원"으로 옮겼는데 숫자 검사만으로는 통과했다.
"""
from __future__ import annotations

import pytest

from dart_corpus.retrieval.conditions import QueryConditions
from dart_detective.agents import qa_agent, validator

SOURCES = [{"document_id": "d1",
            "text": "2. 해지내역 | 해지금액(원) | 19,300,000,000\n최근매출액(원) | 381,400,000,000"}]


def conditions(years=()) -> QueryConditions:
    return QueryConditions(corps=frozenset(), years=frozenset(years))


# ---------- 공시 항목 슬롯 ----------

@pytest.mark.parametrize("question,expected", [
    ("한미반도체 7공장 투자금액은 얼마인가?", ("투자금액", "answer")),
    ("계약 해지의 해지금액과 해지일자는?", ("해지금액", "해지일자", "answer")),
    ("투자금액과 자기자본 대비 비율은?", ("투자금액", "자기자본대비", "answer")),
    ("계약기간 종료일은 언제인가?", ("종료일", "answer")),
])
def test_disclosure_items_become_slots(question, expected):
    """항목 자리 뒤에 자유 자리가 하나 붙는다 — 항목명으로 말하지 않은 것을 받는다."""
    assert qa_agent.plan_slots(question, conditions()) == expected


def test_financial_metrics_still_win():
    """재무 질문은 지표×연도 그대로 — 기존 동작."""
    slots = qa_agent.plan_slots("2023년과 2025년 매출액은?", conditions([2023, 2025]))
    assert slots == ("매출액_2023", "매출액_2025")


def test_question_without_items_falls_back_to_single_slot():
    assert qa_agent.plan_slots("이 회사 사업은 어떤가?", conditions()) == ("answer",)


def test_items_are_not_guessed():
    """사전에 없는 표현을 추측해서 항목으로 만들지 않는다."""
    assert qa_agent.plan_slots("배당 성향이 어떻게 되나?", conditions()) == ("answer",)


# ---------- 단위 자릿수 ----------

def test_scale_error_is_caught():
    """원문 193억(19,300,000,000원)을 19,300억으로 쓴 경우."""
    check = validator.validate("해지금액은 19,300억 원입니다.", [], SOURCES)
    assert check["status"] == "UNSUPPORTED"
    unit = next(c for c in check["checks"] if c["check"] == "units_consistent")
    assert unit["mismatched"]


def test_correct_scale_passes():
    check = validator.validate("해지금액은 193억 원입니다.", [], SOURCES)
    unit = next(c for c in check["checks"] if c["check"] == "units_consistent")
    assert unit["passed"]


def test_plain_number_without_unit_is_untouched():
    check = validator.validate("해지금액은 19,300,000,000원입니다.", [], SOURCES)
    unit = next(c for c in check["checks"] if c["check"] == "units_consistent")
    assert unit["passed"]


def test_rounded_expression_is_allowed():
    """'약 3,814억원' — 381,400,000,000원의 반올림 표현."""
    check = validator.validate("최근매출액은 약 3,814억원입니다.", [], SOURCES)
    unit = next(c for c in check["checks"] if c["check"] == "units_consistent")
    assert unit["passed"]


def test_verbatim_unit_text_in_source_is_allowed():
    sources = [{"document_id": "d1", "text": "투자금액은 800억원 규모다."}]
    check = validator.validate("투자금액은 800억원이다.", [], sources)
    unit = next(c for c in check["checks"] if c["check"] == "units_consistent")
    assert unit["passed"]


def test_derived_value_with_unit_is_allowed():
    check = validator.validate("증감액은 1,930,000,000원이며 약 19억원이다.", [], SOURCES,
                               derived=["1,930,000,000"])
    unit = next(c for c in check["checks"] if c["check"] == "units_consistent")
    assert unit["passed"]
