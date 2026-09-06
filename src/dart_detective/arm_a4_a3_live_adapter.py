"""arm_a4_a3_live_adapter — live A4 wide-pool + R4_wide_rrf_centric reranker + A3
contradiction guard search (via arm_a4_a3_live_worker_client) as a QA retriever.

Turn A4-A3-PLUS-QA-FINAL-INTEGRATION-V1. This is the DEV_TUNE-101-selected counterpart to
arm_a_live_adapter.py's ARM_A_LIVE: instead of Arm A's own bare BM25+dense+RRF top-20, the
persistent Node worker (scripts/arm_a4_a3_live_worker.mjs) runs the full, unmodified
four-arm-ac pipeline (BM25 top-100 + dense top-100 -> wide pool <=200 ->
R4_wide_rrf_centric full ranking -> A3 contradiction guard -> stable refill) and returns
its final top-20. The worker already hydrates real text and verifies its
sha256/document_id against the materialized index before ever returning a result — the
checks here are a second, pure-Python, defense-in-depth pass, mirroring
arm_a_live_adapter.py's own _verify_item exactly.

ARM_A4_A3_LIVE never touches A.results.jsonl, DEV_TUNE/DEV_CHECK/HOLDOUT, or Gold, and
never falls back to ARM_A_LIVE or B/D: any worker-side failure surfaces as one of the typed
errors in arm_a4_a3_live_worker_client, which answer_api's existing exception handling
turns into an explicit error wire rather than silently retrying against another backend.
"""
from __future__ import annotations

import hashlib
from typing import Any, Mapping

from .arm_a4_a3_live_worker_client import (
    ArmA4A3LiveWorkerClient,
    ArmA4A3LiveWorkerError,
    ArmA4A3NotReadyError,
)
from .arm_a_serving_bridge import RETRIEVAL_BACKEND_ARM_A4_A3_LIVE
from .corpus_retriever import RetrievedChunk
from .retriever_adapter import Chunk, build_line_window_retriever

ARM_A4_A3_LIVE_ADAPTER_VERSION = "arm-a4-a3.live-worker-adapter.v1"
RERANKER_CONFIG = "R4_wide_rrf_centric"


class ArmA4A3TextResolutionRequiredError(ArmA4A3LiveWorkerError):
    code = "TEXT_RESOLUTION_REQUIRED"


class ArmA4A3TextShaMismatchError(ArmA4A3LiveWorkerError):
    code = "TEXT_SHA_MISMATCH"


class ArmA4A3DocumentIdMismatchError(ArmA4A3LiveWorkerError):
    code = "DOCUMENT_ID_MISMATCH"


def doc_group_of(doc_id: str) -> str:
    return doc_id.split("_", 1)[0]


def _verify_item(item: Mapping[str, Any]) -> None:
    """Second, pure-Python check on top of the worker's own DB-backed verification."""
    text = item.get("text")
    if not isinstance(text, str) or text == "":
        raise ArmA4A3TextResolutionRequiredError(f"chunk_id={item.get('chunk_id')}: worker returned empty text")
    actual_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    expected_sha = item.get("chunk_text_sha256")
    if actual_sha != expected_sha:
        raise ArmA4A3TextShaMismatchError(
            f"chunk_id={item.get('chunk_id')}: recomputed sha256 {actual_sha} != {expected_sha}")
    if not item.get("document_id"):
        raise ArmA4A3DocumentIdMismatchError(f"chunk_id={item.get('chunk_id')}: missing document_id")
    if item.get("a3_decision") not in ("PASS", "KEEP_UNKNOWN"):
        raise ArmA4A3LiveWorkerError(
            f"chunk_id={item.get('chunk_id')}: unexpected a3_decision={item.get('a3_decision')!r} "
            "(only PASS/KEEP_UNKNOWN may reach the final result — REJECT must never be returned)")


def _chunk_from_worker_item(item: Mapping[str, Any]) -> Chunk:
    _verify_item(item)
    doc_id = item["document_id"]
    node_indices = list(item.get("node_indices") or [])
    provenance = dict(item.get("provenance") or {})
    provenance["node_indices"] = node_indices
    provenance["chunk_text_sha256"] = item.get("chunk_text_sha256")
    provenance["retrieval_method"] = "a4_wide_pool_r4_reranker_a3_guard"
    provenance["rank"] = item.get("rank")
    provenance["reranker_rank"] = item.get("reranker_rank")
    provenance["reranker_config"] = item.get("reranker_config", RERANKER_CONFIG)
    provenance["a3_decision"] = item.get("a3_decision")
    return Chunk(
        chunk_id=item["chunk_id"],
        doc_id=doc_id,
        node_index=item.get("node_index") if item.get("node_index") is not None else (node_indices[0] if node_indices else -1),
        locator=item["locator"],
        text=item["text"],
        header="",
        section_path=[],
        doc_group=doc_group_of(doc_id),
        score=float(item["score"]),
        metadata={"provenance": provenance},
    )


class ArmA4A3LiveRetriever:
    """RetrieverAdapter-Protocol-shaped (search/readiness), backed by the live worker.

    fetch_node is intentionally NOT implemented: this backend never accesses the
    DocumentIR node store (Section K: no folding-in of DocumentIR access paths beyond
    what the worker's own materialized-chunk hydration already does).
    """

    arm = "A4_A3"

    def __init__(self, worker_client: ArmA4A3LiveWorkerClient):
        self._worker = worker_client

    def _require_ready(self) -> None:
        readiness = self._worker.readiness()
        if not readiness.get("arm_a4_a3_live_ready"):
            raise ArmA4A3NotReadyError(f"arm_a4_a3_live_ready=false: {readiness}")

    def search(self, question: str, conditions: Mapping[str, Any] | None = None, k: int = 20) -> list[Chunk]:
        self._require_ready()
        response = self._worker.search(question, conditions, k)
        items = response["results"]
        chunks = [_chunk_from_worker_item(item) for item in items]
        return chunks[:k]

    def readiness(self) -> dict[str, Any]:
        return self._worker.readiness()


class ArmA4A3LiveServingRetriever:
    """CorpusRetriever-shaped bridge for answer_api, mirroring ArmALiveServingRetriever."""

    arm = "A4_A3"

    def __init__(self, live_retriever: ArmA4A3LiveRetriever, base: Any = None):
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
            provenance = dict((c.get("metadata") or {}).get("provenance") or {})
            metadata: dict[str, Any] = {
                **dict(doc_meta or {}),
                "arm": "A4_A3",
                "retrieval_backend": RETRIEVAL_BACKEND_ARM_A4_A3_LIVE,
                "reranker_config": provenance.get("reranker_config", RERANKER_CONFIG),
                "a3_decision": provenance.get("a3_decision"),
                "provenance": provenance,
            }
            metadata.setdefault("doc_group", c.get("doc_group") or c["doc_id"].split("_", 1)[0])
            out.append(RetrievedChunk(
                chunk_id=c["chunk_id"], doc_id=c["doc_id"], score=float(c["score"]),
                section_path=tuple(c.get("section_path") or ()), row_labels=(),
                evidence_text=c["text"], metadata=metadata, node_index=int(c["node_index"]),
            ))
        self.last = {"k": kk, "n": len(out), "arm": self.arm, "retrieval_backend": RETRIEVAL_BACKEND_ARM_A4_A3_LIVE}
        return out


def build_arm_a4_a3_live_serving_retriever(*, worker_client: ArmA4A3LiveWorkerClient | None = None,
                                            base_factory=build_line_window_retriever,
                                            **paths: Any) -> tuple[Any, Any, str, dict[str, Any]]:
    """Same 4-tuple (retriever, store, arm, pins) shape as build_arm_a_live_serving_retriever."""
    client = worker_client or ArmA4A3LiveWorkerClient()
    live_retriever = ArmA4A3LiveRetriever(client)
    base, store = base_factory(**paths) if base_factory is not None else (None, None)
    bridge = ArmA4A3LiveServingRetriever(live_retriever, base=base)
    try:
        readiness = client.readiness()
    except ArmA4A3LiveWorkerError as exc:
        readiness = {"arm_a4_a3_live_ready": False, "error": str(exc)}
    pins: dict[str, Any] = {
        "strategy": "fixed_512_chunk",
        "dense": "present",
        "retrieval_backend": RETRIEVAL_BACKEND_ARM_A4_A3_LIVE,
        "arm_a4_a3_live_adapter_version": ARM_A4_A3_LIVE_ADAPTER_VERSION,
        "reranker_config": RERANKER_CONFIG,
        "arm_ready": bool(readiness.get("arm_a4_a3_live_ready")),
        "text_resolver_configured": True,
        "kure_pin": readiness.get("kure_pin"),
        "retrieval_index_id": readiness.get("retrieval_index_id"),
        "corpus_snapshot_id": readiness.get("corpus_snapshot_id"),
    }
    return bridge, store, "A4_A3", pins
