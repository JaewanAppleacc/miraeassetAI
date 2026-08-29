"""조건 인지 DocumentIndex 테스트 — 합성 코퍼스, 실제 corpus 불필요."""
from __future__ import annotations

import pytest

from dart_corpus.retrieval.conditions import extract_conditions
from dart_corpus.retrieval.corp_dictionary import CorpDictionary
from dart_corpus.retrieval.document_index import DocumentIndex, IndexedDocument, Weights

UNIVERSE_ROWS = [
    {"corp_name": "HMM", "listed_name": "HMM", "stock_code": "011200"},
    {"corp_name": "삼성SDI", "listed_name": "삼성SDI", "stock_code": "006400"},
    {"corp_name": "고려아연", "listed_name": "고려아연", "stock_code": "010130"},
    {"corp_name": "현대건설", "listed_name": "현대건설", "stock_code": "000720"},
]


def doc(doc_id, corp, group, *, text, subtype="", report="", rcept="20250101",
        base_year=None, base_month=None, filer=None, correction=False):
    return IndexedDocument(
        doc_id=doc_id, corp_name=corp, corp_code=corp, filer_name=filer or corp,
        doc_group=group,
        doc_subtype=subtype, report_nm=report, rcept_dt=rcept, base_year=base_year,
        base_month=base_month, is_correction=correction, text=text,
    )


@pytest.fixture
def corp_dict() -> CorpDictionary:
    return CorpDictionary.from_rows(UNIVERSE_ROWS)


@pytest.fixture
def documents() -> list[IndexedDocument]:
    boilerplate = "정정일자 계약금액 최근매출액 매출액대비 대규모법인여부 계약상대 계약기간 시작일 종료일"
    return [
        # 정기공시: 2025 사업보고서지만 접수는 2026년이다 — 기간 필터의 핵심 함정
        doc("periodic_hmm_2025", "HMM", "periodic", subtype="annual",
            report="사업보고서 (2025.12)", rcept="20260318",
            base_year=2025, base_month=12,
            text="연결 매출액 10,891,443 영업이익 1,461,202"),
        doc("periodic_hmm_2023", "HMM", "periodic", subtype="annual",
            report="사업보고서 (2023.12)", rcept="20240328",
            base_year=2023, base_month=12,
            text="연결 매출액 8,400,969 영업이익 584,770"),
        # 다른 기업인데 어휘가 더 많이 겹치는 문서 — baseline이 이걸 먼저 올린다
        doc("periodic_sdi_2025", "삼성SDI", "periodic", subtype="annual",
            report="사업보고서 (2025.12)", rcept="20260315",
            base_year=2025, base_month=12,
            text="연결 매출액 영업이익 실적 매출액 영업이익 연결 매출액 영업이익"),
        # 지분공시: 발행사와 보고자가 다르다
        doc("holding_koreazinc", "고려아연", "holding", subtype="대량보유상황보고서",
            report="주식등의대량보유상황보고서(일반)", rcept="20250520",
            filer="영풍", text="보유주식수 8,539,148 지분율 41.25"),
        # 같은 기업 같은 서식 3건 — 사건 식별어만이 이들을 가른다
        doc("exchange_hdc_amiral", "현대건설", "exchange", subtype="단일판매공급계약체결",
            report="[기재정정]단일판매ㆍ공급계약체결", rcept="20250611", correction=True,
            text=boilerplate + " 사우디 아미랄 프로젝트 PKG 계약금액 3,071,258,061,832"),
        # 같은 회사의 다른 사우디 프로젝트들 — "사우디"/"프로젝트"만으로는 안 갈린다.
        doc("exchange_hdc_other1", "현대건설", "exchange", subtype="단일판매공급계약체결",
            report="[기재정정]단일판매ㆍ공급계약체결", rcept="20240522", correction=True,
            text=boilerplate + " 사우디 프로젝트 계약금액 1,000,000,000"),
        doc("exchange_hdc_other2", "현대건설", "exchange", subtype="단일판매공급계약체결",
            report="단일판매ㆍ공급계약체결", rcept="20240523",
            text=boilerplate + " 사우디 프로젝트 계약금액 2,000,000,000"),
    ]


@pytest.fixture
def index(documents, corp_dict) -> DocumentIndex:
    return DocumentIndex(documents, corp_dict)


def ids(hits):
    return [h.doc_id for h in hits]


# ---------- 기간 모델 ----------

def test_periodic_period_year_is_base_year_not_receipt_year(documents):
    """사업보고서 (2025.12)는 2026-03에 접수된다. period_year는 2025여야 한다."""
    d = documents[0]
    assert d.rcept_year == 2026
    assert d.period_year == 2025


def test_non_periodic_period_year_falls_back_to_receipt_year(documents):
    d = next(x for x in documents if x.doc_id == "holding_koreazinc")
    assert d.base_year is None
    assert d.period_year == 2025


def test_period_filter_keeps_report_year_document(index, corp_dict):
    """접수일로 걸렀다면 여기서 2025 사업보고서가 탈락한다 — 회귀 방지용."""
    got = ids(index.search("HMM의 2025년 연결 매출액은?", k=5))
    assert "periodic_hmm_2025" in got


def test_period_filter_excludes_other_year(index):
    got = ids(index.search("HMM의 2025년 연결 매출액은?", k=5))
    assert "periodic_hmm_2023" not in got


# ---------- 기업 조건 ----------

def test_corp_hard_filter_drops_other_company(index):
    """baseline에서 실제로 났던 실패: 질문은 HMM인데 삼성SDI가 상위를 점령."""
    got = ids(index.search("HMM의 2025년 연결 매출액과 영업이익은?", k=5))
    assert "periodic_sdi_2025" not in got
    assert got[0] == "periodic_hmm_2025"


def test_baseline_without_conditions_pulls_wrong_company(documents, corp_dict):
    """조건을 끄면 왜 실패했는지 — 회귀 대조군."""
    off = DocumentIndex(documents, corp_dict, corp_mode="off", period_mode="off",
                        use_doctype_boost=False, use_salient_boost=False)
    got = ids(off.search("HMM의 2025년 연결 매출액과 영업이익은?", k=3))
    assert "periodic_sdi_2025" in got


def test_filer_name_matches_holding_report(index):
    """지분공시는 발행사(고려아연)로도 보고자(영풍)로도 찾을 수 있어야 한다."""
    assert "holding_koreazinc" in ids(index.search("고려아연 대량보유 보고서의 지분율", k=5))
    assert "holding_koreazinc" in ids(index.search("영풍이 제출한 대량보유 보고서", k=5))


# ---------- 공시유형은 soft ----------

def test_doctype_is_boost_not_filter(index):
    """공시유형을 hard로 자르면 doc_group을 넘나드는 multi-hop 질문이 깨진다.

    아래 질문은 periodic 어휘만 담고 있지만, exchange 문서도 후보에 남아야 한다.
    """
    got = ids(index.search("현대건설 매출액 실적 계약금액", k=10))
    assert any(g.startswith("exchange_") for g in got)


def test_doctype_boost_lifts_matching_group(documents, corp_dict):
    with_boost = DocumentIndex(documents, corp_dict, use_salient_boost=False)
    without = DocumentIndex(documents, corp_dict, use_doctype_boost=False,
                            use_salient_boost=False)
    q = "현대건설의 공급계약 계약금액"
    top_with = ids(with_boost.search(q, k=1))[0]
    assert top_with.startswith("exchange_")
    assert ids(without.search(q, k=3))  # 필터가 아니므로 후보는 여전히 남는다


# ---------- 사건 식별어 ----------

def test_salient_term_picks_rare_event_word(index, corp_dict):
    """세 건 모두 '사우디 프로젝트'다. 사건을 가르는 것은 '아미랄'/'PKG'뿐이다."""
    cond = extract_conditions("현대건설 사우디 아미랄 프로젝트 PKG 계약", corp_dict)
    got = index.salient_terms(cond)
    assert "아미랄" in got
    assert "사우디" not in got and "프로젝트" not in got


def test_salient_term_rejects_common_inflection(index, corp_dict):
    """'계약금액은'처럼 흔한 말의 활용형은 사건 식별어가 아니다."""
    cond = extract_conditions("현대건설 계약금액은 얼마인가", corp_dict)
    assert "계약금액" not in index.salient_terms(cond)


def test_salient_boost_ranks_event_document_first(index):
    """같은 기업·같은 서식 3건 중 사건 식별어를 가진 문서가 1위여야 한다."""
    got = ids(index.search("현대건설 사우디 아미랄 프로젝트 PKG 계약의 최신 계약금액", k=3))
    assert got[0] == "exchange_hdc_amiral"


def test_salient_boost_can_be_disabled(documents, corp_dict):
    off = DocumentIndex(documents, corp_dict, use_salient_boost=False)
    cond = extract_conditions("현대건설 사우디 아미랄 프로젝트", corp_dict)
    assert off.search("현대건설 사우디 아미랄 프로젝트", k=3, conditions=cond)


# ---------- 기타 ----------

def test_candidate_pool_shrinks_with_conditions(index, corp_dict):
    cond = extract_conditions("HMM의 2025년 연결 매출액", corp_dict)
    assert index.candidate_pool_size(cond) < len(index.documents)


def test_search_reports_score_components(index):
    hit = index.search("현대건설 사우디 아미랄 프로젝트 계약", k=1)[0]
    assert "bm25" in hit.components
    assert hit.components.get("salient_terms")


def test_weights_are_overridable(documents, corp_dict):
    idx = DocumentIndex(documents, corp_dict, weights=Weights(salient_term=0.0))
    assert idx.weights.salient_term == 0.0
