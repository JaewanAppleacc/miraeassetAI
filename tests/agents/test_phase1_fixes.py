"""Phase1 DEV_TUNE run B 재채점에서 나온 수리들.

- 인용 document_id에 붙은 대괄호를 벗긴다(값은 맞는데 "문서 불일치"로 폐기되던 것).
- 대량보유 직전/이번 쌍 계산은 "변화"라는 말에도 깬다.
- 원 단위 증감액은 백만원 환산도 같이 낸다(팀 Gold가 백만원으로 적는 문항).
"""
from __future__ import annotations

from decimal import Decimal

from dart_detective.agents import calculator, qa_agent, validator


# ---------- 인용 doc_id 정리 ----------

def test_bracketed_document_id_is_stripped():
    got = qa_agent.normalize_citations([
        {"document_id": "[exchange_20241231800103]", "quote_or_fact": "계약상대 | 현대자동차(주)"},
        {"document_id": " (major_1) ", "quote_or_fact": "x"},
    ])
    assert [c["document_id"] for c in got] == ["exchange_20241231800103", "major_1"]


def test_bracket_fix_makes_grounded_quote_pass():
    sources = [{"document_id": "exchange_1", "text": "계약상대 | 현대자동차(주)\n계약금액(원) | 3,365,500,000,000"}]
    cites = qa_agent.normalize_citations(
        [{"document_id": "[exchange_1]", "quote_or_fact": "계약금액(원) | 3,365,500,000,000"}])
    check = validator.validate("계약금액: 3,365,500,000,000원", cites, sources)
    assert check["status"] != "UNSUPPORTED"


def test_document_id_is_not_guessed():
    """벗기는 건 괄호뿐 — 틀린 id는 그대로 틀린 채 남아 검증에서 잡혀야 한다."""
    got = qa_agent.normalize_citations([{"document_id": "[exchange_999]", "quote_or_fact": "x"}])
    assert got[0]["document_id"] == "exchange_999"


# ---------- 표 인용 셀 단위 대조 ----------

DOC = [{"document_id": "ex1", "text": "5. 계약기간 | 시작일 | 2025-01-01\n종료일 | 2029-12-31\n계약금액(원) | 100"}]


def test_joined_table_row_quote_passes_softly():
    cites = [{"document_id": "ex1", "quote_or_fact": "계약기간 | 종료일 | 2029-12-31"}]
    check = validator.validate("종료일: 2029-12-31", cites, DOC)
    q = [c for c in check["checks"] if c["check"] == "quote_grounded"][0]
    assert q["passed"] and "셀 단위" in q["note"]
    assert check["status"] == "PARTIALLY_SUPPORTED"


def test_invented_cell_still_fails():
    cites = [{"document_id": "ex1", "quote_or_fact": "계약기간 | 종료일 | 2030-12-31"}]
    assert validator.validate("종료일: 2030-12-31", cites, DOC)["status"] == "UNSUPPORTED"


def test_paraphrase_without_cells_still_fails():
    cites = [{"document_id": "ex1", "quote_or_fact": "계약은 2029년 말에 끝난다"}]
    assert validator.validate("계약금액: 100", cites, DOC)["status"] == "UNSUPPORTED"


def test_cells_found_only_in_other_doc_is_soft():
    other = DOC + [{"document_id": "ex2", "text": "무관"}]
    cites = [{"document_id": "ex2", "quote_or_fact": "계약기간 | 종료일 | 2029-12-31"}]
    check = validator.validate("종료일: 2029-12-31", cites, other)
    assert check["status"] == "PARTIALLY_SUPPORTED"


# ---------- 대량보유 '변화' ----------

LINES = ["직전 보고서 | 14,456,491 | 5.06", "이번 보고서 | 14,023,639 | 4.91"]


def test_pair_diff_wakes_on_byeonhwa():
    got = calculator.report_pair_diffs("직전보고서 대비 이번보고서의 보유주식수·비율 변화는?", LINES)
    values = {d.value for d in got}
    assert "-432,852" in values


def test_pair_diff_still_silent_without_change_words():
    assert calculator.report_pair_diffs("이번 보고서의 보유주식수는?", LINES) == []


# ---------- 백만원 환산 ----------

def test_won_amounts_get_million_conversion():
    got = calculator.compute("매출액", "매출액_2023", "1,683,723,394,359",
                             "매출액_2025", "1,697,877,264,205", unit="원")
    m = [d for d in got if d.kind == "amount_million"]
    assert len(m) == 1
    assert m[0].value == "14,154"                       # 14,153,869,846 / 1e6 -> 반올림
    assert m[0].source_values == ("1,683,723", "1,697,877")
    assert "14,154" in calculator.describe(got)
    assert "1683723" in calculator.allowed_numbers(got)  # 환산값도 검증기 허용 목록에


def test_million_tables_are_not_converted_again():
    """이미 백만원 단위인 표(값이 작음)는 다시 나누지 않는다."""
    got = calculator.compute("매출액", "매출액_2023", "53,038", "매출액_2025", "32,978", unit="")
    assert not [d for d in got if d.kind == "amount_million"]
    assert {d.value for d in got if d.kind == "increase_amount"} == {"-20,060"}


def test_thousand_won_tables_are_not_converted():
    got = calculator.compute("매출액", "a_2023", "15,258,135", "a_2025", "34,123,110", unit="천원")
    assert not [d for d in got if d.kind == "amount_million"]


def test_million_rounding_is_half_up():
    got = calculator.million_conversion("x", Decimal("10500000"), Decimal("21500000"),
                                        Decimal("11000000"), "원", ("a", "b"))
    assert got[0].source_values == ("11", "22") and got[0].value == "11"
