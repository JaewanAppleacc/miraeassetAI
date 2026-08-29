"""BM25와 metadata의 결합 방식 테스트.

핵심 성질 하나를 고정한다: **BM25 점수의 절대 크기가 달라져도 metadata의 영향력이
같아야 한다.** 실측에서 후보 풀의 BM25 최댓값이 질문마다 17.7~77.9로 4.4배 달랐고,
그래서 같은 상수 boost가 상위 점수의 7.7%~34.0%로 작용했다.
"""
from __future__ import annotations

import pytest

from dart_corpus.retrieval.conditions import extract_conditions
from dart_corpus.retrieval.corp_dictionary import CorpDictionary
from dart_corpus.retrieval.document_index import DocumentIndex, IndexedDocument, Weights


class FakeBM25:
    """문서별 BM25 점수를 그대로 돌려주는 스텁. scale로 전체 크기만 바꾼다."""

    def __init__(self, scores: list[float], scale: float = 1.0):
        self.scores = scores
        self.scale = scale

    def score(self, query_tokens, index: int) -> float:  # noqa: ARG002
        return self.scores[index] * self.scale


def doc(doc_id, group, text="본문", subtype=""):
    return IndexedDocument(
        doc_id=doc_id, corp_name="테스트기업", corp_code="A", filer_name="테스트기업",
        doc_group=group, doc_subtype=subtype, report_nm="", rcept_dt="20250101",
        base_year=None, base_month=None, is_correction=False, text=text,
    )


@pytest.fixture
def corp_dict():
    return CorpDictionary.from_rows(
        [{"corp_name": "테스트기업", "listed_name": "테스트기업", "stock_code": "000001"}])


@pytest.fixture
def two_doc_index(corp_dict):
    """어휘로는 B가 앞서지만 질문이 요구한 공시유형은 A가 맞는 상황."""
    docs = [doc("A_matches_type", "exchange"), doc("B_higher_bm25", "periodic")]
    idx = DocumentIndex(docs, corp_dict, chain_mode="off")
    idx._bm25 = FakeBM25([10.0, 14.0])
    return idx


QUESTION = "테스트기업의 공급계약 계약금액"   # -> doc_groups={"exchange"}


def order(index, question=QUESTION):
    return [h.doc_id for h in index.search(question, k=5)]


# ---------- 스케일 불변성 ----------

def test_maxnorm_ranking_is_invariant_to_bm25_scale(two_doc_index):
    two_doc_index.score_mode = "maxnorm"
    two_doc_index._bm25.scale = 1.0
    small = order(two_doc_index)
    two_doc_index._bm25.scale = 10.0
    large = order(two_doc_index)
    assert small == large


def test_fixed_boost_ranking_flips_with_bm25_scale(two_doc_index):
    """같은 상수 boost가 점수 크기에 따라 다르게 작동한다 — 고치려던 문제 그 자체."""
    two_doc_index.score_mode = "fixed"
    two_doc_index._bm25.scale = 1.0
    small = order(two_doc_index)          # 10+6=16 vs 14  -> A 먼저
    two_doc_index._bm25.scale = 10.0
    large = order(two_doc_index)          # 100+6=106 vs 140 -> B 먼저
    assert small[0] == "A_matches_type"
    assert large[0] == "B_higher_bm25"
    assert small != large


# ---------- 결합식 ----------

def test_maxnorm_normalizes_top_document_to_one(two_doc_index):
    two_doc_index.score_mode = "maxnorm"
    hits = two_doc_index.search(QUESTION, k=5)
    top_bm25 = max(h.components["norm_bm25"] for h in hits)
    assert top_bm25 == pytest.approx(1.0)
    assert all(0.0 <= h.score <= 1.0 for h in hits)


def test_maxnorm_score_is_weighted_average(two_doc_index):
    two_doc_index.score_mode = "maxnorm"
    two_doc_index.weights = Weights(metadata_alpha=0.5)
    hits = {h.doc_id: h for h in two_doc_index.search(QUESTION, k=5)}
    h = hits["A_matches_type"]
    expected = 0.5 * h.components["norm_bm25"] + 0.5 * h.components["norm_meta"]
    assert h.score == pytest.approx(expected, abs=1e-4)


def test_alpha_zero_ignores_metadata(two_doc_index):
    two_doc_index.score_mode = "maxnorm"
    two_doc_index.weights = Weights(metadata_alpha=0.0)
    assert order(two_doc_index)[0] == "B_higher_bm25"


def test_alpha_one_ignores_lexical_score(two_doc_index):
    two_doc_index.score_mode = "maxnorm"
    two_doc_index.weights = Weights(metadata_alpha=1.0)
    assert order(two_doc_index)[0] == "A_matches_type"


def test_fixed_mode_is_plain_sum(two_doc_index):
    """예전 방식은 그대로 보존한다 — 이전 실험 결과를 재현할 수 있어야 한다."""
    two_doc_index.score_mode = "fixed"
    hits = {h.doc_id: h for h in two_doc_index.search(QUESTION, k=5)}
    h = hits["A_matches_type"]
    assert h.score == pytest.approx(h.components["bm25"] + h.components["doctype"])


def test_rrf_mode_reports_component_ranks(two_doc_index):
    two_doc_index.score_mode = "rrf"
    hits = two_doc_index.search(QUESTION, k=5)
    assert all("rank_bm25" in h.components and "rank_meta" in h.components for h in hits)


# ---------- metadata 만점 ----------

def test_metadata_ceiling_counts_only_active_conditions(two_doc_index, corp_dict):
    idx = two_doc_index
    w = idx.weights
    c_group_only = extract_conditions("테스트기업의 공급계약", corp_dict)
    ceiling = idx._metadata_ceiling(c_group_only, n_salient=0)
    # 기업이 잡혔으므로 filer 항목이, 공시유형이 잡혔으므로 group/subtype이 들어간다
    assert ceiling == pytest.approx(w.doc_group + w.doc_subtype + w.filer)


def test_metadata_ceiling_grows_with_salient_terms(two_doc_index, corp_dict):
    idx = two_doc_index
    c = extract_conditions("테스트기업의 공급계약", corp_dict)
    assert (idx._metadata_ceiling(c, n_salient=2)
            == pytest.approx(idx._metadata_ceiling(c, n_salient=0)
                             + 2 * idx.weights.salient_term))


def test_no_conditions_means_metadata_is_ignored(corp_dict):
    """조건이 하나도 안 잡히면 metadata 항이 0이 되고 순수 어휘 순위가 남는다."""
    docs = [doc("A", "exchange"), doc("B", "periodic")]
    idx = DocumentIndex(docs, corp_dict, chain_mode="off", score_mode="maxnorm")
    idx._bm25 = FakeBM25([10.0, 14.0])
    hits = idx.search("아무 조건도 없는 문장", k=5)
    assert hits[0].doc_id == "B"
    assert all(h.components["norm_meta"] == 0.0 for h in hits)
