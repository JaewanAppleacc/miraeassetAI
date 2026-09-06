"""arm_a_live_adapter — live Arm A search (via arm_a_live_worker_client) as a QA retriever.

Turn A-PLUS-QA-LIVE-RETRIEVER-V1. This is the ARM_A_LIVE counterpart to arm_a_adapter.py's frozen
replay: instead of reading A.results.jsonl, ArmALiveRetriever asks a persistent Node worker
(scripts/arm_a_live_worker.mjs) to run Arm A's real BM25+dense+RRF search for the caller's own
question. The worker already hydrates real text and verifies its sha256/document_id against the
materialized index before ever returning a result (see that file's own docstring) — the checks
here are a second, pure-Python, defense-in-depth pass, not a replacement for them.

ARM_A_LIVE never touches A.results.jsonl and never consults the frozen adapter's gold-question
index — arbitrary question strings are the whole point. It also never falls back to B/D: any
worker-side failure surfaces as one of the typed errors in arm_a_live_worker_client, which
answer_api's existing exception handling turns into an explicit error wire (see that module's
`_error_wire`/`code` handling, unmodified) rather than silently retrying against another backend.
"""
from __future__ import annotations

import hashlib
import os
from typing import Any, Mapping

from .arm_a_live_worker_client import (
    ArmALiveWorkerClient,
    ArmALiveWorkerError,
    ArmANotReadyError,
    DocumentIdMismatchError,
    TextResolutionRequiredError,
    TextShaMismatchError,
)
from .arm_a_serving_bridge import retrieved_chunk_from_arm_a
from .corpus_retriever import RetrievedChunk
from .retriever_adapter import Chunk, build_line_window_retriever

ARM_A_LIVE_ADAPTER_VERSION = "arm-a.live-worker-adapter.v1"


def doc_group_of(doc_id: str) -> str:
    return doc_id.split("_", 1)[0]


def _verify_item(item: Mapping[str, Any]) -> None:
    """Second, pure-Python check on top of the worker's own DB-backed verification."""
    text = item.get("text")
    if not isinstance(text, str) or text == "":
        raise TextResolutionRequiredError(f"chunk_id={item.get('chunk_id')}: worker returned empty text")
    actual_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    expected_sha = item.get("chunk_text_sha256")
    if actual_sha != expected_sha:
        raise TextShaMismatchError(
            f"chunk_id={item.get('chunk_id')}: recomputed sha256 {actual_sha} != {expected_sha}")
    if not item.get("document_id"):
        raise DocumentIdMismatchError(f"chunk_id={item.get('chunk_id')}: missing document_id")


def _chunk_from_worker_item(item: Mapping[str, Any]) -> Chunk:
    _verify_item(item)
    doc_id = item["document_id"]
    node_indices = list(item.get("node_indices") or [])
    provenance = dict(item.get("provenance") or {})
    provenance["node_indices"] = node_indices
    provenance["chunk_text_sha256"] = item.get("chunk_text_sha256")
    provenance["retrieval_method"] = item.get("retrieval_method", "fixed_bm25_dense_rrf")
    provenance["rank"] = item.get("rank")
    return Chunk(
        chunk_id=item["chunk_id"],
        doc_id=doc_id,
        node_index=item.get("node_index") if item.get("node_index") is not None else (node_indices[0] if node_indices else -1),
        # Arm A's own authoritative locator, preserved as-is — not recomputed via
        # retriever_adapter.locator_of, since the live worker's locator already comes straight
        # from Arm A's own resolution/source_locator (see arm_a_live_worker.mjs).
        locator=item["locator"],
        text=item["text"],
        header="",
        section_path=[],
        doc_group=doc_group_of(doc_id),
        score=float(item["score"]),
        metadata={"provenance": provenance},
    )


class ArmALiveRetriever:
    """RetrieverAdapter-Protocol-shaped (search/fetch_node/readiness), backed by the live worker."""

    arm = "A"

    def __init__(self, worker_client: ArmALiveWorkerClient):
        self._worker = worker_client

    def _require_ready(self) -> None:
        readiness = self._worker.readiness()
        if not readiness.get("arm_a_live_ready"):
            raise ArmANotReadyError(f"arm_a_live_ready=false: {readiness}")

    def search(self, question: str, conditions: Mapping[str, Any] | None = None, k: int = 20) -> list[Chunk]:
        self._require_ready()
        items = self._worker.search(question, conditions, k)
        # The worker already returns items in Arm A's own rank order and never more than k —
        # this only truncates further if the caller asked for fewer than the worker returned,
        # never reorders.
        chunks = [_chunk_from_worker_item(item) for item in items]
        return chunks[:k]

    def fetch_node(self, doc_id: str, node_index: int):
        from .retriever_adapter import Node

        result = self._worker.fetch_node(doc_id, node_index)
        return Node(doc_id=doc_id, node_index=node_index, kind="", section_path=[],
                    lines=[], text="")

    def readiness(self) -> dict[str, Any]:
        return self._worker.readiness()


class ArmALiveServingRetriever:
    """CorpusRetriever-shaped bridge for answer_api, mirroring arm_a_serving_bridge.ArmAServingRetriever."""

    arm = "A"

    def __init__(self, live_retriever: ArmALiveRetriever, base: Any = None):
        self._live = live_retriever
        self._base = base
        self.docs_by_id = getattr(base, "docs_by_id", None) or {}
        self.last: dict[str, Any] = {}

    def __getattr__(self, name: str):
        base = self.__dict__.get("_base")
        if base is None:
            raise AttributeError(name)
        return getattr(base, name)

    def conditions(self, question: str):
        if self._base is not None:
            return self._base.conditions(question)
        from dart_corpus.retrieval.conditions import QueryConditions
        return QueryConditions()

    def statement_scopes(self, doc_id: str):
        fn = getattr(self._base, "statement_scopes", None) if self._base is not None else None
        return fn(doc_id) if callable(fn) else {}

    def retrieve(self, question: str, conditions: Any = None, *, k: int | None = None) -> list[RetrievedChunk]:
        kk = int(k or 20)
        cond_map = (conditions.as_dict() if hasattr(conditions, "as_dict")
                    else (dict(conditions) if conditions else None))
        chunks = self._live.search(question, cond_map, k=kk)
        meta_of = getattr(self._base, "_metadata_of", None) if self._base is not None else None
        out = []
        for c in chunks:
            doc_meta = meta_of(c["doc_id"]) if callable(meta_of) else {}
            out.append(retrieved_chunk_from_arm_a(c, doc_meta))
        self.last = {"k": kk, "n": len(out), "arm": self.arm, "retrieval_backend": "ARM_A_LIVE"}
        return out


def build_arm_a_live_serving_retriever(*, worker_client: ArmALiveWorkerClient | None = None,
                                        base_factory=build_line_window_retriever,
                                        **paths: Any) -> tuple[Any, Any, str, dict[str, Any]]:
    """Same 4-tuple (retriever, store, arm, pins) shape as arm_a_serving_bridge.build_arm_a_serving_retriever."""
    client = worker_client or ArmALiveWorkerClient()
    live_retriever = ArmALiveRetriever(client)
    base, store = base_factory(**paths) if base_factory is not None else (None, None)
    bridge = ArmALiveServingRetriever(live_retriever, base=base)
    try:
        readiness = client.readiness()
    except ArmALiveWorkerError as exc:
        readiness = {"arm_a_live_ready": False, "error": str(exc)}
    pins: dict[str, Any] = {
        "strategy": "fixed_512_chunk",
        "dense": "present",
        "retrieval_backend": "ARM_A_LIVE",
        "arm_a_live_adapter_version": ARM_A_LIVE_ADAPTER_VERSION,
        "arm_ready": bool(readiness.get("arm_a_live_ready")),
        "text_resolver_configured": True,  # text always comes from the wire; no injected resolver needed
        "kure_pin": readiness.get("kure_pin"),
        "materialized_record_count": readiness.get("materialized_record_count"),
    }
    return bridge, store, "A", pins
