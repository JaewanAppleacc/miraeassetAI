"""Evidence Validation — 생성된 주장과 원문 대조."""
from __future__ import annotations

from dart_detective.agents import validator

SOURCES = [{
    "document_id": "D02",
    "document_date": "2023-05-15",
    "title": "분기보고서 (2023.03)",
    "text": "현금및현금성자산 | 239,036,839,774 | 320,363,496,754\n"
            "부채총계 | 2,581,553,023,711",
    "score": 10.0,
}]


def _v(answer: str, citations=None):
    return validator.validate(answer, citations or [], SOURCES)


def test_verbatim_quote_and_number_is_supported():
    result = _v(
        "현금및현금성자산은 239,036,839,774원이다.",
        [{"document_id": "D02", "quote_or_fact": "현금및현금성자산 | 239,036,839,774 | 320,363,496,754"}],
    )
    assert result["status"] == "SUPPORTED"


def test_judgment_word_without_source_is_partially_supported():
    """공시: 현금성자산 2,390억 / 생성: '회사는 현금이 부족하다' -> unsupported inference."""
    result = _v("회사는 현금이 부족하다.")
    assert result["status"] == "PARTIALLY_SUPPORTED"
    check = next(c for c in result["checks"] if c["check"] == "no_unsupported_inference")
    assert "부족" in check["inferences"]


def test_fabricated_number_is_unsupported():
    result = _v("현금및현금성자산은 999,999,999,999원이다.")
    assert result["status"] == "UNSUPPORTED"
    check = next(c for c in result["checks"] if c["check"] == "numbers_grounded")
    assert check["fabricated"] == ["999999999999"]


def test_quote_not_in_source_is_unsupported():
    result = _v("자료에 따르면 그렇다.",
                [{"document_id": "D02", "quote_or_fact": "이 문장은 어떤 공시에도 없다"}])
    assert result["status"] == "UNSUPPORTED"


def test_quote_attributed_to_wrong_document_is_partial():
    sources = SOURCES + [{
        "document_id": "D01", "document_date": "2023-05-23", "title": "신규시설투자등",
        "text": "2. 투자내역 | 투자금액(원) | 473,200,000,000", "score": 9.0,
    }]
    result = validator.validate(
        "투자금액은 473,200,000,000원이다.",
        [{"document_id": "D02", "quote_or_fact": "2. 투자내역 | 투자금액(원) | 473,200,000,000"}],
        sources,
    )
    assert result["status"] == "PARTIALLY_SUPPORTED"


def test_unit_conversion_of_won_amount_is_allowed():
    result = validator.validate(
        "투자금액은 약 4,732억원이다.", [],
        [{"document_id": "D01", "document_date": "2023-05-23", "title": "t",
          "text": "2. 투자내역 | 투자금액(원) | 473,200,000,000", "score": 1.0}],
    )
    assert result["status"] == "SUPPORTED"


def test_unsupported_year_is_flagged():
    result = _v("2026년 기준 현금및현금성자산은 239,036,839,774원이다.")
    assert result["status"] == "PARTIALLY_SUPPORTED"
    check = next(c for c in result["checks"] if c["check"] == "period_grounded")
    assert "2026" in check["unsupported_years"]


# ---------- edge case ----------

def test_no_sources_makes_any_number_unsupported():
    """근거를 하나도 못 찾았는데 숫자가 있는 답이 나오면 그건 지어낸 것이다."""
    result = validator.validate("현금은 239,036,839,774원이다.", [], [])
    assert result["status"] == "UNSUPPORTED"
    assert result["n_sources"] == 0


def test_answer_without_numbers_or_judgment_is_supported():
    assert _v("공시에 현금및현금성자산 항목이 있다.")["status"] == "SUPPORTED"


def test_empty_quote_is_treated_as_ungrounded():
    result = _v("자료에 따르면 그렇다.", [{"document_id": "D02", "quote_or_fact": ""}])
    assert result["status"] == "UNSUPPORTED"


def test_quote_matches_across_whitespace_differences():
    """청크는 줄바꿈/공백이 원문과 다를 수 있다 — 공백만 다른 인용은 통과해야 한다."""
    result = _v(
        "현금및현금성자산 항목이 있다.",
        [{"document_id": "D02",
          "quote_or_fact": "현금및현금성자산   |  239,036,839,774 |   320,363,496,754"}],
    )
    assert result["status"] == "SUPPORTED"


def test_truncated_number_is_fabrication():
    """239,036,839,774의 앞자리만 떼어 쓴 값은 원문에 없는 수치로 잡힌다."""
    result = _v("현금은 239,036,839원이다.")
    assert result["status"] == "UNSUPPORTED"
    check = next(c for c in result["checks"] if c["check"] == "numbers_grounded")
    assert check["fabricated"] == ["239036839"]


def test_unit_divisor_values_pass_even_when_the_unit_word_is_wrong():
    """알려진 한계: 만/백만/억/조 환산값을 통째로 허용하므로,
    239,036,839,774를 '239,036원'이라 적어도(단위가 틀려도) 수치 검사는 통과한다.
    단위 오기까지 잡으려면 별도 규칙이 필요하다 — 지금은 잡지 않는다."""
    result = _v("현금은 239,036원이다.")
    assert result["status"] == "SUPPORTED"


def test_document_id_digits_in_answer_count_as_fabricated_numbers():
    """답변 본문에 doc_id를 섞으면 그 숫자열이 날조로 잡힌다 —
    그래서 Agent는 출처를 answer 문장이 아니라 evidence 구조에만 담는다."""
    result = _v("근거: periodic_20260318000826 문서를 참고했다.")
    assert result["status"] == "UNSUPPORTED"
    check = next(c for c in result["checks"] if c["check"] == "numbers_grounded")
    assert check["fabricated"] == ["20260318000826"]


def test_year_in_source_is_not_flagged():
    sources = [{"document_id": "D03", "document_date": "2025-08-14", "title": "t",
                "text": "2025년 6월 26일 10,347,131주를 소각함", "score": 1.0}]
    result = validator.validate("2025년에 10,347,131주를 소각했다.", [], sources)
    assert result["status"] == "SUPPORTED"


def test_multiple_failures_report_all_checks():
    """한 답변이 여러 규칙을 동시에 어겨도 검사 결과는 전부 남는다(진단용)."""
    result = _v("2026년 현금은 999,999,999,999원으로 부족하다.",
                [{"document_id": "D02", "quote_or_fact": "없는 인용"}])
    assert result["status"] == "UNSUPPORTED"
    failed = {c["check"] for c in result["checks"] if not c["passed"]}
    assert failed == {"quote_grounded", "numbers_grounded",
                      "period_grounded", "no_unsupported_inference"}


def test_decimal_and_percent_values_are_matched_verbatim():
    sources = [{"document_id": "D04", "document_date": "2026-03-16", "title": "t",
                "text": "해지금액(원) | 114,800,000,000 | 매출액대비(%) | 1.9", "score": 1.0}]
    ok = validator.validate("매출액대비는 1.9%다.", [], sources)
    bad = validator.validate("매출액대비는 2.1%다.", [], sources)
    assert ok["status"] == "SUPPORTED"
    assert bad["status"] == "UNSUPPORTED"


# ---------- 인용 대조는 공백만 무시한다 (Q08 실측 수리) ----------

Q08_SOURCE = [{'document_id': 'd1', 'text': '- 상기4. 5. 자기주식 취득후 전량 소각할 계획임'}]


def test_quote_with_different_spacing_is_grounded():
    '''글자는 같고 띄어쓰기만 다른 인용 — 실측에서 맞는 답이 폐기됐던 사례.'''
    from dart_detective.agents.validator import validate
    check = validate('전량 소각할 계획이다.',
                     [{'document_id': 'd1',
                       'quote_or_fact': '- 상기 4. 5. 자기주식 취득 후 전량 소각할 계획임'}],
                     Q08_SOURCE)
    quote = next(c for c in check['checks'] if c['check'] == 'quote_grounded')
    assert quote['passed']


def test_quote_with_a_changed_word_still_fails():
    from dart_detective.agents.validator import validate
    check = validate('답', [{'document_id': 'd1',
                            'quote_or_fact': '- 상기4. 5. 자기주식 처분후 전량 소각할 계획임'}],
                     Q08_SOURCE)
    assert check['status'] == 'UNSUPPORTED'


def test_quote_with_a_changed_digit_still_fails():
    from dart_detective.agents.validator import validate
    check = validate('답', [{'document_id': 'd1',
                            'quote_or_fact': '- 상기4. 6. 자기주식 취득후 전량 소각할 계획임'}],
                     Q08_SOURCE)
    assert check['status'] == 'UNSUPPORTED'


def test_wrong_document_is_still_flagged_softly():
    from dart_detective.agents.validator import validate
    check = validate('답', [{'document_id': 'd2',
                            'quote_or_fact': '상기 4. 5. 자기주식 취득 후 전량 소각할 계획임'}],
                     Q08_SOURCE)
    quote = next(c for c in check['checks'] if c['check'] == 'quote_grounded')
    assert not quote['passed']
    assert '다른 문서' in quote['note']
