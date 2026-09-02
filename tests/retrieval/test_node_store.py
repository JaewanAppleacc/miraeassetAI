"""NodeStore — offset 색인 빌드·지연 로딩·evidence document 변환·node_to_text 동치."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from dart_corpus.chunking.node_text import node_to_text
from dart_corpus.parsing.serialization import _node_from_dict
from dart_corpus.retrieval import node_store
from dart_corpus.retrieval.node_store import NodeStore, build_index, node_dict_to_text

REPO = Path(__file__).resolve().parents[2]
REPRESENTATIVE = REPO / "data" / "artifacts" / "handoff" / "representative_documents.jsonl"


def _cell(text):
    return {"row": 0, "col": 0, "text": text, "rowspan": 1, "colspan": 1, "tag": "TD"}


def _raw_doc(doc_id: str, with_table_title: bool = True) -> dict:
    """합성 raw DocumentIR — section / paragraph / table 노드 하나씩."""
    return {
        "doc_id": doc_id, "schema_version": "1.0", "parser_version": "1.0.0",
        "corpus_snapshot_id": "snap_test", "source_files": [], "warnings": [], "parse_quality": None,
        "nodes": [
            {"kind": "section", "node_id": f"{doc_id}::n0", "title_text": " 1. 요약재무정보 ",
             "section_hierarchy": [], "source": None, "section_id": "s0", "parent_section_id": None,
             "level": 1, "level_confident": True, "start_order_index": 0, "end_order_index": 2},
            {"kind": "paragraph", "node_id": f"{doc_id}::n1", "text": "당사는 반도체를 만든다. ",
             "section_hierarchy": ["1. 요약재무정보"], "source": None, "is_footnote_like": False},
            {"kind": "table", "node_id": f"{doc_id}::n2", "section_hierarchy": ["1. 요약재무정보"],
             "source": None,
             "raw_cells": [_cell("구분"), _cell("2025"), _cell("매출액"), _cell("10")],
             "raw_rows": [[_cell("구분"), _cell("2025")], [_cell("매출액"), _cell("10")]],
             "normalized_rows": [["구분", "2025"], ["매출액", "10"]],
             "header_row_indices": [0], "n_declared_cols": 2, "actual_col_counts": [2, 2],
             "normalized_title_guess": "요약 손익", "title_confirmed": with_table_title,
             "unit_text": "백만원", "period_text": None,
             "consolidation_basis": None, "consolidation_basis_reason": None},
        ],
    }


@pytest.fixture
def built(tmp_path: Path):
    ir_dir = tmp_path / "document_ir"
    ir_dir.mkdir()
    docs = {
        "exchange": [_raw_doc("exchange_20240101000001")],
        "holding": [_raw_doc("holding_20240102000002", with_table_title=False),
                    _raw_doc("holding_20240103000003")],
        "major": [], "periodic": [],
    }
    for group, rows in docs.items():
        with (ir_dir / f"{group}.jsonl").open("w", encoding="utf-8") as f:
            for d in rows:
                f.write(json.dumps(d, ensure_ascii=False) + "\n")
    manifest = tmp_path / "manifest.jsonl"
    with manifest.open("w", encoding="utf-8") as f:
        for did, corp, flr in (("exchange_20240101000001", "삼성전자", "삼성전자"),
                               ("holding_20240102000002", "아모레퍼시픽", "Massachusetts FSC")):
            f.write(json.dumps({"doc_id": did, "corp_code": "00000001", "corp_name": corp,
                                "flr_nm": flr, "doc_group": did.split("_")[0], "doc_subtype": "",
                                "report_nm": "사업보고서 (2024.12)", "rcept_dt": "20250315",
                                "base_year": 2024, "base_month": 12, "is_correction": False},
                               ensure_ascii=False) + "\n")
    out = tmp_path / "index"
    summary = build_index(ir_dir, manifest, out, text_cap=50)
    return ir_dir, out, summary


def test_build_writes_offsets_index_and_manifest(built):
    ir_dir, out, summary = built
    assert summary["n_docs"] == 3
    assert summary["files"]["holding.jsonl"]["n_docs"] == 2
    assert summary["n_missing_manifest"] == 1                     # holding_…0003 은 manifest에 없다
    assert (out / node_store.OFFSETS_NAME).exists()
    assert (out / node_store.DOC_INDEX_NAME).exists()
    assert (out / node_store.MANIFEST_NAME).exists()
    rows = [json.loads(l) for l in (out / node_store.DOC_INDEX_NAME).open(encoding="utf-8")]
    by_id = {r["doc_id"]: r for r in rows}
    assert by_id["holding_20240102000002"]["filer_name"] == "Massachusetts FSC"
    assert by_id["exchange_20240101000001"]["base_year"] == 2024
    assert len(by_id["exchange_20240101000001"]["text"]) <= 50
    assert by_id["holding_20240103000003"]["doc_group"] == "holding"   # manifest 없어도 그룹은 채운다


def test_store_is_a_lazy_mapping_and_returns_evidence_documents(built):
    ir_dir, out, _ = built
    store = NodeStore(out, ir_dir, cache_size=1)
    assert len(store) == 3 and "holding_20240102000002" in store and "nope" not in store
    doc = store["exchange_20240101000001"]
    assert set(doc) == {"doc_id", "doc_group", "nodes"}
    assert doc["doc_group"] == "exchange"
    assert [n["node_index"] for n in doc["nodes"]] == [0, 1, 2]
    assert set(doc["nodes"][0]) == {"node_index", "kind", "text", "section_hierarchy"}
    assert doc["nodes"][0]["text"] == "1. 요약재무정보"
    assert doc["nodes"][1]["text"] == "당사는 반도체를 만든다."
    assert doc["nodes"][2]["text"] == "요약 손익\n구분 | 2025\n매출액 | 10"
    # raw 필드는 가공본에 없다 — 메모리를 아끼는 이유
    assert "raw_cells" not in doc["nodes"][2]
    with pytest.raises(KeyError):
        store["nope"]
    store.close()


def test_fetch_node_and_lines(built):
    ir_dir, out, _ = built
    store = NodeStore(out, ir_dir)
    node = store.fetch_node("holding_20240102000002", 2)
    assert node["doc_id"] == "holding_20240102000002" and node["node_index"] == 2
    assert node["kind"] == "table"
    assert node["lines"] == ["구분 | 2025", "매출액 | 10"]          # title_confirmed=False → 제목 없음
    with pytest.raises(KeyError):
        store.fetch_node("holding_20240102000002", 3)
    store.close()


def test_cache_evicts_but_stays_correct(built):
    ir_dir, out, _ = built
    store = NodeStore(out, ir_dir, cache_size=1)
    a = store["exchange_20240101000001"]
    b = store["holding_20240102000002"]
    assert len(store._cache) == 1
    assert store["exchange_20240101000001"]["doc_id"] == a["doc_id"]
    assert store["holding_20240102000002"]["doc_id"] == b["doc_id"]
    store.close()


def test_size_mismatch_is_detected(built):
    ir_dir, out, _ = built
    with (ir_dir / "major.jsonl").open("a", encoding="utf-8") as f:
        f.write("\n")
    with pytest.raises(RuntimeError):
        NodeStore(out, ir_dir)


def test_readiness_pins(built):
    ir_dir, out, summary = built
    store = NodeStore(out, ir_dir)
    r = store.readiness()
    assert r["n_docs"] == 3
    assert r["pins"]["document_ir"]["holding.jsonl"] == summary["files"]["holding.jsonl"]["sha256"]
    assert r["pins"]["text_recipe"] == node_store.TEXT_RECIPE
    store.close()


@pytest.mark.skipif(not REPRESENTATIVE.exists(), reason="대표 문서 파일 없음")
def test_dict_text_matches_node_to_text_on_representative_documents():
    """dict 변환이 IR 객체 변환(node_text.node_to_text)과 byte 동일해야 Gold locator 대조가 유지된다."""
    n_docs = n_nodes = 0
    with REPRESENTATIVE.open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            raw = json.loads(line)
            for node in raw.get("nodes") or []:
                assert node_dict_to_text(node) == node_to_text(_node_from_dict(node)).strip()
                n_nodes += 1
            n_docs += 1
    assert n_docs >= 5 and n_nodes > 100
