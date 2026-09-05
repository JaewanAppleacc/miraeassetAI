"""Regression tests for the FOURARM-SCORER-MULTINODE-FIX-V1 patch.

Imports the committed patched module directly by path (not the gitignored
local runtime copy), so these tests validate exactly the artifact recorded
in this directory's README.md (SHA-256
4a717350d697ebac343f80d61bd335e98519dd2884a169316af1284740f9b804).

Uses a minimal fake NodeStore (not the real ~8.5GB DocumentIR) so these tests
are hermetic and fast -- they exercise check_locators()/slot_found() logic
directly, never real retrieval/embedding/ranking, and touch no Gold file
beyond in-memory synthetic fixtures built with the module's own dataclasses.

Run: PYTHONIOENCODING=utf-8 python3 -m pytest domain/agent-comparison/four-arm-ac/scorer-patch-multinode-v1/test_multinode_fix.py -v
"""
import importlib.util
import sys
from pathlib import Path

import pytest

_PATCHED_PATH = Path(__file__).resolve().parent / "fourarm.patched.py"
_spec = importlib.util.spec_from_file_location("fourarm_patched", _PATCHED_PATH)
fourarm = importlib.util.module_from_spec(_spec)
sys.modules["fourarm_patched"] = fourarm
_spec.loader.exec_module(fourarm)


class FakeStore:
    """Minimal stand-in for dart_corpus.retrieval.node_store.NodeStore."""

    def __init__(self, docs):
        # docs: {doc_id: [node_text, node_text, ...]}
        self._docs = docs

    def __contains__(self, doc_id):
        return doc_id in self._docs

    class _Loc:
        def __init__(self, n_nodes):
            self.n_nodes = n_nodes

    def location(self, doc_id):
        return self._Loc(len(self._docs[doc_id]))

    def fetch_node(self, doc_id, node_index):
        return {"text": self._docs[doc_id][node_index]}


def gq(question_id, slot_name, sources):
    """sources: list of (doc_id, node_index, evidence_span, row, col)."""
    gsources = [fourarm.GoldSource(doc, n, span, row, col) for doc, n, span, row, col in sources]
    slot = fourarm.GoldSlot(slot_name, gsources)
    return fourarm.GoldQuestion(question_id, "HIGH", [slot], set())


def result_item(doc_id, node_index, text, node_indices=None, row=None, col=None):
    return {"doc_id": doc_id, "node_index": node_index, "node_indices": node_indices or [],
            "text": text, "row": row, "col": col, "chunk_id": "chunk_test", "rank": 1,
            "score": 1.0, "score_type": "dense"}


def run_check_locators(gquestion, results, store):
    slot = gquestion.slots[0]
    found, r, method, src, state = fourarm.slot_found(slot, results, fourarm.EVAL_K, store=store)
    assert found, "fixture must produce a match for the test to be meaningful"
    qs = fourarm.QuestionScore(gquestion.question_id, "HIGH", 1, excluded=False)
    qs.slot_matches.append({
        "slot_name": slot.slot_name, "method": method, "result": dict(r),
        "gold_row_col": (src.row, src.col) if src else None,
        "gold_span": src.span if src else "",
        "gold_node": src.node_index if src else None,
        "span_state": state,
        "norm_only": False,
    })
    return fourarm.check_locators(qs, store), (found, method, state)


# ---------- 1. Gold node == primary node_index, evidence matches -> found ----------

def test_gold_node_is_primary_node_index_and_matches_is_found():
    doc = "doc_a"
    store = FakeStore({doc: ["header text", "매출액 | 100,000,000"]})
    gquestion = gq("q1", "revenue", [(doc, 1, "매출액 | 100,000,000", None, None)])
    results = [result_item(doc, 1, "매출액 | 100,000,000")]
    violations, (found, method, state) = run_check_locators(gquestion, results, store)
    assert found and method == "node" and state == "verified"
    assert violations == []


# ---------- 2. Gold node != primary but in node_indices, evidence matches -> found + minor ----------

def test_gold_node_in_node_indices_not_primary_with_table_rendering_diff_is_minor():
    doc = "doc_b"
    # Mirrors the real-world pattern (verified against major_20250205000509 node 1):
    # empty table cells occupy their OWN separate lines in the canonical NodeStore
    # text; the retrieval index's own table serialization drops those empty-cell
    # lines entirely rather than mixing empty cells into the content line.
    store = FakeStore({doc: ["header", " | \n |  | \n자기주식 처분 | 6,324\n | "]})
    gquestion = gq("q2", "event_detail", [(doc, 1, "자기주식 처분 | 6,324", None, None)])
    chunk_text = "header\n자기주식 처분 | 6,324"
    results = [result_item(doc, 0, chunk_text, node_indices=[0, 1])]
    violations, (found, method, state) = run_check_locators(gquestion, results, store)
    assert found
    assert len(violations) == 1
    assert violations[0]["severity"] == "minor"
    assert violations[0]["reason"] == "same_evidence_table_rendering_difference"


# ---------- 3. multi-node chunk, formatting-only difference -> minor, slot stays found ----------

def test_multi_node_pure_formatting_difference_stays_found_and_minor():
    doc = "doc_c"
    store = FakeStore({doc: ["회사명 | 테스트", " | | \n매출 | 1,000\n | | "]})
    gquestion = gq("q3", "revenue2", [(doc, 1, "매출 | 1,000", None, None)])
    chunk_text = "회사명 | 테스트\n매출 | 1,000"
    results = [result_item(doc, 0, chunk_text, node_indices=[0, 1])]
    violations, (found, method, state) = run_check_locators(gquestion, results, store)
    assert found is True
    assert all(v["severity"] != "critical" for v in violations)
    assert all(v["severity"] != "unresolved" for v in violations)


# ---------- 4. Gold node in candidates but the VALUE differs -> not auto-minor (critical/unresolved path unaffected) ----------

def test_gold_node_in_candidates_but_value_differs_is_not_auto_minor():
    doc = "doc_d"
    store = FakeStore({doc: ["header", "매출액 | 999,999,999"]})
    gquestion = gq("q4", "revenue3", [(doc, 1, "매출액 | 100,000,000", None, None)])
    # chunk's own recorded text reports a DIFFERENT value than Gold's evidence line,
    # and node 1's own canonical text (same as the chunk here) never contains Gold's
    # required value either -- neither side can verify the claim, so this is the
    # existing "unverified" span_state, deferred to Owner via gold_span_not_verifiable
    # (a different UNRESOLVED reason, untouched by this patch) -- NOT auto-minor.
    chunk_text = "header\n매출액 | 999,999,999"
    results = [result_item(doc, 0, chunk_text, node_indices=[0, 1])]
    violations, (found, method, state) = run_check_locators(gquestion, results, store)
    assert found is True and state == "unverified"
    assert len(violations) == 1
    assert violations[0]["reason"] == "gold_span_not_verifiable"
    assert violations[0]["severity"] == "unresolved"


# ---------- 5. Gold node in candidates but the PERIOD/fiscal column differs -> critical (unaffected by patch) ----------

def test_different_period_same_document_different_node_is_critical():
    doc = "doc_e"
    gquestion = gq("q5", "fy_value", [(doc, 5, "2023년 매출 | 500", None, None)])
    # Retrieved via a DIFFERENT node not in Gold's acceptable set, reporting a DIFFERENT year.
    chunk_text = "2024년 매출 | 700"
    results = [result_item(doc, 9, chunk_text, node_indices=[9])]
    store = FakeStore({doc: ["x"] * 10})
    slot = gquestion.slots[0]
    found, r, method, src, state = fourarm.slot_found(slot, results, fourarm.EVAL_K, store=store)
    assert found is False  # no line of Gold's own evidence matches this different-year text at all


# ---------- 6. Same document, different node, SAME value, Gold node NOT in candidates -> no automatic pass ----------

def test_same_value_different_node_not_in_gold_candidates_is_not_auto_resolved():
    doc = "doc_f"
    gquestion = gq("q6", "amount", [(doc, 2, "총액계정금액 | 5,000,000", None, None)])
    # a different node (not Gold's own) that happens to repeat the identical figure --
    # node 7's own canonical text must match the chunk for this to be a genuine
    # text-method "duplicate evidence", not a claim_text_not_in_node data problem.
    chunk_text = "총액계정금액 | 5,000,000"
    results = [result_item(doc, 7, chunk_text, node_indices=[7])]
    store = FakeStore({doc: ["x"] * 7 + [chunk_text] + ["x"] * 2})
    violations, (found, method, state) = run_check_locators(gquestion, results, store)
    assert found is True
    assert method == "text"
    # must remain the existing duplicate_evidence_different_node UNRESOLVED path --
    # never silently classified as minor/passed just because the node matched.
    assert len(violations) == 1
    assert violations[0]["reason"] == "duplicate_evidence_different_node"
    assert violations[0]["severity"] == "unresolved"


# ---------- 7. Consolidated vs separate financial statement value confusion -> critical path unaffected ----------

def test_consolidated_vs_separate_value_confusion_not_auto_minor():
    doc = "doc_g"
    gquestion = gq("q7", "op_income", [(doc, 3, "연결 영업이익 금액 | 1,200,000", None, None)])
    chunk_text = "별도 영업이익 금액 | 900,000"  # different statement, different value
    results = [result_item(doc, 3, chunk_text, node_indices=[3])]
    store = FakeStore({doc: ["x", "x", "x", chunk_text]})
    # Gold's own consolidated-figure line never appears in the chunk, and node 3's own
    # canonical text (the separate-statement figure) doesn't contain it either -- this
    # is the existing "unverified" deferral, not an automatic critical or minor call;
    # the patch must not manufacture a false pass here.
    violations, (found, method, state) = run_check_locators(gquestion, results, store)
    assert found is True and state == "unverified"
    assert violations[0]["reason"] == "gold_span_not_verifiable"


# ---------- 8. Required evidence present in Gold but truncated at chunk end -> not auto-minor, stays unresolved ----------

def test_partial_recovery_truncated_before_required_value_stays_unresolved():
    doc = "doc_h"
    node1_full = "전환가액 | 1,000\n전환비율 | 50%\n행사일 | 2025-01-01"
    store = FakeStore({doc: ["header", node1_full]})
    gquestion = gq("q8", "exercise_date", [(doc, 1, "행사일 | 2025-01-01", None, None)])
    # chunk's OWN recorded text is a genuine (empty-row-clean) excerpt of node 1, but
    # truncated before reaching the specific "행사일" line Gold requires.
    chunk_text = "header\n전환가액 | 1,000\n전환비율 | 50%"
    results = [result_item(doc, 0, chunk_text, node_indices=[0, 1])]
    slot = gquestion.slots[0]
    found, r, method, src, state = fourarm.slot_found(slot, results, fourarm.EVAL_K, store=store)
    # Gold's required line is genuinely absent from the chunk -- no match at all,
    # exactly like the real u-a2e6569d0ac5 case; the patch must never fabricate one.
    assert found is False


# ---------- table-aware normalization: pure unit tests ----------

def test_table_aware_norm_strips_only_structurally_empty_rows():
    raw = "실제 내용\n | | | \n다음 내용\n   \n"
    assert fourarm._table_aware_norm(raw) == "실제내용다음내용"


def test_table_aware_norm_never_touches_lines_with_real_content():
    raw = "a | b | c\nd|e|f"
    # whitespace collapsed, but no content removed (pipes are real column separators here).
    assert fourarm._table_aware_norm(raw) == fourarm.norm_text(raw)


def test_check_locators_isolation_duplicate_evidence_never_reaches_patch_branch():
    """The patch only ever executes inside the claim_text_not_in_node condition;
    a duplicate_evidence_different_node violation (B/D's own 100% population) must
    be produced by a structurally different branch untouched by this patch."""
    doc = "doc_i"
    gquestion = gq("q9", "slotx", [(doc, 2, "특정계정금액 | 4,200,000", None, None)])
    chunk_text = "특정계정금액 | 4,200,000"
    results = [result_item(doc, 9, chunk_text, node_indices=[9])]
    store = FakeStore({doc: ["x"] * 9 + [chunk_text]})
    violations, _ = run_check_locators(gquestion, results, store)
    assert violations[0]["reason"] == "duplicate_evidence_different_node"
    # gold_node (2) is provably NOT in the candidate set (9, [9]) -- confirms the
    # patch's own guard condition would not have even engaged for this packet.
    assert 2 not in fourarm._result_nodes(results[0])


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
