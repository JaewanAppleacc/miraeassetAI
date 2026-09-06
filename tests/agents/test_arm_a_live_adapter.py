"""arm_a_live_adapter contract tests — Turn A-PLUS-QA-LIVE-RETRIEVER-V1.

All synthetic: a stub ArmALiveWorkerClient stands in for the real Node subprocess (no real
process, no real Postgres/KURE server needed for these). The real end-to-end path is verified
separately by the Node integration test (scripts/arm_a_live_worker.test.mjs) against the real
worker/shard.
"""
from __future__ import annotations

import hashlib

import json

import pytest

from dart_corpus.retrieval.conditions import QueryConditions
from dart_detective import answer_api, arm_a_adapter, arm_a_live_adapter as la
from dart_detective import arm_a_serving_bridge as br
from dart_detective.arm_a_live_worker_client import (
    ArmALiveWorkerClient,
    ArmANotReadyError,
    ArmASearchFailedError,
    DocumentIdMismatchError,
    TextResolutionRequiredError,
    TextShaMismatchError,
)
from dart_detective.retriever_adapter import RetrieverAdapter


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


SINGLE_TEXT = "실제 검색 결과 본문 — 단일 node."
MULTI_TEXT = "실제 검색 결과 본문 — 다중 node."

SINGLE_ITEM = {
    "rank": 1, "score": 0.031, "document_id": "holding_20240403000410",
    "chunk_id": "chunk_live_0001", "node_index": 5, "node_indices": [5],
    "text": SINGLE_TEXT, "chunk_text_sha256": _sha256(SINGLE_TEXT),
    "locator": "holding_20240403000410/20240403000410.xml#node=5",
    "provenance": {"status": "NODE_AND_ROW_RESOLVED", "candidates": [{"node_index": 5}]},
    "metadata": {}, "retrieval_method": "fixed_bm25_dense_rrf",
}
MULTI_ITEM = {
    "rank": 2, "score": 0.021, "document_id": "major_20240913000790",
    "chunk_id": "chunk_live_0002", "node_index": None, "node_indices": [9, 10, 11],
    "text": MULTI_TEXT, "chunk_text_sha256": _sha256(MULTI_TEXT),
    "locator": "major_20240913000790/20240913000790.xml#node=9",
    "provenance": {"status": "MULTI_NODE_AMBIGUOUS",
                   "candidates": [{"node_index": 9}, {"node_index": 10}, {"node_index": 11}]},
    "metadata": {}, "retrieval_method": "fixed_bm25_dense_rrf",
}


class StubWorkerClient:
    """In-process stand-in for ArmALiveWorkerClient — no subprocess, no I/O."""

    def __init__(self, *, items=None, ready=True, search_error: Exception | None = None):
        self._items = items if items is not None else [SINGLE_ITEM, MULTI_ITEM]
        self._ready = ready
        self._search_error = search_error
        self.search_calls: list[tuple] = []

    def readiness(self):
        return {"arm_a_live_ready": self._ready, "database_ready": True, "bm25_index_ready": True,
                "dense_index_ready": True, "kure_ready": True, "kure_revision_match": True,
                "embedding_dimension": 1024, "materialized_record_count": len(self._items),
                "kure_pin": {"repository": "nlpai-lab/KURE-v1",
                             "revision": "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", "dimension": 1024}}

    def search(self, question, conditions, top_k):
        self.search_calls.append((question, conditions, top_k))
        if self._search_error is not None:
            raise self._search_error
        return self._items[:top_k]

    def fetch_node(self, document_id, node_index, **kwargs):
        return {"found": True, "document_id": document_id, "node_index": node_index}


# ---------- 1. 정확한 변환 ----------

def test_single_item_converts_to_chunk_correctly():
    retriever = la.ArmALiveRetriever(StubWorkerClient(items=[SINGLE_ITEM]))
    chunks = retriever.search("아무 새 질문")
    assert len(chunks) == 1
    c = chunks[0]
    assert c["doc_id"] == "holding_20240403000410"
    assert c["chunk_id"] == "chunk_live_0001"
    assert c["node_index"] == 5
    assert c["text"] == SINGLE_TEXT
    assert c["locator"] == SINGLE_ITEM["locator"]  # Arm A's own locator, not recomputed
    assert c["metadata"]["provenance"]["node_indices"] == [5]


# ---------- 2. 본문·SHA 일치 ----------

def test_text_matches_recorded_sha():
    retriever = la.ArmALiveRetriever(StubWorkerClient(items=[SINGLE_ITEM]))
    chunks = retriever.search("아무 새 질문")
    assert hashlib.sha256(chunks[0]["text"].encode("utf-8")).hexdigest() == SINGLE_ITEM["chunk_text_sha256"]


# ---------- 3. SHA 불일치 fail-closed ----------

def test_sha_mismatch_fails_closed():
    bad_item = {**SINGLE_ITEM, "chunk_text_sha256": "0" * 64}
    retriever = la.ArmALiveRetriever(StubWorkerClient(items=[bad_item]))
    with pytest.raises(TextShaMismatchError):
        retriever.search("아무 새 질문")


# ---------- 4. 빈 본문 fail-closed ----------

def test_empty_text_fails_closed():
    bad_item = {**SINGLE_ITEM, "text": ""}
    retriever = la.ArmALiveRetriever(StubWorkerClient(items=[bad_item]))
    with pytest.raises(TextResolutionRequiredError):
        retriever.search("아무 새 질문")


# ---------- 5. 다른 document 반환 fail-closed ----------

def test_missing_document_id_fails_closed():
    bad_item = {**SINGLE_ITEM, "document_id": ""}
    retriever = la.ArmALiveRetriever(StubWorkerClient(items=[bad_item]))
    with pytest.raises(DocumentIdMismatchError):
        retriever.search("아무 새 질문")


# ---------- 6. node_indices 전체 보존 ----------

def test_multi_node_indices_fully_preserved():
    retriever = la.ArmALiveRetriever(StubWorkerClient(items=[MULTI_ITEM]))
    chunks = retriever.search("아무 새 질문")
    assert chunks[0]["metadata"]["provenance"]["node_indices"] == [9, 10, 11]
    assert chunks[0]["node_index"] == 9  # first candidate, never fabricated


# ---------- 7. locator/provenance 보존 ----------

def test_locator_and_provenance_preserved():
    retriever = la.ArmALiveRetriever(StubWorkerClient(items=[MULTI_ITEM]))
    chunks = retriever.search("아무 새 질문")
    assert chunks[0]["locator"] == MULTI_ITEM["locator"]
    assert chunks[0]["metadata"]["provenance"]["status"] == "MULTI_NODE_AMBIGUOUS"
    assert chunks[0]["metadata"]["provenance"]["candidates"] == MULTI_ITEM["provenance"]["candidates"]


# ---------- 8. rank 순서 불변 ----------

def test_rank_order_preserved():
    retriever = la.ArmALiveRetriever(StubWorkerClient(items=[SINGLE_ITEM, MULTI_ITEM]))
    chunks = retriever.search("아무 새 질문")
    assert [c["chunk_id"] for c in chunks] == ["chunk_live_0001", "chunk_live_0002"]


# ---------- 9. top-k 초과 유입 없음 ----------

def test_top_k_enforced():
    client = StubWorkerClient(items=[SINGLE_ITEM, MULTI_ITEM])
    retriever = la.ArmALiveRetriever(client)
    chunks = retriever.search("아무 새 질문", k=1)
    assert len(chunks) == 1
    assert client.search_calls[0][2] == 1  # top_k actually forwarded to the worker


# ---------- 10. A live 오류가 B/D fallback으로 이어지지 않음 ----------

def test_search_failure_raises_not_falls_back():
    client = StubWorkerClient(search_error=ArmASearchFailedError("boom"))
    retriever = la.ArmALiveRetriever(client)
    with pytest.raises(ArmASearchFailedError):
        retriever.search("아무 새 질문")


def test_not_ready_refuses_to_search_at_all():
    client = StubWorkerClient(ready=False)
    retriever = la.ArmALiveRetriever(client)
    with pytest.raises(ArmANotReadyError):
        retriever.search("아무 새 질문")
    assert client.search_calls == []  # never even asked the worker to search


# ---------- 11. DEFAULT 경로 회귀 없음 (test_arm_a_adapter.py의 byte-hash 테스트가 검증) ----------
# 별도 assertion 불필요 — 같은 스위트에서 test_existing_qa_files_byte_unchanged가 이미 확인한다.


# ---------- 12. frozen replay와 live 모드 명확히 분리 ----------

def test_live_adapter_never_touches_frozen_replay_module_state():
    # ArmALiveRetriever holds no reference to the frozen adapter's class/instances at all, and
    # never calls any of arm_a_adapter's file-reading functions (checked structurally, not by
    # grepping comments/docstrings, since this module's own docstring legitimately *names*
    # A.results.jsonl to explain what it deliberately does not do).
    retriever = la.ArmALiveRetriever(StubWorkerClient())
    assert not hasattr(retriever, "_frozen")
    assert not isinstance(retriever, arm_a_adapter.ArmAFrozenResultsRetriever)
    assert arm_a_adapter.ArmAFrozenResultsRetriever not in type(retriever).__mro__
    assert not any(
        name.startswith("_load_jsonl") or name == "ArmAFrozenResultsRetriever"
        for name in vars(la)
    )


# ---------- answer_api integration smoke (stub worker, fake base — no real subprocess/index needed) ----------
# The real subprocess/DB/KURE-server path is proven separately (scripts/arm_a_live_worker.test.mjs
# and this turn's manual Python smoke against the real worker, documented in the handoff).

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
        raise AssertionError("ARM_A_LIVE 경로에서 base.retrieve()가 불리면 안 된다")


class _FakeStore(dict):
    def readiness(self):
        return {"n_docs": 1, "pins": {"fake_store": True}}


def _fake_base_factory(**paths):
    return _FakeBase(), _FakeStore()


def test_answer_api_reaches_qa_agent_with_arm_a_live_backend():
    from dart_detective.agents import qa_agent

    stub_client = StubWorkerClient(items=[SINGLE_ITEM, MULTI_ITEM])
    answer_api.configure(retrieval_backend=br.RETRIEVAL_BACKEND_ARM_A_LIVE,
                         worker_client=stub_client, base_factory=_fake_base_factory)
    try:
        retriever = answer_api._get_retriever()
        assert isinstance(retriever, la.ArmALiveServingRetriever)
        state = qa_agent.answer_question("아무 새 질문", retriever, llm=None)
        got = state.retrieval_results
        assert [c.chunk_id for c in got] == ["chunk_live_0001", "chunk_live_0002"]
        assert got[1].metadata["provenance"]["node_indices"] == [9, 10, 11]
        assert got[1].node_index == 9

        wire, meta = answer_api.answer_ex("Q-A-live-smoke", "아무 새 질문")
        assert set(wire) == {"question_id", "question", "retrieved_context", "think_trace", "answer"}
        assert all(isinstance(v, str) for v in wire.values())
        trace = json.loads(wire["think_trace"])
        assert trace["validation"]["status"] != "ERROR" and meta.get("error_code", "") == ""
        # base.retrieve() was never called (asserted inside _FakeBase.retrieve) -- confirms this
        # path never fell back to the line-window/B/D core.
        assert stub_client.search_calls, "worker was never asked to search"
    finally:
        answer_api.configure()  # reset to env-default state for subsequent tests


def test_worker_client_requires_all_env_vars_never_guesses_a_path(monkeypatch):
    for name in (
        "ARM_A_LIVE_IMPL_ROOT", "ARM_A_LIVE_DATABASE_URL", "ARM_A_LIVE_RETRIEVAL_INDEX_ID",
        "ARM_A_LIVE_LOAD_SESSION_ID", "ARM_A_LIVE_CORPUS_SNAPSHOT_ID",
        "ARM_A_LIVE_KURE_SERVER_URL", "ARM_A_LIVE_BM25_CACHE_DIR",
    ):
        monkeypatch.delenv(name, raising=False)
    client = ArmALiveWorkerClient()
    with pytest.raises(ArmANotReadyError):
        client.search("아무 새 질문", None, 20)
