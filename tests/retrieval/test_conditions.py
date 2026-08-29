"""질문 -> 검색 조건 추출 테스트.

실제 코퍼스 없이 돈다. 사전은 universe.csv와 같은 컬럼을 가진 최소 행으로 만든다.
"""
from __future__ import annotations

import pytest

from dart_corpus.retrieval.conditions import extract_conditions, strip_particles
from dart_corpus.retrieval.corp_dictionary import CorpDictionary

UNIVERSE_ROWS = [
    {"corp_name": "케이티", "listed_name": "KT", "stock_code": "030200"},
    {"corp_name": "엔씨소프트", "listed_name": "NC", "stock_code": "036570"},
    {"corp_name": "HD현대중공업", "listed_name": "HD현대중공업", "stock_code": "329180"},
    {"corp_name": "삼성중공업", "listed_name": "삼성중공업", "stock_code": "010140"},
    {"corp_name": "삼성E&A", "listed_name": "삼성E&A", "stock_code": "028050"},
    {"corp_name": "HMM", "listed_name": "HMM", "stock_code": "011200"},
]


@pytest.fixture
def corp_dict() -> CorpDictionary:
    return CorpDictionary.from_rows(UNIVERSE_ROWS)


def test_listed_name_alias_finds_corp(corp_dict):
    """질문은 'KT'라고 쓰지만 코퍼스의 corp_name은 '케이티'다."""
    assert corp_dict.match("KT가 2026년 결정한 자기주식 처분") == {"케이티"}


def test_ascii_alias_needs_word_boundary(corp_dict):
    """'NC'가 'Salamanca' 안에서 잡히면 안 된다 — 실제로 났던 오검출."""
    assert corp_dict.match("삼성E&A의 Salamanca ULSD Project 계약 해지") == {"삼성E&A"}


def test_longest_alias_wins(corp_dict):
    """'HD현대중공업'을 물었는데 부분문자열 기업까지 같이 잡히면 안 된다."""
    rows = UNIVERSE_ROWS + [{"corp_name": "현대중공업", "listed_name": "현대중공업",
                             "stock_code": "999999"}]
    d = CorpDictionary.from_rows(rows)
    assert d.match("HD현대중공업의 2025년 매출액") == {"HD현대중공업"}


def test_two_corps_both_matched(corp_dict):
    got = corp_dict.match("HD현대중공업과 삼성중공업 중 2025년 매출액이 더 큰 기업은?")
    assert got == {"HD현대중공업", "삼성중공업"}


def test_years_and_year_months(corp_dict):
    c = extract_conditions("HMM이 2023년 4월 체결한 계약과 2025년 실적", corp_dict)
    assert c.years == frozenset({2023, 2025})
    assert (2023, 4) in c.year_months


def test_doc_groups_can_be_multiple(corp_dict):
    """multi-hop 질문은 doc_group을 넘나든다 — 하나로 좁히면 안 된다."""
    c = extract_conditions(
        "삼성중공업이 2024년 발표한 자기주식 취득 계획과 이후 반기보고서상 실제 취득 결과",
        corp_dict)
    assert {"major", "periodic"} <= c.doc_groups


def test_exchange_subtype_from_keyword(corp_dict):
    c = extract_conditions("HMM의 2025년 설비투자 계획 규모는?", corp_dict)
    assert "신규시설투자등" in c.exchange_subtypes


def test_correction_flag(corp_dict):
    assert extract_conditions("HMM 계약의 정정 공시 내용", corp_dict).correction is True
    assert extract_conditions("HMM 계약 금액", corp_dict).correction is False


@pytest.mark.parametrize("word,expected", [
    ("영업이익은", "영업이익"),
    ("체결한", "체결"),
    ("신탁계약은", "신탁계약"),
    ("사업보고서를", "사업보고서"),   # 반복 제거하면 '사업보'까지 깎인다
    ("판매허가", "판매허가"),         # '가'는 조사 목록에서 뺐다
    ("사업연도", "사업연도"),
    ("아미랄", "아미랄"),
])
def test_strip_particles(word, expected):
    assert strip_particles(word) == expected


def test_candidate_terms_include_variants(corp_dict):
    """조사 사전이 못 잡는 활용형은 변형을 같이 내보내 df로 거른다."""
    c = extract_conditions("HMM의 유보기한과 공개 상태", corp_dict)
    assert "유보기한" in c.candidate_terms


def test_candidate_terms_exclude_corp_surface(corp_dict):
    c = extract_conditions("삼성중공업의 계약 해지", corp_dict)
    assert not any("삼성중공업" in t for t in c.candidate_terms)
