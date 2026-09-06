"""arm_a4_a3_remediation_binder_evidence_v2_adapter — opt-in QA backend
`ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE`.

Turn A4-A3-FINAL-COMBINED-BACKEND-PREP-V1. Contract:
docs/A4_A3_FINAL_COMBINED_BACKEND_PREP_V1_CONTRACT.md — if this file and that document
disagree, the document wins.

Composition, not duplication. This module wires two already-frozen pieces together
without changing either of them or copying their logic:

    ArmA4A3RemediationLiveServingRetriever.retrieve()    (unmodified — remediation's
                                                           BM25/dense wide-pool -> R4 ->
                                                           A3 Guard -> stable refill top-k)
        -> arm_a4_a3_binder_evidence_v2_adapter.apply_binder_and_evidence_v2()
           (unmodified — DocumentBinder -> Evidence V2 -> <=20 cap, already used by
           ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2)

Every RetrievedChunk this module returns comes from one of those two functions —
no new search/DB/KURE/LLM call, no re-ranking, no new candidate creation here.

This backend is opt-in only: DEFAULT, ARM_A_LIVE, ARM_A4_A3_LIVE,
ARM_A4_A3_REMEDIATION_LIVE, and ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2 are completely
unaffected — nothing here is on their import or call path.
"""
from __future__ import annotations

from typing import Any

from .arm_a4_a3_binder_evidence_v2_adapter import apply_binder_and_evidence_v2
from .arm_a4_a3_binder_evidence_v2_adapter import TOTAL_EVIDENCE_CAP as TOTAL_EVIDENCE_CAP
from .arm_a4_a3_remediation_live_adapter import (
    ArmA4A3RemediationLiveRetriever,
    ArmA4A3RemediationLiveServingRetriever,
    ArmA4A3RemediationLiveWorkerClient,
)
from .arm_a_evidence import ARM_A_EVIDENCE_NORMALIZATION
from .corpus_retriever import RetrievedChunk
from .retriever_adapter import build_line_window_retriever

ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_ADAPTER_VERSION = (
    "arm-a4-a3-remediation.binder-evidence-v2-adapter.v1")


class ArmA4A3RemediationBinderEvidenceV2ServingRetriever:
    """CorpusRetriever-shaped bridge, identical surface to
    ArmA4A3BinderEvidenceV2ServingRetriever — only the wrapped inner retriever differs
    (remediation's live retriever instead of plain ARM_A4_A3_LIVE's)."""

    arm = "A4_A3_REMEDIATION_BINDER_EVIDENCE_V2"

    def __init__(self, inner: ArmA4A3RemediationLiveServingRetriever):
        self._inner = inner
        self.docs_by_id = inner.docs_by_id
        self.last: dict[str, Any] = {}

    def __getattr__(self, name: str) -> Any:
        return getattr(self.__dict__["_inner"], name)

    def conditions(self, question: str):
        return self._inner.conditions(question)

    def statement_scopes(self, doc_id: str):
        return self._inner.statement_scopes(doc_id)

    def retrieve(self, question: str, conditions: Any = None, *, k: int | None = None
                 ) -> list[RetrievedChunk]:
        base_results = self._inner.retrieve(question, conditions, k=k)
        cond = conditions if conditions is not None else self._inner.conditions(question)
        docs_by_id = self.docs_by_id or {}
        out = apply_binder_and_evidence_v2(question, cond, base_results, docs_by_id)
        self.last = {"k": int(k or 20), "n_base": len(base_results), "n": len(out),
                     "arm": self.arm}
        return out


def build_arm_a4_a3_remediation_binder_evidence_v2_serving_retriever(
        *, worker_client: ArmA4A3RemediationLiveWorkerClient | None = None,
        base_factory=build_line_window_retriever, **paths: Any,
        ) -> tuple[Any, Any, str, dict[str, Any]]:
    """Same 4-tuple `(retriever, store, arm, pins)` shape as every other backend builder —
    this one only wraps ARM_A4_A3_REMEDIATION_LIVE's output."""
    client = worker_client or ArmA4A3RemediationLiveWorkerClient()
    live_retriever = ArmA4A3RemediationLiveRetriever(client)
    base, store = base_factory(**paths) if base_factory is not None else (None, None)
    inner = ArmA4A3RemediationLiveServingRetriever(live_retriever, base=base)
    bridge = ArmA4A3RemediationBinderEvidenceV2ServingRetriever(inner)
    try:
        readiness = client.readiness()
    except Exception as exc:  # noqa: BLE001 — mirrors the remediation adapter's own handling
        readiness = {"arm_a4_a3_remediation_live_ready": False, "error": str(exc)}
    pins: dict[str, Any] = {
        "strategy": "fixed_512_chunk",
        "dense": "present",
        "retrieval_backend": "ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE",
        "arm_a4_a3_remediation_binder_evidence_v2_adapter_version":
            ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_ADAPTER_VERSION,
        "arm_a4_a3_evidence_normalization": ARM_A_EVIDENCE_NORMALIZATION,
        "total_evidence_cap": TOTAL_EVIDENCE_CAP,
        "policy_id": readiness.get("policy_id"),
        "arm_ready": bool(readiness.get("arm_a4_a3_remediation_live_ready")),
        "text_resolver_configured": True,
        "kure_pin": readiness.get("kure_pin"),
        "retrieval_index_id": readiness.get("retrieval_index_id"),
        "corpus_snapshot_id": readiness.get("corpus_snapshot_id"),
    }
    return bridge, store, "A4_A3_REMEDIATION_BINDER_EVIDENCE_V2", pins
