"""④ retriever_adapter — B/D 바인딩·Chunk/Node 계약·locator·세그먼트·dense 주입. LLM·코퍼스 없음."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from dart_corpus.retrieval import DocumentIndex
from dart_corpus.retrieval.conditions import QueryConditions
from dart_corpus.retrieval.corp_dictionary import CorpDictionary
from dart_corpus.retrieval.node_store import NodeStore, build_index
from dart_corpus.retrieval.segments import conditions_from_dict, hard_condition_count, segment_of
from dart_detective import retriever_adapter as ra
from dart_detective.corpus_retriever import CorpusRetriever

UNIVERSE_ROWS = [
    {"corp_name": "HMM", "listed_name": "HMM", "stock_code": "011200"},
    {"corp_name": "삼성SDI", "listed_name": "삼성SDI", "stock_code": "006400"},
]
SUMMARY_ROWS = [["구분", "제 52 기 (2025.12)", "제 51 기 (2024.12)"],
                ["매출액", "10,891,443", "8,400,969"],
                ["영업이익", "1,461,202", "584,770"]]
SUMMARY_TEXT = "\n".join(" | ".join(r) for r in SUMMARY_ROWS)


def _cell(text):
    return {"row": 0, "col": 0, "text": text, "rowspan": 1, "colspan": 1, "tag": "TD"}


def _raw_doc(doc_id: str) -> dict:
    return {
        "doc_id": doc_id, "schema_version": "1.0", "parser_version": "1.0.0",
        "corpus_snapshot_id": "snap_test", "source_files": [], "warnings": [], "parse_quality": None,
        "nodes": [
            {"kind": "section", "node_id": f"{doc_id}::n0", "title_text": "III. 재무에 관한 사항",
             "section_hierarchy": [], "source": None, "section_id": "s0", "parent_section_id": None,
             "level": 1, "level_confident": True, "start_order_index": 0, "end_order_index": 1},
            {"kind": "table", "node_id": f"{doc_id}::n1",
             "section_hierarchy": ["III. 재무에 관한 사항", "1. 요약재무정보"], "source": None,
             "raw_cells": [_cell(c) for r in SUMMARY_ROWS for c in r],
             "raw_rows": [[_cell(c) for c in r] for r in SUMMARY_ROWS],
             "normalized_rows": SUMMARY_ROWS, "header_row_indices": [0], "n_declared_cols": 3,
             "actual_col_counts": [3, 3, 3], "normalized_title_guess": None, "title_confirmed": False,
             "unit_text": "백만원", "period_text": None,
             "consolidation_basis": None, "consolidation_basis_reason": None},
        ],
    }


@pytest.fixture
def adapter_parts(tmp_path: Path):
    ir_dir = tmp_path / "document_ir"; ir_dir.mkdir()
    docs = {"periodic": [_raw_doc("periodic_20260318000001"), _raw_doc("periodic_20260318000002")],
            "exchange": [], "holding": [], "major": []}
    for group, rows in docs.items():
        with (ir_dir / f"{group}.jsonl").open("w", encoding="utf-8") as f:
            for d in rows:
                f.write(json.dumps(d, ensure_ascii=False) + "\n")
    manifest = tmp_path / "manifest.jsonl"
    with manifest.open("w", encoding="utf-8") as f:
        for did, corp in (("periodic_20260318000001", "HMM"), ("periodic_20260318000002", "삼성SDI")):
            f.write(json.dumps({"doc_id": did, "corp_code": "0", "corp_name": corp, "flr_nm": corp,
                                "doc_group": "periodic", "doc_subtype": "annual",
                                "report_nm": "사업보고서 (2025.12)", "rcept_dt": "20260318",
                                "base_year": 2025, "base_month": 12, "is_correction": False},
                               ensure_ascii=False) + "\n")
    out = tmp_path / "index"
    build_index(ir_dir, manifest, out)
    corp = CorpDictionary.from_rows(UNIVERSE_ROWS)
    index = DocumentIndex.from_jsonl(out / "doc_index.jsonl", corp)
    store = NodeStore(out, ir_dir)
    retriever = CorpusRetriever(document_index=index, corp_dict=corp, docs_by_id=store)
    return retriever, store


# ---------- segments.py (vFINAL 1번) ----------

def test_hard_condition_count_and_segment():
    assert hard_condition_count(QueryConditions()) == 0
    low = QueryConditions(corps=frozenset({"HMM"}), years=frozenset({2025}))
    assert hard_condition_count(low) == 2 and segment_of(low) == "LOW"
    high = QueryConditions(corps=frozenset({"HMM"}), years=frozenset({2025}),
                           doc_groups=frozenset({"periodic"}))
    assert hard_condition_count(high) == 3 and segment_of(high) == "HIGH"
    two_corps = QueryConditions(corps=frozenset({"HMM", "삼성SDI"}), year_months=frozenset({(2025, 3)}))
    assert hard_condition_count(two_corps) == 3


def test_conditions_round_trip_through_dict():
    cond = QueryConditions(corps=frozenset({"HMM"}), years=frozenset({2025}),
                           year_months=frozenset({(2025, 3)}), doc_groups=frozenset({"periodic"}),
                           major_labels=frozenset({"유상증자결정"}), correction=True,
                           candidate_terms=("매출액",))
    assert conditions_from_dict(cond.as_dict()) == cond
    assert conditions_from_dict(json.loads(json.dumps(cond.as_dict()))) == cond


# ---------- locator ----------

def test_locator_grammar():
    assert ra.locator_of("holding_20240403000410", 1) == "holding_20240403000410/20240403000410.xml#node=1"
    assert ra.rcept_no_of("periodic_x") == ""


# ---------- D arm ----------

def test_d_arm_search_returns_chunk_contract(adapter_parts):
    retriever, store = adapter_parts
    ad = ra.LineWindowAdapter(retriever, store, arm="D")
    chunks = ad.search("HMM의 2025년 매출액은 얼마인가?", k=5)
    assert chunks, "합성 코퍼스에서 청크가 나와야 한다"
    c = chunks[0]
    assert set(c) == {"chunk_id", "doc_id", "node_index", "locator", "text", "header",
                      "section_path", "doc_group", "score", "metadata"}
    assert c["doc_id"] == "periodic_20260318000001"                   # HMM 문서만 (기업 hard 조건)
    assert c["node_index"] == 1 and c["locator"].endswith("#node=1")
    assert "매출액" in c["text"] and c["doc_group"] == "periodic"
    # "매출액"에서 문서군(periodic)이 추론되어 기업+연도+문서군 = 3 → HIGH (vFINAL 1번 규칙 그대로)
    assert ad.last["segment"] == "HIGH" and ad.last["dense_reranked"] is False
    assert isinstance(ad, ra.RetrieverAdapter)


def test_precomputed_conditions_are_used_not_reextracted(adapter_parts):
    retriever, store = adapter_parts
    ad = ra.LineWindowAdapter(retriever, store, arm="D")
    pre = QueryConditions(corps=frozenset({"삼성SDI"}), years=frozenset({2025})).as_dict()
    chunks = ad.search("HMM의 2025년 매출액은 얼마인가?", conditions=pre, k=5)
    assert chunks and all(c["doc_id"] == "periodic_20260318000002" for c in chunks)
    assert ad.last["conditions"]["corps"] == ["삼성SDI"]


def test_fetch_node_contract(adapter_parts):
    retriever, store = adapter_parts
    ad = ra.LineWindowAdapter(retriever, store, arm="D")
    node = ad.fetch_node("periodic_20260318000001", 1)
    assert set(node) == {"doc_id", "node_index", "kind", "section_path", "lines", "text"}
    assert node["kind"] == "table" and node["lines"][1].startswith("매출액")
    assert node["section_path"] == ["III. 재무에 관한 사항", "1. 요약재무정보"]


def test_d_readiness(adapter_parts):
    retriever, store = adapter_parts
    r = ra.LineWindowAdapter(retriever, store, arm="D").readiness()
    assert r["ready"] is True and r["arm"] == "D" and r["dense"] == "off"
    assert r["pins"]["strategy"] == "line_window" and "document_ir" in r["pins"]


# ---------- B arm ----------

class _FakeDense:
    model_rev = "test-rev"

    def __init__(self):
        self.calls = 0

    def rerank(self, question, chunks):
        self.calls += 1
        return list(reversed(chunks))


def test_b_arm_without_dense_is_not_ready_and_refuses_low(adapter_parts):
    retriever, store = adapter_parts
    ad = ra.LineWindowAdapter(retriever, store, arm="B")
    assert ad.readiness()["ready"] is False and ad.readiness()["dense"] == "absent"
    with pytest.raises(RuntimeError):
        ad.search("HMM의 매출액은 얼마인가?", k=5)                 # 조건 2개(기업·문서군) = LOW → dense 필요


def test_b_arm_reranks_only_low_segment(adapter_parts):
    retriever, store = adapter_parts
    dense = _FakeDense()
    ad = ra.LineWindowAdapter(retriever, store, arm="B", dense=dense)
    assert ad.readiness()["ready"] is True
    assert ad.readiness()["pins"]["dense_model_rev"] == "test-rev"
    low_q = "HMM의 매출액은 얼마인가?"                               # 기업·문서군 = 2 → LOW
    base = ra.LineWindowAdapter(retriever, store, arm="D").search(low_q, k=5)
    low = ad.search(low_q, k=5)
    assert base and ad.last["segment"] == "LOW"
    assert dense.calls == 1 and ad.last["dense_reranked"] is True
    assert [c["chunk_id"] for c in low] == [c["chunk_id"] for c in reversed(base)]
    ad.search("HMM의 2025년 매출액은 얼마인가?", k=5)                 # 기업·연도·문서군 = 3 → HIGH
    assert dense.calls == 1 and ad.last["segment"] == "HIGH" and ad.last["dense_reranked"] is False


# ---------- bind ----------

def test_bind_rejects_unknown_and_defers_ac(monkeypatch):
    with pytest.raises(ValueError):
        ra.bind("Z")
    with pytest.raises(NotImplementedError):
        ra.bind("A")
    monkeypatch.setenv("DART_QA_ARM", "C")
    with pytest.raises(NotImplementedError):
        ra.bind()
