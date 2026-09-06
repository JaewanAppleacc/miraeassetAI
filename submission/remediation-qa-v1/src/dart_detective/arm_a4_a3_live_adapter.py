"""arm_a4_a3_live_adapter — 실시간 A4 광역 풀 + R4_wide_rrf_centric 재정렬 + A3 모순 가드
검색(arm_a4_a3_live_worker_client 경유)을 QA 검색기로 노출한다.

검색 방식 비교 실험에서 채택된 구성으로, arm_a_live_adapter.py의 ARM_A_LIVE와 대응한다.
Arm A의 기본 BM25+dense+RRF top-20 대신, 상주 Node 워커(scripts/arm_a4_a3_live_worker.mjs)가
four-arm-ac 파이프라인 전체를 무수정으로 실행(BM25 top-100 + dense top-100 -> 광역 풀 <=200 ->
R4_wide_rrf_centric 전체 순위 -> A3 모순 가드 -> 안정 보충)하고 최종 top-20을 돌려준다.
워커는 결과를 돌려주기 전에 실제 본문을 채우고 sha256/document_id를 적재된 색인과 대조한다 —
여기의 검사는 arm_a_live_adapter.py의 _verify_item과 동일한 순수 Python 이중 방어다.

ARM_A4_A3_LIVE는 frozen 결과 파일과 평가 데이터를 일절 읽지 않으며, ARM_A_LIVE나 다른
백엔드로 폴백하지 않는다: 워커 쪽 실패는 arm_a4_a3_live_worker_client의 typed 오류로
표면화되고, answer_api의 기존 예외 처리가 이를 명시적 오류 응답으로 바꾼다.
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
    """실시간 워커를 배후에 둔 RetrieverAdapter Protocol 모양(search/readiness)의 검색기.

    fetch_node는 의도적으로 구현하지 않는다: 이 백엔드는 DocumentIR 노드 저장소에 접근하지
    않는다 — 워커 자체의 적재 청크 본문 채움 이상의 DocumentIR 접근 경로를 더하지 않는다.
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
    """answer_api용 CorpusRetriever 모양 브리지. ArmALiveServingRetriever와 같은 구조다."""

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
