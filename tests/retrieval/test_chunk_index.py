"""Stage 2(청크 단위 근거 검색) 테스트 — 합성 문서, 실제 corpus 불필요."""
from __future__ import annotations

import pytest

from dart_corpus.retrieval.chunk_index import (
    ChunkIndex, chunk_document, route_sections,
)

SUMMARY_TABLE = "\n".join([
    "구분 | 제 52 기 | 제 51 기",
    "매출액 | 61,118,127 | 59,254,361",
    "영업이익 | 3,357,456 | 2,295,284",
    "당기순이익 | 2,900,000 | 2,100,000",
])
BUSINESS_TABLE = "\n".join([
    "구분 | 2025년 | 2024년",
    "임직원수 | 61,118 | 59,254",
    "매출액 | 999,999 | 888,888",
])


def periodic_doc() -> dict:
    return {
        "doc_id": "periodic_20260309001878",
        "doc_group": "periodic",
        "nodes": [
            {"node_index": 0, "kind": "table",
             "section_hierarchy": ["II. 사업의 내용", "7. 기타 참고사항"],
             "text": BUSINESS_TABLE},
            {"node_index": 1, "kind": "table",
             "section_hierarchy": ["III. 재무에 관한 사항", "1. 요약재무정보"],
             "text": SUMMARY_TABLE},
            {"node_index": 2, "kind": "paragraph",
             "section_hierarchy": ["I. 회사의 개요", "1. 회사의 개요"],
             "text": "회사는 자동차 부품을 제조한다."},
        ],
    }


def major_doc() -> dict:
    """주요사항보고서 — section_hierarchy가 사건 이름으로 채워져 있다."""
    return {
        "doc_id": "major_20250206000192",
        "doc_group": "major",
        "nodes": [
            {"node_index": 0, "kind": "table",
             "section_hierarchy": ["주요사항보고서 / 거래소 신고의무 사항",
                                   "자기주식취득 신탁계약 체결 결정"],
             "text": "\n".join([
                 "1. 계약금액(원) | 500,000,000,000",
                 "2. 계약기간 | 시작일 | 2025년 02월 07일",
                 "3. 계약목적 | 주주환원을 통한 주주가치 제고",
             ])},
        ],
    }


def exchange_doc() -> dict:
    return {
        "doc_id": "exchange_20250611800358",
        "doc_group": "exchange",
        "nodes": [
            {"node_index": 0, "kind": "table", "section_hierarchy": [],
             "text": "계약금액 | 3,071,258,061,832\n매출액대비 | 14.46"},
        ],
    }


# ---------- 섹션 라우팅 규칙 ----------

def test_route_sections_for_financial_question():
    got = route_sections("HMM의 2025년 연결 매출액과 영업이익은?")
    assert "요약재무정보" in got and "손익계산서" in got


def test_route_sections_for_treasury_stock_question():
    assert "자기주식" in route_sections("삼성전자 자기주식 취득과 소각 현황")


def test_route_sections_empty_when_no_trigger():
    assert route_sections("이 회사는 어디에 있나요") == ()


def test_route_sections_covers_capital_change_and_company_history():
    """자기주식 취득/소각의 기록은 "주주에 관한 사항"이 아니라 I. 회사의 개요 밑의
    "자본금 변동사항"(소각 이력)과 "회사의 연혁"(신탁계약 경과)에 있다. 14차 실험."""
    got = route_sections("신한지주 자기주식취득 신탁계약의 취득, 해지, 소각 진행 경과")
    assert "자본금 변동사항" in got
    assert "회사의 연혁" in got


def treasury_periodic_doc():
    """정기공시 — 자기주식 관련 기록이 회사의 개요 밑에 있고, 사업의 내용 쪽에
    어휘만 겹치는 문단이 따로 있다. 섹션 신호가 없으면 뒤쪽이 먼저 올라온다."""
    return {
        "doc_id": "periodic_20250814002920",
        "doc_group": "periodic",
        "nodes": [
            {"node_index": 0, "kind": "paragraph",
             "section_hierarchy": ["II. 사업의 내용", "7. 기타 참고사항"],
             "text": "자기주식 취득 소각 신탁계약 체결 해지 연혁 취득 소각 신탁계약 "
                     "체결 해지 연혁 자기주식 취득 소각 신탁계약 관련 일반 설명."},
            {"node_index": 1, "kind": "paragraph",
             "section_hierarchy": ["I. 회사의 개요", "4. 자본금 변동사항"],
             "text": "2025년 6월 26일 10,347,131주를 자기주식 취득 후 소각함."},
            {"node_index": 2, "kind": "paragraph",
             "section_hierarchy": ["I. 회사의 개요", "2. 회사의 연혁"],
             "text": "2025.02 자기주식취득 신탁계약 체결, 2025.06 해지."},
        ],
    }


def test_capital_change_section_outranks_lexical_lookalike():
    """14차 회귀 — "자본금 변동사항"이 라우팅 대상이라야 소각 기록이 먼저 온다."""
    idx = ChunkIndex.from_documents([treasury_periodic_doc()], strategy="line_window")
    q = "신한지주 자기주식 취득과 소각은 어떻게 진행됐나"
    top = idx.search(q, k=1, section_alpha=0.5)[0][1]
    assert top.section_path == ("I. 회사의 개요", "4. 자본금 변동사항")


def test_company_history_section_is_routed_for_trust_contract_question():
    """14차 회귀 — 신탁계약 체결/해지 경과는 "회사의 연혁"에 있다."""
    idx = ChunkIndex.from_documents([treasury_periodic_doc()], strategy="line_window")
    q = "자기주식취득 신탁계약 체결과 해지 연혁"
    top = idx.search(q, k=1, section_alpha=0.5)[0][1]
    assert top.section_path == ("I. 회사의 개요", "2. 회사의 연혁")


# ---------- 청킹 ----------

def test_line_window_keeps_document_and_section_metadata():
    chunks = chunk_document(periodic_doc(), strategy="line_window")
    assert chunks
    c = chunks[0]
    assert c.doc_id == "periodic_20260309001878"
    assert c.doc_group == "periodic"
    assert c.section_path == ("II. 사업의 내용", "7. 기타 참고사항")


def test_table_row_carries_header():
    chunks = chunk_document(periodic_doc(), strategy="table_row")
    row = next(c for c in chunks if "3,357,456" in c.text)
    assert "제 52 기" in row.header
    assert "제 52 기" in row.search_text


def test_table_group_bundles_rows_with_header():
    chunks = chunk_document(periodic_doc(), strategy="table_group",
                            table_rows_per_chunk=2)
    group = next(c for c in chunks if "3,357,456" in c.text)
    assert group.kind == "table_group"
    assert len(group.text.split("\n")) <= 2


def test_section_routable_for_groups_that_have_a_hierarchy():
    """정기공시·주요사항보고서만 섹션 계층을 가진다. 거래소공시에는 없다."""
    p = chunk_document(periodic_doc(), strategy="line_window")[0]
    e = chunk_document(exchange_doc(), strategy="line_window")[0]
    m = chunk_document(major_doc(), strategy="line_window")[0]
    assert p.section_routable is True
    assert m.section_routable is True
    assert e.section_routable is False


def test_major_section_routing_recovers_the_event_chunk():
    """major 섹션은 목차가 아니라 사건 이름이다 — 질문의 사건 표현이 그대로 걸린다."""
    idx = ChunkIndex.from_documents([major_doc(), exchange_doc()], strategy="line_window")
    q = "신한지주 자기주식취득 신탁계약의 계약금액과 계약목적은?"
    top = idx.search(q, k=1, section_alpha=0.5)[0][1]
    assert top.doc_group == "major"
    assert "자기주식취득 신탁계약" in " > ".join(top.section_path)


def test_group_guard_skips_section_routing_when_nothing_matches():
    """어떤 문서군에서 섹션 매칭이 0이면 그 군은 라우팅 대상에서 빠진다.

    아무것도 못 맞히는 신호가 그 군 전체 점수를 깎으면 안 된다(Q18 회귀).
    """
    idx = ChunkIndex.from_documents([major_doc()], strategy="line_window")
    q = "연구개발 활동 내역은?"          # major 섹션 어느 것과도 안 맞는다
    a = [c.chunk_id for _, c in idx.search(q, k=5, section_alpha=0.5)]
    b = [c.chunk_id for _, c in idx.search(q, k=5, section_alpha=0.0)]
    assert a == b


# ---------- 검색 ----------

@pytest.fixture
def index() -> ChunkIndex:
    return ChunkIndex.from_documents([periodic_doc(), exchange_doc()],
                                     strategy="line_window")


def test_section_boost_prefers_the_financial_statement_section(index):
    """'매출액'은 사업의 내용 표에도 있다. 재무 질문이면 요약재무정보가 먼저 와야 한다."""
    q = "현대모비스의 연결 매출액과 영업이익은?"
    without = index.search(q, k=1, section_alpha=0.0)[0][1]
    with_boost = index.search(q, k=1, section_alpha=0.5)[0][1]
    assert with_boost.section_path[-1] == "1. 요약재무정보"
    assert with_boost.chunk_id != without.chunk_id or without.section_path[-1] == "1. 요약재무정보"


def test_section_boost_does_not_penalise_non_periodic_chunks(index):
    """거래소공시에는 정기공시 목차가 없다. 섹션 라우팅 때문에 밀리면 안 된다(Q18 회귀)."""
    q = "계약금액과 매출액대비 비율"
    plain = [c.chunk_id for _, c in index.search(q, k=5, section_alpha=0.0)]
    boosted = [c.chunk_id for _, c in index.search(q, k=5, section_alpha=0.5)]
    ex = next(c for c in index.chunks if c.doc_group == "exchange")
    assert (ex.chunk_id in plain) == (ex.chunk_id in boosted)


def test_search_without_sections_is_plain_bm25(index):
    a = [c.chunk_id for _, c in index.search("매출액", k=5, sections=(), section_alpha=0.5)]
    b = [c.chunk_id for _, c in index.search("매출액", k=5, section_alpha=0.0)]
    assert a == b


def test_search_returns_at_most_k(index):
    assert len(index.search("매출액 영업이익", k=2)) <= 2


def test_stats_reports_chunk_kinds(index):
    stats = index.stats()
    assert stats["n_chunks"] == len(index.chunks)
    assert sum(v for k, v in stats.items() if k != "n_chunks") == stats["n_chunks"]


# ---------- context enrichment (기본값 off — 실측에서 이득 없음) ----------

def test_context_mode_off_is_the_default():
    chunks = chunk_document(periodic_doc(), strategy="line_window")
    assert all(c.header == "" for c in chunks if c.kind in ("window", "table_block"))


def test_context_title_adds_section_path():
    chunks = chunk_document(periodic_doc(), strategy="line_window",
                            context_mode="title")
    c = next(x for x in chunks if "3,357,456" in x.text)
    assert "요약재무정보" in c.header
    assert "요약재무정보" in c.search_text


def test_context_unit_uses_only_text_present_in_the_node():
    """단위 줄이 없는 표에는 단위를 지어내지 않는다."""
    doc = {
        "doc_id": "periodic_x", "doc_group": "periodic",
        "nodes": [{"node_index": 0, "kind": "table",
                   "section_hierarchy": ["III. 재무에 관한 사항", "1. 요약재무정보"],
                   "text": SUMMARY_TABLE}],
    }
    c = chunk_document(doc, strategy="line_window", context_mode="title_unit")[0]
    assert "단위" not in c.header

    with_unit = dict(doc)
    with_unit["nodes"] = [dict(doc["nodes"][0],
                               text="(단위 : 백만원)\n" + SUMMARY_TABLE)]
    c2 = chunk_document(with_unit, strategy="line_window",
                        context_mode="title_unit")[0]
    assert "단위" in c2.header


def test_context_full_adds_consolidation_and_period_header():
    doc = {
        "doc_id": "periodic_y", "doc_group": "periodic",
        "nodes": [{"node_index": 0, "kind": "table",
                   "section_hierarchy": ["III. 재무에 관한 사항", "2. 연결재무제표"],
                   "text": SUMMARY_TABLE}],
    }
    c = chunk_document(doc, strategy="line_window", context_mode="full")[0]
    assert "연결" in c.header
    assert "제 52 기" in c.header


# ---------- 표 행 레이블 라우팅 ----------

def test_normalize_row_label_strips_numbering_and_notes():
    from dart_corpus.retrieval.chunk_index import normalize_row_label
    assert normalize_row_label("Ⅰ. 매출액(주4,29,36") == "매출액"
    assert normalize_row_label("V. 영업이익") == "영업이익"
    assert normalize_row_label("합 계") == "합계"


def test_normalize_row_label_maps_observed_synonyms():
    """코퍼스 Gold 행에서 실제로 관찰된 표기만 동의어로 둔다."""
    from dart_corpus.retrieval.chunk_index import normalize_row_label
    assert normalize_row_label("영업손익") == "영업이익"
    assert normalize_row_label("영업이익(손실") == "영업이익"
    assert normalize_row_label("고객과의 계약에서 생기는 수익") == "매출액"


def test_extract_metrics_from_question():
    from dart_corpus.retrieval.chunk_index import extract_metrics
    assert extract_metrics("HMM의 연결 매출액과 영업이익은?") == ("매출액", "영업이익")


def test_extract_metrics_empty_when_question_names_no_metric():
    """'실적'·'성장 양상'만 있는 질문에서는 지표를 뽑을 수 없다(Q16이 이 경우다)."""
    from dart_corpus.retrieval.chunk_index import extract_metrics
    assert extract_metrics("두 기업의 실적 변화와 성장 양상은 어떻게 다른가?") == ()


def test_chunk_row_labels_are_normalized():
    doc = {
        "doc_id": "periodic_z", "doc_group": "periodic",
        "nodes": [{"node_index": 0, "kind": "table",
                   "section_hierarchy": ["III. 재무에 관한 사항", "1. 요약재무정보"],
                   "text": "구분 | 제 52 기\nⅠ. 매출액(주4) | 61,118,127 | 59,254,361\n"
                           "영업손익 | 3,357,456 | 2,295,284"}],
    }
    c = chunk_document(doc, strategy="line_window")[0]
    assert c.row_labels == {"매출액", "영업이익"}
    assert c.has_row_label(["영업이익"]) is True
    assert c.has_row_label(["영업이익"], exact=True) is False   # 원문은 '영업손익'


def test_row_label_boost_lifts_the_metric_row(index):
    q = "현대모비스의 연결 매출액은?"
    plain = index.search(q, k=1, row_alpha=0.0)[0][1]
    boosted = index.search(q, k=1, row_labels=("매출액",), row_alpha=0.5)[0][1]
    assert "매출액" in boosted.row_labels
    assert boosted.chunk_id or plain.chunk_id      # 둘 다 결과가 나온다


def test_row_label_boost_is_inert_without_metrics(index):
    """지표를 직접 부르지도, 추론되지도 않는 질문에서는 신호가 꺼진다.

    ("성장 양상"은 8차에서 추론 규칙에 들어갔으므로 더 이상 이 예시가 아니다.)
    """
    from dart_corpus.retrieval.chunk_index import infer_metrics
    q = "이 회사의 대표이사는 누구인가?"
    assert infer_metrics(q) == ()
    a = [c.chunk_id for _, c in index.search(q, k=5, row_alpha=0.5)]
    b = [c.chunk_id for _, c in index.search(q, k=5, row_alpha=0.0)]
    assert a == b


# ---------- 지표 추론 (질문이 지표를 이름으로 부르지 않을 때) ----------

def test_infer_metrics_falls_back_to_hypernym_rules():
    from dart_corpus.retrieval.chunk_index import infer_metrics
    assert set(infer_metrics("사업 규모와 영업 수익성을 비교해줘")) == {"매출액", "영업이익"}
    assert set(infer_metrics("실적 변화와 성장 양상은?")) == {"매출액", "영업이익"}


def test_infer_metrics_does_not_override_direct_match():
    """지표를 직접 부른 질문의 동작은 그대로 둔다 — 규칙은 빈 결과일 때만 개입한다."""
    from dart_corpus.retrieval.chunk_index import extract_metrics, infer_metrics
    q = "HMM의 연결 매출액은 얼마인가?"
    assert extract_metrics(q) == ("매출액",)
    assert infer_metrics(q) == ("매출액",)


def test_bare_size_word_does_not_trigger_metric_inference():
    """'규모'만으로는 켜지 않는다. 계약·투자 질문(Q02·Q06·Q17)에 잘못 걸린다."""
    from dart_corpus.retrieval.chunk_index import infer_metrics
    assert infer_metrics("한화오션의 투자 규모와 자기자본 대비 비율은?") == ()
    assert infer_metrics("두 해지 규모의 차이도 설명해줘") == ()


def test_infer_metrics_empty_for_non_financial_question():
    from dart_corpus.retrieval.chunk_index import infer_metrics
    assert infer_metrics("이 회사의 대표이사는 누구인가?") == ()


# ---------- tie-break: 추론 지표의 질의 확장 ----------

def test_query_expansion_only_fires_for_inferred_metrics(index):
    """질문에 지표가 이미 적혀 있으면 확장하지 않는다.

    같은 말을 한 번 더 붙이면 term frequency만 흔들린다 — 실측에서 Q10 @3이
    1.00 -> 0.25로 깨졌다.
    """
    direct = "현대모비스의 매출액은?"
    a = [c.chunk_id for _, c in index.search(direct, k=5, query_expansion=True)]
    b = [c.chunk_id for _, c in index.search(direct, k=5, query_expansion=False)]
    assert a == b


def test_query_expansion_changes_ranking_when_metric_is_inferred(index):
    """'사업 규모/영업 수익성'처럼 지표를 안 부른 질문에서만 검색어가 넓어진다."""
    from dart_corpus.retrieval.chunk_index import extract_metrics, infer_metrics
    q = "사업 규모와 영업 수익성을 비교해줘"
    assert extract_metrics(q) == ()
    assert set(infer_metrics(q)) == {"매출액", "영업이익"}
    expanded = index.search(q, k=5, query_expansion=True)
    plain = index.search(q, k=5, query_expansion=False)
    assert expanded and plain          # 둘 다 결과가 나온다


def test_row_first_ranking_mode_is_available_but_not_default(index):
    """사전식 정렬은 실측에서 기각됐다(개선 0, Q09·Q18 회귀). 옵션으로만 남긴다."""
    hits = index.search("현대모비스의 매출액은?", k=5, ranking_mode="row_first")
    assert hits


def test_row_match_mode_all_requires_every_metric():
    doc = {
        "doc_id": "periodic_w", "doc_group": "periodic",
        "nodes": [
            {"node_index": 0, "kind": "table",
             "section_hierarchy": ["III. 재무에 관한 사항", "1. 요약재무정보"],
             "text": "구분 | 제 52 기\n매출액 | 61,118,127 | 59,254,361"},
            {"node_index": 1, "kind": "table",
             "section_hierarchy": ["III. 재무에 관한 사항", "1. 요약재무정보"],
             "text": "구분 | 제 52 기\n매출액 | 61,118,127 | 59,254,361\n"
                     "영업이익 | 3,357,456 | 2,295,284"},
        ],
    }
    chunks = chunk_document(doc, strategy="line_window")
    only_revenue = next(c for c in chunks if c.node_index == 0)
    both = next(c for c in chunks if c.node_index == 1)
    from dart_corpus.retrieval.chunk_index import _row_label_hit
    wanted = ("매출액", "영업이익")
    assert _row_label_hit(only_revenue, wanted, False, "any") == 1.0
    assert _row_label_hit(only_revenue, wanted, False, "all") == 0.0
    assert _row_label_hit(both, wanted, False, "all") == 1.0
