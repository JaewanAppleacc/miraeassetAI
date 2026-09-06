"""arm_a4_a3_live_adapter contract tests — Turn A4-A3-PLUS-QA-FINAL-INTEGRATION-V1.

All synthetic: a stub ArmA4A3LiveWorkerClient stands in for the real Node subprocess (no real
process, no real Postgres/KURE server needed for these). The real end-to-end path against the
full 442,549-chunk READY index is verified separately (scripts/a4_a3_full_index_smoke.mjs and
this turn's own manual smoke run, documented in the final integration report) — this file never
opens Gold/DEV_TUNE/DEV_CHECK/HOLDOUT and never spawns a real subprocess.

Mirrors tests/agents/test_arm_a_live_adapter.py's structure 1:1 so both backends carry the same
level of adapter-layer contract coverage.
"""
from __future__ import annotations

import hashlib
import json

import pytest

from dart_corpus.retrieval.conditions import QueryConditions
from dart_detective import answer_api, arm_a4_a3_live_adapter as la4
from dart_detective import arm_a_live_adapter as la1
from dart_detective import arm_a_serving_bridge as br
from dart_detective.arm_a4_a3_live_worker_client import (
    ArmA4A3LiveWorkerClient,
    ArmA4A3NotReadyError,
    ArmA4A3SearchFailedError,
)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


SINGLE_TEXT = "A4A3 실제 검색 결과 본문 — 단일 node."
MULTI_TEXT = "A4A3 실제 검색 결과 본문 — 다중 node."

SINGLE_ITEM = {
    "rank": 1, "reranker_rank": 3, "score": 0.62, "document_id": "holding_20240403000410",
    "chunk_id": "chunk_a4a3_0001", "node_index": 5, "node_indices": [5],
    "text": SINGLE_TEXT, "chunk_text_sha256": _sha256(SINGLE_TEXT),
    "locator": {"source_locator": "holding_20240403000410/20240403000410.xml#node=5"},
    "provenance": {"status": "NODE_AND_ROW_RESOLVED", "candidates": [{"node_index": 5}]},
    "metadata": {"corp_code": "00266961"}, "reranker_config": "R4_wide_rrf_centric",
    "a3_decision": "PASS", "backend": "ARM_A4_A3_LIVE",
}
MULTI_ITEM = {
    "rank": 2, "reranker_rank": 7, "score": 0.41, "document_id": "major_20240913000790",
    "chunk_id": "chunk_a4a3_0002", "node_index": None, "node_indices": [9, 10, 11],
    "text": MULTI_TEXT, "chunk_text_sha256": _sha256(MULTI_TEXT),
    "locator": {"source_locator": "major_20240913000790/20240913000790.xml#node=9"},
    "provenance": {"status": "MULTI_NODE_AMBIGUOUS",
                   "candidates": [{"node_index": 9}, {"node_index": 10}, {"node_index": 11}]},
    "metadata": {"corp_code": "00612345"}, "reranker_config": "R4_wide_rrf_centric",
    "a3_decision": "KEEP_UNKNOWN", "backend": "ARM_A4_A3_LIVE",
}


class StubWorkerClient:
    """In-process stand-in for ArmA4A3LiveWorkerClient — no subprocess, no I/O."""

    def __init__(self, *, items=None, ready=True, search_error: Exception | None = None,
                 extra_response=None):
        self._items = items if items is not None else [SINGLE_ITEM, MULTI_ITEM]
        self._ready = ready
        self._search_error = search_error
        self._extra_response = extra_response or {}
        self.search_calls: list[tuple] = []

    def readiness(self):
        return {"arm_a4_a3_live_ready": self._ready, "database_ready": True, "bm25_index_ready": True,
                "kure_ready": True, "kure_revision_match": True, "embedding_dimension": 1024,
                "kure_pin": {"repository": "nlpai-lab/KURE-v1",
                             "revision": "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", "dimension": 1024},
                "retrieval_index_id": "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7",
                "corpus_snapshot_id": "corpus_04750795e1a2d5c3", "reranker_config": "R4_wide_rrf_centric"}

    def search(self, question, conditions, top_k):
        self.search_calls.append((question, conditions, top_k))
        if self._search_error is not None:
            raise self._search_error
        return {"results": self._items[:top_k], **self._extra_response}

    def close(self):
        pass


# ---------- 1-3: pinned production-module blob identity (Section F #1-3) ----------
# These check the ACTUAL blob SHA of the pinned wide-pool/reranker/A3 modules inside the pinned
# a4_a3_source_commit against git, using the devtune worktree if present locally — skipped
# (never silently passed) when that worktree isn't available on this machine.

IMPL_ROOT_CANDIDATE = "/Users/jaewan/Documents/Codex/worktrees/agent-fourarm-a4-a3-devtune-v01"
PINNED_COMMIT = "3ee4462026126a0dd8fc5c99a6d83df510a84058"
PINNED_BLOBS = {
    "domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs": "fedcfcbbafca5cdc873b5c32ec691419b144d4d7",
    "domain/agent-comparison/four-arm-ac/a4-reranker-engine.mjs": "bb7e735d6444fe79fdc22b2e1a6d3ad97684b317",
    "domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs": "7dc7ce510e8c399c2de206870fb479ca1e9a506a",
    "domain/agent-comparison/four-arm-ac/a4-reranker-configs.v1.json": "ded8ac0535f2958fb1357b336f0348a32dada03a",
}


def _git_blob_sha(repo: str, commit: str, relpath: str) -> str | None:
    import subprocess
    try:
        result = subprocess.run(["git", "rev-parse", f"{commit}:{relpath}"], cwd=repo,
                                 capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


import os
_impl_root_available = os.path.isdir(IMPL_ROOT_CANDIDATE)


@pytest.mark.skipif(not _impl_root_available, reason="agent-fourarm-a4-a3-devtune-v01 worktree not present on this machine")
@pytest.mark.parametrize("relpath,expected_blob", list(PINNED_BLOBS.items()))
def test_pinned_module_blob_matches_frozen_commit(relpath, expected_blob):
    actual = _git_blob_sha(IMPL_ROOT_CANDIDATE, PINNED_COMMIT, relpath)
    assert actual == expected_blob, f"{relpath}: blob at {PINNED_COMMIT} is {actual}, expected {expected_blob}"


# ---------- 4: R4 config SHA matches freeze doc ----------

def test_r4_config_sha256_matches_freeze_doc():
    freeze_path = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "A4_A3_PLUS_QA_FINAL_V1_FREEZE.md")
    with open(freeze_path, encoding="utf-8") as f:
        freeze_text = f.read()
    assert "1af2f55c88629542d7118becfd84f6cf598a7df2734c3718bfb01570917ea495" in freeze_text
    assert '"config_id": "R4_wide_rrf_centric"' in freeze_text


# ---------- 5-16: pipeline-mechanics contract — covered upstream, re-asserted at this layer ----------
# Full-ranking/no-truncation/REJECT-only-removal/refill-order/rank-contiguity/original-rank-
# preservation/pool-ceiling/multi-node-preservation are already proven by the pinned, byte-
# identical a4-a3-integration.test.mjs (15 D-tests) inside a4_a3_source_commit — re-implementing
# them here would be redundant, not additional coverage. This layer instead asserts that the
# WORKER/ADAPTER never loses or corrupts what the pipeline already guarantees:

def test_single_item_converts_to_chunk_correctly():
    retriever = la4.ArmA4A3LiveRetriever(StubWorkerClient(items=[SINGLE_ITEM]))
    chunks = retriever.search("아무 새 질문")
    assert len(chunks) == 1
    c = chunks[0]
    assert c["doc_id"] == "holding_20240403000410"
    assert c["chunk_id"] == "chunk_a4a3_0001"
    assert c["node_index"] == 5
    assert c["text"] == SINGLE_TEXT
    assert c["locator"] == SINGLE_ITEM["locator"]
    assert c["metadata"]["provenance"]["node_indices"] == [5]
    assert c["metadata"]["provenance"]["reranker_rank"] == 3
    assert c["metadata"]["provenance"]["a3_decision"] == "PASS"


def test_reranker_rank_preserved_distinct_from_final_rank():
    retriever = la4.ArmA4A3LiveRetriever(StubWorkerClient(items=[SINGLE_ITEM, MULTI_ITEM]))
    chunks = retriever.search("아무 새 질문")
    assert [c["metadata"]["provenance"]["rank"] for c in chunks] == [1, 2]  # final, renumbered
    assert [c["metadata"]["provenance"]["reranker_rank"] for c in chunks] == [3, 7]  # original full ranking


def test_multi_node_indices_fully_preserved():
    retriever = la4.ArmA4A3LiveRetriever(StubWorkerClient(items=[MULTI_ITEM]))
    chunks = retriever.search("아무 새 질문")
    assert chunks[0]["metadata"]["provenance"]["node_indices"] == [9, 10, 11]
    assert chunks[0]["node_index"] == 9


def test_locator_and_provenance_preserved():
    retriever = la4.ArmA4A3LiveRetriever(StubWorkerClient(items=[MULTI_ITEM]))
    chunks = retriever.search("아무 새 질문")
    assert chunks[0]["locator"] == MULTI_ITEM["locator"]
    assert chunks[0]["metadata"]["provenance"]["status"] == "MULTI_NODE_AMBIGUOUS"


def test_rank_order_preserved():
    retriever = la4.ArmA4A3LiveRetriever(StubWorkerClient(items=[SINGLE_ITEM, MULTI_ITEM]))
    chunks = retriever.search("아무 새 질문")
    assert [c["chunk_id"] for c in chunks] == ["chunk_a4a3_0001", "chunk_a4a3_0002"]


def test_top_k_enforced():
    client = StubWorkerClient(items=[SINGLE_ITEM, MULTI_ITEM])
    retriever = la4.ArmA4A3LiveRetriever(client)
    chunks = retriever.search("아무 새 질문", k=1)
    assert len(chunks) == 1
    assert client.search_calls[0][2] == 1


def test_reranker_config_tag_present():
    retriever = la4.ArmA4A3LiveRetriever(StubWorkerClient(items=[SINGLE_ITEM]))
    chunks = retriever.search("아무 새 질문")
    assert chunks[0]["metadata"]["provenance"]["reranker_config"] == "R4_wide_rrf_centric"


# ---------- 14/15: text-SHA / document-id fail-closed ----------

def test_sha_mismatch_fails_closed():
    bad_item = {**SINGLE_ITEM, "chunk_text_sha256": "0" * 64}
    retriever = la4.ArmA4A3LiveRetriever(StubWorkerClient(items=[bad_item]))
    with pytest.raises(la4.ArmA4A3TextShaMismatchError):
        retriever.search("아무 새 질문")


def test_empty_text_fails_closed():
    bad_item = {**SINGLE_ITEM, "text": ""}
    retriever = la4.ArmA4A3LiveRetriever(StubWorkerClient(items=[bad_item]))
    with pytest.raises(la4.ArmA4A3TextResolutionRequiredError):
        retriever.search("아무 새 질문")


def test_missing_document_id_fails_closed():
    bad_item = {**SINGLE_ITEM, "document_id": ""}
    retriever = la4.ArmA4A3LiveRetriever(StubWorkerClient(items=[bad_item]))
    with pytest.raises(la4.ArmA4A3DocumentIdMismatchError):
        retriever.search("아무 새 질문")


# ---------- 7: only REJECT removed — a REJECT decision reaching this layer fails closed ----------

def test_reject_decision_reaching_adapter_fails_closed():
    bad_item = {**SINGLE_ITEM, "a3_decision": "REJECT"}
    retriever = la4.ArmA4A3LiveRetriever(StubWorkerClient(items=[bad_item]))
    with pytest.raises(la4.ArmA4A3LiveWorkerError):
        retriever.search("아무 새 질문")


# ---------- 17: identical input -> byte-identical output (pure function determinism) ----------

def test_conversion_is_deterministic():
    r1 = la4._chunk_from_worker_item(SINGLE_ITEM)
    r2 = la4._chunk_from_worker_item(SINGLE_ITEM)
    assert r1 == r2


# ---------- 19/20: zero Gold/A.results.jsonl/B/D access, zero fallback ----------

def test_search_failure_raises_not_falls_back():
    client = StubWorkerClient(search_error=ArmA4A3SearchFailedError("boom"))
    retriever = la4.ArmA4A3LiveRetriever(client)
    with pytest.raises(ArmA4A3SearchFailedError):
        retriever.search("아무 새 질문")


def test_not_ready_refuses_to_search_at_all():
    client = StubWorkerClient(ready=False)
    retriever = la4.ArmA4A3LiveRetriever(client)
    with pytest.raises(ArmA4A3NotReadyError):
        retriever.search("아무 새 질문")
    assert client.search_calls == []


def test_module_never_reads_frozen_replay_or_gold_paths():
    # The module's own top-of-file docstring legitimately *names* A.results.jsonl/DEV_TUNE/etc to
    # explain what it deliberately does not do (same convention as
    # test_arm_a_live_full_index_smoke.py's own frozen-replay-isolation check) -- strip everything
    # up to the closing \"\"\" before scanning actual code.
    with open(la4.__file__, encoding="utf-8") as f:
        source = f.read()
    _, _, code_only = source.partition('"""\n')
    _, _, code_only = code_only.partition('"""')
    for forbidden in ("A.results.jsonl", "ARM_A_RESULTS_PATH", "DEV_TUNE", "DEV_CHECK", "HOLDOUT", "gold"):
        assert forbidden not in code_only, f"arm_a4_a3_live_adapter.py code (outside its docstring) must never reference {forbidden!r}"


def test_live_adapter_isolated_from_arm_a_live_module_state():
    retriever = la4.ArmA4A3LiveRetriever(StubWorkerClient())
    assert not isinstance(retriever, la1.ArmALiveRetriever)
    assert la1.ArmALiveRetriever not in type(retriever).__mro__


# ---------- 22: existing ARM_A_LIVE regression untouched ----------
# (proven by running tests/agents/test_arm_a_live_adapter.py unmodified in the same suite — see
# the final report's "verification commands" section; not duplicated here.)

# ---------- 21: zero DB writes (structural — worker only ever issues SELECT) ----------

def test_worker_source_never_issues_a_write_statement():
    worker_path = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "arm_a4_a3_live_worker.mjs")
    with open(worker_path, encoding="utf-8") as f:
        source = f.read()
    for forbidden in ("INSERT INTO", "UPDATE ", "DELETE FROM", "DROP ", "TRUNCATE", "ALTER TABLE"):
        assert forbidden not in source, f"arm_a4_a3_live_worker.mjs must never issue {forbidden!r}"


# ---------- answer_api integration smoke (stub worker, fake base — no real subprocess/index needed) ----------

class _FakeBase:
    docs_by_id = {"holding_20240403000410": {"doc_id": "holding_20240403000410", "nodes": []}}
    strategy = "line_window"

    def conditions(self, q):
        return QueryConditions()

    def _metadata_of(self, doc_id):
        return {"corp_name": "합성기업", "doc_group": doc_id.split("_", 1)[0]}

    def statement_scopes(self, doc_id):
        return {}

    def retrieve(self, q, c=None, *, k=None):
        raise AssertionError("ARM_A4_A3_LIVE 경로에서 base.retrieve()가 불리면 안 된다")


class _FakeStore(dict):
    def readiness(self):
        return {"n_docs": 1, "pins": {"fake_store": True}}


def _fake_base_factory(**paths):
    return _FakeBase(), _FakeStore()


def test_answer_api_reaches_qa_agent_with_arm_a4_a3_live_backend():
    from dart_detective.agents import qa_agent

    stub_client = StubWorkerClient(items=[SINGLE_ITEM, MULTI_ITEM])
    answer_api.configure(retrieval_backend=br.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE,
                         worker_client=stub_client, base_factory=_fake_base_factory)
    try:
        retriever = answer_api._get_retriever()
        assert isinstance(retriever, la4.ArmA4A3LiveServingRetriever)
        state = qa_agent.answer_question("아무 새 질문", retriever, llm=None)
        got = state.retrieval_results
        assert [c.chunk_id for c in got] == ["chunk_a4a3_0001", "chunk_a4a3_0002"]
        assert got[1].metadata["provenance"]["node_indices"] == [9, 10, 11]
        assert got[1].metadata["a3_decision"] == "KEEP_UNKNOWN"
        assert got[1].metadata["retrieval_backend"] == "ARM_A4_A3_LIVE"

        wire, meta = answer_api.answer_ex("Q-A4A3-live-smoke", "아무 새 질문")
        assert set(wire) == {"question_id", "question", "retrieved_context", "think_trace", "answer"}
        assert all(isinstance(v, str) for v in wire.values())
        trace = json.loads(wire["think_trace"])
        assert trace["validation"]["status"] != "ERROR" and meta.get("error_code", "") == ""
        assert stub_client.search_calls, "worker was never asked to search"
    finally:
        answer_api.configure()  # reset to env-default state for subsequent tests


def test_arm_a_live_backend_still_selectable_after_arm_a4_a3_live_added():
    # ARM_A_LIVE must remain fully reachable/unmodified (Section C: "keep ARM_A_LIVE AND add
    # ARM_A4_A3_LIVE", never a replacement).
    stub_client = StubWorkerClient(items=[SINGLE_ITEM])
    la1_stub = type("Stub", (), {
        "readiness": lambda self: {"arm_a_live_ready": True},
        "search": lambda self, q, c, k: [],
    })()
    answer_api.configure(retrieval_backend=br.RETRIEVAL_BACKEND_ARM_A_LIVE,
                         worker_client=la1_stub, base_factory=_fake_base_factory)
    try:
        retriever = answer_api._get_retriever()
        assert isinstance(retriever, la1.ArmALiveServingRetriever)
    finally:
        answer_api.configure()


def test_backend_registry_is_additive():
    assert br.RETRIEVAL_BACKEND_ARM_A_LIVE in br.RETRIEVAL_BACKENDS
    assert br.RETRIEVAL_BACKEND_ARM_A in br.RETRIEVAL_BACKENDS
    assert br.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE in br.RETRIEVAL_BACKENDS
    assert br.RETRIEVAL_BACKENDS.index(br.RETRIEVAL_BACKEND_DEFAULT) == 0  # DEFAULT still first/unchanged


def test_worker_client_requires_all_env_vars_never_guesses_a_path(monkeypatch):
    for name in (
        "ARM_A4_A3_LIVE_IMPL_ROOT", "ARM_A4_A3_LIVE_DATABASE_URL", "ARM_A4_A3_LIVE_RETRIEVAL_INDEX_ID",
        "ARM_A4_A3_LIVE_LOAD_SESSION_ID", "ARM_A4_A3_LIVE_CORPUS_SNAPSHOT_ID",
        "ARM_A4_A3_LIVE_KURE_SERVER_URL", "ARM_A4_A3_LIVE_BM25_CACHE_DIR",
    ):
        monkeypatch.delenv(name, raising=False)
    client = ArmA4A3LiveWorkerClient()
    with pytest.raises(ArmA4A3NotReadyError):
        client.search("아무 새 질문", None, 20)
