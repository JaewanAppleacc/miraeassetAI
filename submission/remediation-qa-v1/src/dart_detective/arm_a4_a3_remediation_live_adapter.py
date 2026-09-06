"""arm_a4_a3_remediation_live_adapter — 실시간 A4 광역 풀 + R4_wide_rrf_centric 재정렬 + A3
모순 가드 검색에, 검증된 검색 개선(remediation)의 opt-in 정책(정정 필터는 질문이 요구할 때만,
근거 기반 승격을 동반한 서브타입 완화 패스 상시 실행, 접수일자별 검색 창 라운드로빈 병합,
BM25 0점 후보 제거)을 각 검색 leg의 후보 생성에 적용해 QA 검색기로 노출한다.

arm_a4_a3_live_adapter.py(ARM_A4_A3_LIVE)와 대응하며, 그 파일은 수정하지 않았다. 새 백엔드
상수 `RETRIEVAL_BACKEND_ARM_A4_A3_REMEDIATION_LIVE`는 arm_a_serving_bridge.py가 아니라 이
파일에 정의된다 — 이 변경의 범위는 검색 계층 통합까지이고 answer_api.py /
arm_a_serving_bridge.py는 건드리지 않으므로, answer_api._build_retriever()의 디스패치에는
아직 등록되어 있지 않다(README "알려진 제약" 참조).

ARM_A4_A3_REMEDIATION_LIVE는 frozen 결과 파일과 평가 데이터를 일절 읽지 않으며, 다른
백엔드로 폴백하지 않는다: 워커 쪽 실패는 arm_a4_a3_remediation_live_worker_client의 typed
오류로 표면화되고, 조용한 재시도는 없다.
"""
from __future__ import annotations

import hashlib
from typing import Any, Mapping

from .arm_a4_a3_remediation_live_worker_client import (
    ArmA4A3RemediationLiveWorkerClient,
    ArmA4A3RemediationLiveWorkerError,
    ArmA4A3RemediationNotReadyError,
)
from .corpus_retriever import RetrievedChunk
from .retriever_adapter import Chunk, build_line_window_retriever

ARM_A4_A3_REMEDIATION_LIVE_ADAPTER_VERSION = "arm-a4-a3-remediation.live-worker-adapter.v1"
RERANKER_CONFIG = "R4_wide_rrf_centric"
RETRIEVAL_BACKEND_ARM_A4_A3_REMEDIATION_LIVE = "ARM_A4_A3_REMEDIATION_LIVE"


class ArmA4A3RemediationTextResolutionRequiredError(ArmA4A3RemediationLiveWorkerError):
    code = "TEXT_RESOLUTION_REQUIRED"


class ArmA4A3RemediationTextShaMismatchError(ArmA4A3RemediationLiveWorkerError):
    code = "TEXT_SHA_MISMATCH"


class ArmA4A3RemediationDocumentIdMismatchError(ArmA4A3RemediationLiveWorkerError):
    code = "DOCUMENT_ID_MISMATCH"


def doc_group_of(doc_id: str) -> str:
    return doc_id.split("_", 1)[0]


def _verify_item(item: Mapping[str, Any]) -> None:
    """Second, pure-Python check on top of the worker's own DB-backed verification."""
    text = item.get("text")
    if not isinstance(text, str) or text == "":
        raise ArmA4A3RemediationTextResolutionRequiredError(f"chunk_id={item.get('chunk_id')}: worker returned empty text")
    actual_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    expected_sha = item.get("chunk_text_sha256")
    if actual_sha != expected_sha:
        raise ArmA4A3RemediationTextShaMismatchError(
            f"chunk_id={item.get('chunk_id')}: recomputed sha256 {actual_sha} != {expected_sha}")
    if not item.get("document_id"):
        raise ArmA4A3RemediationDocumentIdMismatchError(f"chunk_id={item.get('chunk_id')}: missing document_id")
    if item.get("a3_decision") not in ("PASS", "KEEP_UNKNOWN"):
        raise ArmA4A3RemediationLiveWorkerError(
            f"chunk_id={item.get('chunk_id')}: unexpected a3_decision={item.get('a3_decision')!r} "
            "(only PASS/KEEP_UNKNOWN may reach the final result — REJECT must never be returned)")


def _chunk_from_worker_item(item: Mapping[str, Any]) -> Chunk:
    _verify_item(item)
    doc_id = item["document_id"]
    node_indices = list(item.get("node_indices") or [])
    provenance = dict(item.get("provenance") or {})
    provenance["node_indices"] = node_indices
    provenance["chunk_text_sha256"] = item.get("chunk_text_sha256")
    provenance["retrieval_method"] = "a4_wide_pool_r4_reranker_a3_guard_remediation_v1"
    provenance["rank"] = item.get("rank")
    provenance["reranker_rank"] = item.get("reranker_rank")
    provenance["reranker_config"] = item.get("reranker_config", RERANKER_CONFIG)
    provenance["a3_decision"] = item.get("a3_decision")
    provenance["retrieval_pass"] = item.get("retrieval_pass")
    provenance["retrieval_group"] = item.get("retrieval_group")
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


class ArmA4A3RemediationLiveRetriever:
    """실시간 워커를 배후에 둔 RetrieverAdapter Protocol 모양(search/readiness)의 검색기.

    fetch_node는 의도적으로 구현하지 않는다: 이 백엔드는 ARM_A4_A3_LIVE와 마찬가지로
    DocumentIR 노드 저장소에 접근하지 않는다.
    """

    arm = "A4_A3_REMEDIATION"

    def __init__(self, worker_client: ArmA4A3RemediationLiveWorkerClient):
        self._worker = worker_client

    def _require_ready(self) -> None:
        readiness = self._worker.readiness()
        if not readiness.get("arm_a4_a3_remediation_live_ready"):
            raise ArmA4A3RemediationNotReadyError(f"arm_a4_a3_remediation_live_ready=false: {readiness}")

    def search(self, question: str, conditions: Mapping[str, Any] | None = None, k: int = 20) -> list[Chunk]:
        self._require_ready()
        response = self._worker.search(question, conditions, k)
        items = response["results"]
        chunks = [_chunk_from_worker_item(item) for item in items]
        return chunks[:k]

    def readiness(self) -> dict[str, Any]:
        return self._worker.readiness()


class ArmA4A3RemediationLiveServingRetriever:
    """CorpusRetriever 모양 브리지. ArmA4A3LiveServingRetriever와 같은 구조다."""

    arm = "A4_A3_REMEDIATION"

    def __init__(self, live_retriever: ArmA4A3RemediationLiveRetriever, base: Any = None):
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
                "arm": "A4_A3_REMEDIATION",
                "retrieval_backend": RETRIEVAL_BACKEND_ARM_A4_A3_REMEDIATION_LIVE,
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
        self.last = {"k": kk, "n": len(out), "arm": self.arm, "retrieval_backend": RETRIEVAL_BACKEND_ARM_A4_A3_REMEDIATION_LIVE}
        return out


def build_arm_a4_a3_remediation_live_serving_retriever(
        *, worker_client: ArmA4A3RemediationLiveWorkerClient | None = None,
        base_factory=build_line_window_retriever, **paths: Any) -> tuple[Any, Any, str, dict[str, Any]]:
    """Same 4-tuple (retriever, store, arm, pins) shape as build_arm_a4_a3_live_serving_retriever."""
    client = worker_client or ArmA4A3RemediationLiveWorkerClient()
    live_retriever = ArmA4A3RemediationLiveRetriever(client)
    base, store = base_factory(**paths) if base_factory is not None else (None, None)
    bridge = ArmA4A3RemediationLiveServingRetriever(live_retriever, base=base)
    try:
        readiness = client.readiness()
    except ArmA4A3RemediationLiveWorkerError as exc:
        readiness = {"arm_a4_a3_remediation_live_ready": False, "error": str(exc)}
    pins: dict[str, Any] = {
        "strategy": "fixed_512_chunk",
        "dense": "present",
        "retrieval_backend": RETRIEVAL_BACKEND_ARM_A4_A3_REMEDIATION_LIVE,
        "arm_a4_a3_remediation_live_adapter_version": ARM_A4_A3_REMEDIATION_LIVE_ADAPTER_VERSION,
        "reranker_config": RERANKER_CONFIG,
        "policy_id": readiness.get("policy_id"),
        "arm_ready": bool(readiness.get("arm_a4_a3_remediation_live_ready")),
        "text_resolver_configured": True,
        "kure_pin": readiness.get("kure_pin"),
        "retrieval_index_id": readiness.get("retrieval_index_id"),
        "corpus_snapshot_id": readiness.get("corpus_snapshot_id"),
    }
    return bridge, store, "A4_A3_REMEDIATION", pins
