"""정정 Chain 테스트 — 합성 코퍼스.

링크는 공시 원문에 적힌 필드에서만 만든다. 만들 수 없으면 만들지 않는다는 것이
여기서 고정하려는 성질이다.
"""
from __future__ import annotations

import pytest

from dart_corpus.retrieval.chains import CorrectionLinks, parse_original_receipt_date
from dart_corpus.retrieval.corp_dictionary import CorpDictionary
from dart_corpus.retrieval.document_index import DocumentIndex, IndexedDocument, Weights

EXCHANGE_CORRECTION = (
    "정정일자 2025-06-11\n1. 정정관련 공시서류 단일판매ㆍ공급계약 체결 "
    "2. 정정관련 공시서류제출일 2025-04-18 3. 정정사유 계약금액 변경"
)
MAJOR_CORRECTION = (
    "1. 정정대상 공시서류 : 자기주식취득 신탁계약 체결 결정\n"
    "2. 정정대상 공시서류의 최초제출일 : 2023년 2월 27일\n3. 정정사항"
)


def doc(doc_id, corp_code, group, rcept, *, text="", subtype="", correction=False,
        corp_name="테스트기업"):
    return IndexedDocument(
        doc_id=doc_id, corp_name=corp_name, corp_code=corp_code, filer_name=corp_name,
        doc_group=group, doc_subtype=subtype, report_nm="", rcept_dt=rcept,
        base_year=None, base_month=None, is_correction=correction, text=text,
    )


# ---------- 원문 필드 파싱 ----------

def test_parse_exchange_correction_date():
    assert parse_original_receipt_date(EXCHANGE_CORRECTION) == "20250418"


def test_parse_major_correction_date():
    assert parse_original_receipt_date(MAJOR_CORRECTION) == "20230227"


def test_parse_returns_none_without_field():
    assert parse_original_receipt_date("계약금액 1,000,000,000 계약기간 시작일") is None


# ---------- 링크 생성 ----------

def test_links_original_and_correction():
    docs = [
        doc("orig", "A", "exchange", "20250418", subtype="계약체결"),
        doc("corr", "A", "exchange", "20250611", subtype="계약체결",
            text=EXCHANGE_CORRECTION, correction=True),
    ]
    links = CorrectionLinks.build(docs)
    assert links.parent == {"corr": "orig"}
    assert links.children["orig"] == ["corr"]
    assert set(links.chain("corr")) == {"orig", "corr"}


def test_no_link_when_target_outside_corpus():
    """코퍼스 기간(2023.01~) 이전 원공시는 이을 수 없다 — 실측 308건이 이 경우다."""
    docs = [doc("corr", "A", "exchange", "20250611", text=EXCHANGE_CORRECTION,
                correction=True)]
    links = CorrectionLinks.build(docs)
    assert links.parent == {}
    assert links.unresolved["corr"] == "target_not_in_corpus"


def test_no_link_when_ambiguous():
    """같은 날 같은 유형 공시가 둘이면 틀린 링크를 만들지 않는다."""
    docs = [
        doc("orig1", "A", "exchange", "20250418", subtype="계약체결"),
        doc("orig2", "A", "exchange", "20250418", subtype="계약체결"),
        doc("corr", "A", "exchange", "20250611", subtype="계약체결",
            text=EXCHANGE_CORRECTION, correction=True),
    ]
    links = CorrectionLinks.build(docs)
    assert links.parent == {}
    assert links.unresolved["corr"] == "ambiguous"


def test_subtype_breaks_the_tie():
    docs = [
        doc("orig_contract", "A", "exchange", "20250418", subtype="계약체결"),
        doc("orig_other", "A", "exchange", "20250418", subtype="투자판단"),
        doc("corr", "A", "exchange", "20250611", subtype="계약체결",
            text=EXCHANGE_CORRECTION, correction=True),
    ]
    links = CorrectionLinks.build(docs)
    assert links.parent == {"corr": "orig_contract"}


def test_no_cross_company_link():
    docs = [
        doc("orig", "B", "exchange", "20250418", subtype="계약체결"),
        doc("corr", "A", "exchange", "20250611", subtype="계약체결",
            text=EXCHANGE_CORRECTION, correction=True),
    ]
    assert CorrectionLinks.build(docs).parent == {}


def test_deep_chain_resolves_to_single_root():
    """상한에 걸려 chain이 쪼개지면 안 된다 — 실제로 15건짜리 chain에서 났던 버그."""
    docs = [doc("d0", "A", "exchange", "20230101", subtype="계약체결")]
    prev_date = "20230101"
    for i in range(1, 12):
        date = f"2023{i + 1:02d}01"
        text = f"정정관련 공시서류제출일 {prev_date[:4]}-{prev_date[4:6]}-{prev_date[6:]}"
        docs.append(doc(f"d{i}", "A", "exchange", date, subtype="계약체결",
                        text=text, correction=True))
        prev_date = date
    links = CorrectionLinks.build(docs)
    assert links.root_of["d11"] == "d0"
    assert len(links.chain("d11")) == 12


# ---------- 검색 통합 ----------

@pytest.fixture
def chain_index():
    body = "계약금액 최근매출액 매출액대비 계약상대 계약기간 아미랄 프로젝트"
    docs = [doc("orig", "A", "exchange", "20230626", subtype="계약체결",
                text=body + " 계약금액 3,000,000,000,000", corp_name="현대건설")]
    prev = "20230626"
    for i, date in enumerate(("20240215", "20250418", "20260120"), start=1):
        text = (f"정정관련 공시서류제출일 {prev[:4]}-{prev[4:6]}-{prev[6:]} " + body
                + f" 계약금액 3,00{i},000,000,000")
        docs.append(doc(f"corr{i}", "A", "exchange", date, subtype="계약체결",
                        text=text, correction=True, corp_name="현대건설"))
        prev = date
    corp_dict = CorpDictionary.from_rows(
        [{"corp_name": "현대건설", "listed_name": "현대건설", "stock_code": "000720"}])
    return DocumentIndex(docs, corp_dict)


def test_chain_is_built_lazily_from_documents(chain_index):
    assert chain_index.links.stats()["links"] == 3
    assert len(chain_index.links.chain("corr3")) == 4


def test_recency_lifts_latest_chain_member(chain_index):
    """최신본을 물으면 chain 안에서 최신 문서의 순위가 올라간다.

    "최신이면 무조건 1위"는 아니다 — 가산은 결과 점수 폭의 몇 %로 제한돼 있어
    같은 사건 안의 순서만 바꾸고 어휘 근거를 뒤집지는 않는다.
    """
    q = "현대건설 아미랄 프로젝트의 최신 유효 계약금액"
    chain_index.chain_recency = False
    before = [h.doc_id for h in chain_index.search(q, k=4)].index("corr3")
    chain_index.chain_recency = True
    after = [h.doc_id for h in chain_index.search(q, k=4)].index("corr3")
    assert after < before


def test_recency_not_applied_without_latest_keyword(chain_index):
    hits = chain_index.search("현대건설 아미랄 프로젝트 계약금액", k=4)
    assert all("recency" not in h.components for h in hits)


def test_recency_is_disabled_by_flag(chain_index):
    chain_index.chain_recency = False
    hits = chain_index.search("현대건설 아미랄 프로젝트의 최신 계약금액", k=4)
    assert all("recency" not in h.components for h in hits)


def test_rank_only_mode_does_not_add_candidates(chain_index):
    """기본 모드는 후보를 늘리지 않는다 — 실측에서 확장은 이득 0, 회귀 1건이었다."""
    chain_index.chain_mode = "rank_only"
    hits = chain_index.search("현대건설 아미랄 프로젝트의 최신 계약금액", k=10)
    assert all("chain_from" not in h.components for h in hits)


def test_chain_expansion_recovers_document_cut_by_period_filter(chain_index):
    """확장이 실제로 무언가를 되살리는 유일한 경우.

    질문이 2026년을 지목하면 기간 hard filter가 2023~2025년 문서를 잘라낸다.
    chain은 하나의 사건이므로 확장에서는 기간 조건을 적용하지 않는다.
    (Gold 25문항에서는 이런 anchor가 0건이었다 — 그래서 기본값은 여전히 off다.)
    """
    q = "현대건설 아미랄 프로젝트 2026년 계약금액"
    chain_index.chain_mode = "off"
    assert "orig" not in [h.doc_id for h in chain_index.search(q, k=10)]

    chain_index.chain_mode = "chain"
    chain_index.weights = Weights(chain_seed_k=5)
    hits = chain_index.search(q, k=10)
    recovered = [h for h in hits if h.doc_id == "orig"]
    assert recovered and "chain_from" in recovered[0].components


def test_chain_expansion_cannot_outrank_a_documents_own_score(chain_index):
    """확장 문서는 seed 점수의 일부만 물려받는다 — 자기 점수가 더 높으면 그대로 둔다.

    정정 공시는 원공시 내용을 다시 적기 때문에 chain 구성원끼리 어휘가 거의 같고,
    그래서 확장은 순위를 바꾸지 못한다. Gold 25문항에서 확장의 이득이 0이었던 이유다.
    """
    chain_index.chain_mode = "chain"
    chain_index.weights = Weights(chain_seed_k=1)
    hits = chain_index.search("현대건설 아미랄 프로젝트 계약금액", k=10)
    assert all("chain_from" not in h.components for h in hits)


def test_chain_mode_off_leaves_ranking_untouched(chain_index):
    chain_index.chain_mode = "off"
    hits = chain_index.search("현대건설 아미랄 프로젝트의 최신 계약금액", k=4)
    assert all("recency" not in h.components and "chain_from" not in h.components
               for h in hits)
