"""tables.py(당기/전기·제N기 열 매핑) + FC 기간-열 결합 게이트 — 검수 발견 1 재현 잠금."""
from __future__ import annotations

from dart_detective.agents import tables
from dart_detective import grounded_answer


# ---------- tables: 열 매핑 ----------

def test_year_header_mapping_unchanged():
    lines = ["구분 | 제 49 기 2025.01.01 부터 | 제 48 기 2024.01.01 부터",
             "매출액 | 100 | 90"]
    assert tables.period_columns_of_lines(lines) == {2025: 0, 2024: 1}


def test_relative_header_needs_base_year():
    lines = ["구분 | 당기 | 전기", "매출액 | 100 | 90"]
    assert tables.period_columns_of_lines(lines) == {}
    assert tables.period_columns_of_lines(lines, base_year=2024) == {2024: 0, 2023: 1}


def test_relative_header_dangimal():
    lines = ["구분 | 당기말 | 전기말", "자산총계 | 500 | 400"]
    assert tables.period_columns_of_lines(lines, base_year=2025) == {2025: 0, 2024: 1}


def test_ordinal_header_with_base_year():
    lines = ["구분 | 제 49 기 | 제 48 기 | 제 47 기", "매출액 | 100 | 90 | 80"]
    assert tables.period_columns_of_lines(lines, base_year=2025) == {2025: 0, 2024: 1, 2023: 2}


def test_row_label_danggi_is_not_header():
    # "당기순이익"은 행 레이블 — 머리글 셀로 오인하면 안 된다.
    lines = ["구분 | 금액", "당기순이익 | 100"]
    assert tables.period_columns_of_lines(lines, base_year=2024) == {}


# ---------- FC 게이트: 기간-열 결합 ----------

# 맨숫자 머리글("2024 | 2023")은 데이터 행과 구분이 안 돼 의도적으로 안 읽는다(보수 설계).
_CHUNK = "구분 | 2024년 | 2023년\n매출액 | 100 | 90"
_DOC = "d1"


def _validate(claim):
    squashed = {_DOC: grounded_answer._squash(_CHUNK)}
    return grounded_answer.validate_claim(
        claim, squashed, {_DOC: {"base_year": 2024}}, set(),
        doc_chunks={_DOC: [_CHUNK]})


def test_column_mismatch_drops_swapped_claim():
    # 검수 재현: 2023년 열의 90을 인용하고 "2024년 매출액은 90"이라 주장 — 종전엔 SUPPORTED.
    ok, fails = _validate({"text": "2024년 매출액은 90이다", "value": "90",
                           "period": "2024", "doc_id": _DOC, "quote": "매출액 | 100 | 90"})
    assert not ok
    assert any(f.startswith("period_bound:column_mismatch:2024") for f in fails)


def test_correct_column_passes():
    ok, fails = _validate({"text": "2024년 매출액은 100이다", "value": "100",
                           "period": "2024", "doc_id": _DOC, "quote": "매출액 | 100 | 90"})
    assert ok, fails


def test_single_year_chunk_skips_column_check():
    chunk = "매출액 | 90\n(2023년 기준)"
    squashed = {_DOC: grounded_answer._squash(chunk)}
    ok, fails = grounded_answer.validate_claim(
        {"text": "2023년 매출액은 90이다", "value": "90", "period": "2023",
         "doc_id": _DOC, "quote": "매출액 | 90"},
        squashed, {_DOC: {}}, set(), doc_chunks={_DOC: [chunk]})
    assert ok, fails


def test_two_year_comparison_text_not_dropped():
    # 비교 문장은 값의 연도 소속을 특정할 수 없다 — period 없으면 열 대조를 걸지 않는다.
    ok, fails = _validate({"text": "2024년 매출 100은 2023년 90보다 크다", "value": "100",
                           "period": None, "doc_id": _DOC, "quote": "매출액 | 100 | 90"})
    assert ok, fails


def test_relative_header_swap_caught_with_base_year():
    chunk = "구분 | 당기 | 전기\n영업이익 | 70 | 60\n(제49기 2024년, 제48기 2023년)"
    squashed = {_DOC: grounded_answer._squash(chunk)}
    ok, fails = grounded_answer.validate_claim(
        {"text": "2024년 영업이익은 60이다", "value": "60", "period": "2024",
         "doc_id": _DOC, "quote": "영업이익 | 70 | 60"},
        squashed, {_DOC: {"base_year": 2024}}, set(), doc_chunks={_DOC: [chunk]})
    assert not ok
    assert any("column_mismatch" in f for f in fails)
