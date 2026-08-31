"""연결 재무제표와 별도 재무제표를 가른다.

배경(Q11 실측): HMM 2025 사업보고서의 "1. 요약재무정보" 섹션 안에 표가 둘 있다.
    가. 요약연결재무정보  -> 매출액 8,400,969 (2023)
    나. 요약재무정보      -> 매출액 8,230,446 (2023)
섹션 경로도 행 레이블도 같아서 selector가 검색 순위만 보고 별도 표를 골랐고,
질문은 "연결 실적"을 물었다. 계산은 정확했지만 입력이 틀렸다.
"""
from __future__ import annotations

import pytest

from dart_detective.agents import qa_agent
from dart_detective.corpus_retriever import CorpusRetriever, RetrievedChunk

ROW = "매출액 | 10,891,443 | 11,700,224 | 8,400,969"
ROW_SEPARATE = "매출액 | 10,721,177 | 11,513,430 | 8,230,446"
HEADER = "구 분 | 제50기 | 제49기 | 제48기\n(2025년 12월 말) | (2024년 12월 말) | (2023년 12월 말)"


def chunk(text, node_index, chunk_id, section=("III. 재무에 관한 사항", "1. 요약재무정보")):
    return RetrievedChunk(chunk_id=chunk_id, doc_id="periodic_1", score=1.0,
                          section_path=section, row_labels=("매출액",),
                          evidence_text=f"{HEADER}\n{text}", metadata={},
                          node_index=node_index)


# ---------- 질문이 무엇을 요구했나 ----------

@pytest.mark.parametrize("question,expected", [
    ("HMM의 2023년과 2025년 연결 실적을 비교하면?", "연결"),
    ("별도 기준 매출액은?", "별도"),
    ("개별 재무제표 기준 영업이익은?", "별도"),
    ("매출액은 얼마인가?", ""),
    ("연결과 별도 차이는?", ""),          # 둘 다 물으면 가르지 않는다
])
def test_wanted_scope(question, expected):
    assert qa_agent.wanted_scope(question) == expected


# ---------- 문서에서 범위를 읽는다 ----------

def retriever_with_two_tables() -> CorpusRetriever:
    doc = {"doc_id": "periodic_1", "nodes": [
        {"node_index": 230, "kind": "paragraph", "text": "가. 요약연결재무정보"},
        {"node_index": 232, "kind": "table", "text": ROW},
        {"node_index": 234, "kind": "paragraph", "text": "나. 요약재무정보"},
        {"node_index": 236, "kind": "table", "text": ROW_SEPARATE},
    ]}
    return CorpusRetriever(document_index=None, corp_dict=None,
                           docs_by_id={"periodic_1": doc})


def test_tables_are_labelled_from_the_preceding_heading():
    scopes = retriever_with_two_tables().statement_scopes("periodic_1")
    assert scopes[232] == "연결"
    assert scopes[236] == "별도"


def test_scope_is_cached_per_document():
    r = retriever_with_two_tables()
    assert r.statement_scopes("periodic_1") is r.statement_scopes("periodic_1")


def test_unknown_document_has_no_scopes():
    assert retriever_with_two_tables().statement_scopes("없는문서") == {}


def test_section_path_alone_can_say_consolidated():
    c = chunk(ROW, 300, "c9", section=("III. 재무에 관한 사항", "2. 연결재무제표"))
    assert qa_agent.scope_of_chunk(c, {}) == "연결"


# ---------- 근거 선택 ----------

def test_consolidated_question_picks_the_consolidated_table():
    scopes = {"periodic_1": {232: "연결", 236: "별도"}}
    # 별도 표가 검색 1위, 연결 표가 2위 — Q11에서 실제로 일어난 순서
    chunks = [chunk(ROW_SEPARATE, 236, "sep"), chunk(ROW, 232, "con")]
    matches = qa_agent.match_evidence(
        ["매출액_2023"], chunks, question="HMM의 2023년 연결 매출액은?", scopes=scopes)
    assert matches[0].chunk_id == "con"
    assert matches[0].picked_value == "8,400,969"


def test_separate_question_picks_the_separate_table():
    scopes = {"periodic_1": {232: "연결", 236: "별도"}}
    chunks = [chunk(ROW, 232, "con"), chunk(ROW_SEPARATE, 236, "sep")]
    matches = qa_agent.match_evidence(
        ["매출액_2023"], chunks, question="HMM의 2023년 별도 매출액은?", scopes=scopes)
    assert matches[0].chunk_id == "sep"


def test_question_without_a_scope_keeps_the_retrieval_order():
    scopes = {"periodic_1": {232: "연결", 236: "별도"}}
    chunks = [chunk(ROW_SEPARATE, 236, "sep"), chunk(ROW, 232, "con")]
    matches = qa_agent.match_evidence(
        ["매출액_2023"], chunks, question="HMM의 2023년 매출액은?", scopes=scopes)
    assert matches[0].chunk_id == "sep"


def test_unlabelled_chunks_are_not_penalised():
    """범위를 모르는 표는 그대로 둔다 — 모른다고 깎지 않는다."""
    chunks = [chunk(ROW, 999, "unknown")]
    matches = qa_agent.match_evidence(
        ["매출액_2023"], chunks, question="연결 매출액은?", scopes={})
    assert matches and matches[0].chunk_id == "unknown"


# ---------- 패턴 확장 (표본 1개짜리 규칙이라는 지적에 대한 방어) ----------

def test_table_own_first_line_wins_over_the_running_heading():
    """표 첫 줄에 표기가 있으면 앞 제목보다 우선이다."""
    doc = {"doc_id": "d", "nodes": [
        {"node_index": 1, "kind": "paragraph", "text": "가. 요약연결재무정보"},
        {"node_index": 2, "kind": "table", "text": "별도 재무상태표\n자산 | 100"},
    ]}
    r = CorpusRetriever(document_index=None, corp_dict=None, docs_by_id={"d": doc})
    assert r.statement_scopes("d")[2] == "별도"


def test_plain_heading_resets_the_running_scope():
    """연결 제목 뒤에 무관한 제목이 오면 그 아래 표는 라벨 없이 둔다 —
    먼 표까지 이전 표기를 끌고 가지 않는다."""
    doc = {"doc_id": "d", "nodes": [
        {"node_index": 1, "kind": "paragraph", "text": "가. 요약연결재무정보"},
        {"node_index": 2, "kind": "table", "text": "자산 | 100"},
        {"node_index": 3, "kind": "paragraph", "text": "다. 배당에 관한 사항"},
        {"node_index": 4, "kind": "table", "text": "배당금 | 500"},
    ]}
    r = CorpusRetriever(document_index=None, corp_dict=None, docs_by_id={"d": doc})
    scopes = r.statement_scopes("d")
    assert scopes[2] == "연결"
    assert 4 not in scopes


def test_long_paragraph_does_not_reset_the_scope():
    """본문 문단(제목 아님)은 표기 흐름을 끊지 않는다."""
    doc = {"doc_id": "d", "nodes": [
        {"node_index": 1, "kind": "paragraph", "text": "가. 요약연결재무정보"},
        {"node_index": 2, "kind": "paragraph",
         "text": "위 표는 한국채택국제회계기준에 따라 작성되었으며 세부 내역은 주석을 참조하기 바랍니다."},
        {"node_index": 3, "kind": "table", "text": "자산 | 100"},
    ]}
    r = CorpusRetriever(document_index=None, corp_dict=None, docs_by_id={"d": doc})
    assert r.statement_scopes("d")[3] == "연결"


# ---------- 연도 머리글 판독: 완화 매칭의 경계 ----------

def bare_chunk(text: str) -> RetrievedChunk:
    # 이 파일의 chunk() 헬퍼는 자체 머리글(2025 포함)을 붙인다 — 연도 판독
    # 테스트엔 오염이라 머리글 없이 직접 만든다.
    return RetrievedChunk(chunk_id="x", doc_id="d", score=1.0, section_path=("공시",),
                          row_labels=("매출액",), evidence_text=text, metadata={})


def test_half_year_header_without_month_digits_is_read():
    # Q10 실측 — "2025년 반기 | 2024년 | 2023년" 형태 머리글
    c = bare_chunk("구 분 | 2025년 반기 | 2024년 | 2023년" + chr(10) + "매출액 | 100 | 200 | 300")
    assert qa_agent.period_columns(c) == {2025: 0, 2024: 1, 2023: 2}


def test_footnote_year_is_not_a_period_column():
    # 각주의 "2025년"이 연도 열로 오인되면 Q12 보호가 깨진다 — 실측 회귀
    c = bare_chunk("구 분 | 제53기 2023.01.01 ~ 2023.12.31 | 제52기 2022.01.01 ~ 2022.12.31"
                   + chr(10) + "매출액 | 59,254,361 | 51,906,293"
                   + chr(10) + "주) 2025년 이후 계획은 별도 공시")
    assert 2025 not in qa_agent.period_columns(c)
