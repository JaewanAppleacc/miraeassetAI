"""Phase1 DEV_TUNE 실측에서 나온 세 가지 규칙.

- 하이픈 날짜(2024-04-17)를 연도 조건으로 읽고, 그 날 접수된 문서를 앞세운다.
- "코퍼스에 포함되어 있는가" 질문은 문서 인덱스를 세서 0건이면 NOT_FOUND.
- 공시유보 표식이 있고 질문이 그 값을 물으면 WITHHELD.
셋 다 검색 코어(dart_corpus)는 건드리지 않는다.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from dart_detective import answer_wire, corpus_retriever
from dart_detective.agents import qa_agent
from dart_detective.corpus_retriever import RetrievedChunk


# ---------- 날짜 ----------

@pytest.mark.parametrize("text,expected", [
    ("삼성E&A의 2024-04-17 단일판매 공시", [(2024, 4, 17)]),
    ("2024.12.05 결의", [(2024, 12, 5)]),
    ("2025-03-17 계약과 2023-04-04 수령", [(2025, 3, 17), (2023, 4, 4)]),
    ("2024년 4월 17일 공시", []),            # 한글 날짜는 Retrieval parser 몫
    ("코드 2024-13-40", []),                  # 월·일 범위 밖
    ("접수번호 20240417800519", []),          # 구분자 없는 숫자는 날짜가 아니다
])
def test_question_dates(text, expected):
    assert corpus_retriever.question_dates(text) == expected


# ---------- 존재 질문 ----------

def _doc(doc_id, corp, group, year):
    return SimpleNamespace(doc_id=doc_id, corp_name=corp, filer_name=corp,
                           doc_group=group, period_year=year)


def _retriever(docs):
    return SimpleNamespace(document_index=SimpleNamespace(documents=docs))


def _cond(corps=(), years=()):
    return SimpleNamespace(corps=frozenset(corps), years=frozenset(years))


def test_existence_zero_documents_is_not_found():
    r = _retriever([_doc("major_1", "현대제철", "periodic", 2024)])
    got = qa_agent.corpus_existence(
        "현대제철의 주요사항보고서(major 유형) 공시가 현재 코퍼스에 포함되어 있는가?",
        _cond(["현대제철"]), r)
    assert got is not None
    answer, _ = got
    assert "포함되어 있지 않다" in answer and "현대제철" in answer


def test_existence_with_documents_goes_normal_path():
    r = _retriever([_doc("major_1", "현대제철", "major", 2024)])
    assert qa_agent.corpus_existence(
        "현대제철의 주요사항보고서가 현재 코퍼스에 포함되어 있는가?",
        _cond(["현대제철"]), r) is None


def test_existence_respects_year():
    r = _retriever([_doc("p1", "삼성전자", "periodic", 2024)])
    got = qa_agent.corpus_existence(
        "삼성전자의 2022 회계연도 사업보고서가 현재 코퍼스에 포함되어 있는가?",
        _cond(["삼성전자"], [2022]), r)
    assert got is not None and "2022년" in got[0]


def test_existence_needs_a_corp():
    r = _retriever([])
    assert qa_agent.corpus_existence("사업보고서가 코퍼스에 포함되어 있는가?", _cond(), r) is None


def test_value_question_is_not_existence():
    r = _retriever([])
    assert qa_agent.corpus_existence("삼성전자 2024년 매출액은 얼마인가?",
                                     _cond(["삼성전자"]), r) is None


# ---------- 공시유보 ----------

def _chunk(doc_id, text):
    return RetrievedChunk(chunk_id=doc_id + "#c", doc_id=doc_id, score=1.0,
                          section_path=(), row_labels=(), evidence_text=text, metadata={})


def _match(doc_id, slot, value):
    return qa_agent.EvidenceMatch(slot=slot, chunk_id=doc_id + "#c", doc_id=doc_id,
                                  evidence_text="x", section_path=(), confidence=1.0,
                                  reason="", picked_value=value)


TABLE = ("2. 계약내역 | 계약금액(원) | -\n3. 계약상대 | NH농협은행\n"
         "8. 공시유보 관련내용 | 유보사유 | 경영상 비밀유지\n유보기한 | 2029-04-04")


def test_withheld_table_with_dash_value():
    found = qa_agent.detect_withheld(
        "LG씨엔에스 단일판매 공급계약의 계약금액은 얼마인가?",
        [_chunk("d1", TABLE)], [_match("d1", "계약금액", "-")])
    assert found["유보사유"] == "경영상 비밀유지"
    assert found["유보기한"] == "2029-04-04"


def test_withheld_prose_when_question_asks_if_available():
    prose = ("계약상대방회사의 이름과 신약 개발품목 등의 정보는 계약상 영업비밀유지 사항에 "
             "속하며 해당 내역은 공시유보사항에 해당합니다.")
    found = qa_agent.detect_withheld(
        "기술을 이전받은 계약상대방 회사명은 공시상 확인 가능한가?",
        [_chunk("d1", prose)], [])
    assert "유보문장" in found


def test_no_withheld_marker_means_nothing():
    assert qa_agent.detect_withheld("계약금액은?", [_chunk("d1", "계약금액(원) | 100")],
                                    [_match("d1", "계약금액", "100")]) == {}


def test_withheld_marker_but_value_public_and_not_asked():
    """유보 칸은 있어도 질문이 공개된 값을 묻고 값도 있으면 유보로 답하지 않는다."""
    table = "계약금액(원) | 5,944,227,336,000\n8. 공시유보 관련내용 | 유보사유 | 경영상 비밀유지"
    assert qa_agent.detect_withheld("계약금액은 얼마인가?", [_chunk("d1", table)],
                                    [_match("d1", "계약금액", "5,944,227,336,000")]) == {}


def test_dash_only_reason_is_not_withheld():
    table = "8. 공시유보 관련내용 | 유보사유 | -\n유보기한 | -"
    assert qa_agent.detect_withheld("계약금액은?", [_chunk("d1", table)],
                                    [_match("d1", "계약금액", "-")]) == {}


def test_withheld_text_lists_reason_and_deadline():
    text = qa_agent.withheld_text({"유보사유": "경영상 비밀유지", "유보기한": "2030-07-31"})
    assert "확인할 수 없다" in text and "2030-07-31" in text


def test_withheld_row_outside_top_chunks_via_doc_lines():
    """유보 칸이 상위 청크에 없어도 문서 전체 행에서 찾는다(LG에너지솔루션 실측)."""
    top = _chunk("d1", "2. 계약내역 | 최근매출액(원) | 25,619,585,140,102")
    doc_lines = {"d1": ["3. 계약상대 | -", "8. 공시유보 관련내용 | 유보사유 | 경영상 비밀유지",
                        "유보기한 | 2030-07-31"]}
    found = qa_agent.detect_withheld(
        "LFP 배터리 공급계약 공시에서 계약상대방, 계약금액, 계약기간을 알려줘.",
        [top], [_match("d1", "매출액", "25,619,585,140,102")], doc_lines)
    assert found.get("유보사유") == "경영상 비밀유지"


def test_existence_regex_reaches_over_long_corp_mention():
    r = _retriever([])
    got = qa_agent.corpus_existence(
        "제공된 코퍼스 스냅샷 내에 현대제철(corp_code 00145880)의 major 유형(주요사항보고서) 공시가 존재하는가?",
        _cond(["현대제철"]), r)
    assert got is not None


# ---------- wire ----------

@pytest.mark.parametrize("state,expected", [
    ({"answerability": "NOT_FOUND", "evidence": []}, "NOT_FOUND"),
    ({"answerability": "WITHHELD", "evidence": [{"text": "x"}]}, "WITHHELD"),
    ({"answerability": "", "evidence": []}, "EVIDENCE_NOT_FOUND"),
])
def test_wire_prefers_rule_answerability(state, expected):
    assert answer_wire.answerability_of(state) == expected
