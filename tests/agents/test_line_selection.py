"""청크 안에서 어느 줄을 근거로 인용할지 — 질문과 겹치는 줄을 고른다.

배경: gold25 밖 질문 18개 실측에서, 검색은 정답 청크를 1위로 올려놓고도 근거로는
표 머리글("1. 투자구분 | 신규시설투자")을 인용했다. 정답은 같은 청크 3번째 줄에
있었다. 21/21 실패. 원인은 지표 사전에 없는 항목("계약금액", "해지일자")이면
무조건 첫 줄을 돌려주던 규칙이었다.
"""
from __future__ import annotations

from dart_detective.agents import qa_agent
from dart_detective.corpus_retriever import RetrievedChunk

INVEST_TABLE = "\n".join([
    "1. 투자구분 | 신규시설투자",
    "- 투자대상 | 한미반도체 7공장",
    "2. 투자내역 | 투자금액(원) | 28,480,000,000",
    "자기자본(원) | 540,887,863,389",
    "자기자본대비(%) | 5.26",
    "3. 투자목적 | 차세대 프리미엄 HBM 생산 대응",
    "4. 투자기간 | 시작일 | 2025-08-01",
    "종료일 | 2026-11-30",
])

FINANCIAL_TABLE = "\n".join([
    "구분 | 제 55 기 2025.01.01 ~ 2025.12.31 | 제 53 기 2023.01.01 ~ 2023.12.31",
    "매출액 | 61,118,127 | 59,254,361",
    "영업이익 | 3,357,456 | 2,295,284",
])


def chunk(text: str, *, chunk_id: str = "c1", row_labels=()) -> RetrievedChunk:
    return RetrievedChunk(chunk_id=chunk_id, doc_id="d1", score=1.0,
                          section_path=("공시",), row_labels=tuple(row_labels),
                          evidence_text=text, metadata={})


# ---------- 지표 없는 질문 (이번에 고친 것) ----------

CORP_DROP = qa_agent.corp_tokens(["한미반도체"])


def test_picks_the_line_the_question_asks_about():
    line = qa_agent._line_for(chunk(INVEST_TABLE), "",
                              "한미반도체 7공장 신규시설투자의 투자금액은 얼마인가?",
                              CORP_DROP)
    assert "28,480,000,000" in line


def test_company_name_alone_does_not_decide_the_line():
    """기업명 토큰을 빼지 않으면 '투자대상 | 한미반도체 7공장' 줄이 이긴다."""
    line = qa_agent._line_for(chunk(INVEST_TABLE), "",
                              "한미반도체의 투자금액은?", CORP_DROP)
    assert "28,480,000,000" in line


def test_picks_the_ratio_line_when_the_question_asks_the_ratio():
    line = qa_agent._line_for(chunk(INVEST_TABLE), "",
                              "투자금액의 자기자본 대비 비율은 몇 퍼센트인가?")
    assert "5.26" in line


def test_picks_the_end_date_line():
    line = qa_agent._line_for(chunk(INVEST_TABLE), "",
                              "투자기간 종료일은 언제인가?")
    assert "2026-11-30" in line


def test_header_line_is_not_the_default_answer_anymore():
    line = qa_agent._line_for(chunk(INVEST_TABLE), "",
                              "투자금액은 얼마인가?")
    assert line != "1. 투자구분 | 신규시설투자"


# ---------- 기존 동작 유지 ----------

def test_metric_line_still_wins_over_question_overlap():
    """지표가 있으면 그 줄이 먼저다 — gold25가 기대하는 동작."""
    line = qa_agent._line_for(chunk(FINANCIAL_TABLE), "영업이익",
                              "2025년 매출액과 영업이익은?")
    assert line.startswith("영업이익")


def test_no_question_falls_back_to_first_line():
    assert qa_agent._line_for(chunk(INVEST_TABLE), "") == "1. 투자구분 | 신규시설투자"


def test_question_with_no_overlap_falls_back_to_first_line():
    line = qa_agent._line_for(chunk(INVEST_TABLE), "", "배당 성향은 어떻게 되나")
    assert line == "1. 투자구분 | 신규시설투자"


def test_empty_chunk_returns_the_raw_text():
    assert qa_agent._line_for(chunk("   "), "", "투자금액") == ""


# ---------- match_evidence 배선 ----------

def test_answer_slot_evidence_uses_the_question():
    matches = qa_agent.match_evidence(
        ["answer"], [chunk(INVEST_TABLE)],
        question="한미반도체 7공장 투자금액은 얼마인가?", drop=CORP_DROP)
    assert matches and "28,480,000,000" in matches[0].evidence_text


def test_answer_slot_without_question_keeps_old_behaviour():
    matches = qa_agent.match_evidence(["answer"], [chunk(INVEST_TABLE)])
    assert matches[0].evidence_text == "1. 투자구분 | 신규시설투자"


# ---------- 한 청크에서 여러 줄 인용 ----------

def test_two_values_from_the_same_table_both_appear():
    """같은 표의 다른 행에 있는 두 값 — 한 줄만 인용하면 한쪽이 반드시 빠진다."""
    matches = qa_agent.match_evidence(
        ["answer"], [chunk(INVEST_TABLE)],
        question="투자금액과 자기자본 대비 비율은 얼마인가?", drop=CORP_DROP)
    blob = "\n".join(m.evidence_text for m in matches)
    assert "28,480,000,000" in blob
    assert "5.26" in blob


def test_lines_per_chunk_is_capped():
    matches = qa_agent.match_evidence(
        ["answer"], [chunk(INVEST_TABLE)],
        question="투자금액 자기자본 비율 종료일 투자목적은?", drop=CORP_DROP)
    assert len(matches) <= qa_agent.LINES_PER_CHUNK


def test_evidence_never_exceeds_the_limit():
    chunks = [chunk(INVEST_TABLE.replace("28,480,000,000", f"{i}8,480,000,000"),
                    chunk_id=f"c{i}") for i in range(5)]
    matches = qa_agent.match_evidence(
        ["answer"], chunks, limit=3,
        question="투자금액과 자기자본 대비 비율은?", drop=CORP_DROP)
    assert len(matches) == 3


def test_identical_lines_from_different_chunks_are_not_repeated():
    """같은 공시가 여러 문서에 실려도 같은 줄을 두 번 인용하지 않는다."""
    chunks = [chunk(INVEST_TABLE, chunk_id=f"c{i}") for i in range(5)]
    matches = qa_agent.match_evidence(
        ["answer"], chunks, limit=5,
        question="투자금액과 자기자본 대비 비율은?", drop=CORP_DROP)
    texts = [m.evidence_text for m in matches]
    assert len(texts) == len(set(texts))


def test_second_line_is_labelled_in_the_reason():
    matches = qa_agent.match_evidence(
        ["answer"], [chunk(INVEST_TABLE)],
        question="투자금액과 자기자본 대비 비율은?", drop=CORP_DROP)
    assert "같은 표의 2번째" in matches[1].reason


def test_duplicate_lines_are_not_emitted_twice():
    matches = qa_agent.match_evidence(
        ["answer"], [chunk(INVEST_TABLE)],
        question="투자금액은 얼마인가?", drop=CORP_DROP)
    texts = [m.evidence_text for m in matches]
    assert len(texts) == len(set(texts))
