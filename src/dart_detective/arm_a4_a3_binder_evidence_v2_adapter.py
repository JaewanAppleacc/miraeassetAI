"""arm_a4_a3_binder_evidence_v2_adapter — opt-in QA backend `ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2`.

Turn A4-A3-QA-BINDER-EVIDENCE-V2-INTEGRATION-V1. Contract:
docs/A4_A3_QA_BINDER_EVIDENCE_V2_INTEGRATION_V1_CONTRACT.md — if this file and that document
disagree, the document wins.

This module wires together three already-frozen pieces without changing any of them:

    ArmA4A3LiveServingRetriever.retrieve()  (existing ARM_A4_A3_LIVE top-20, rank unchanged)
        -> arm_a_document_binder.bind_documents()   (document boundary, before Evidence V2)
        -> arm_a_evidence.normalize_arm_a_evidence() (row-level restore, *inside* the bound
                                                       document(s) only)
        -> capped to <= 20 evidence items, existing QA unchanged from here on.

It performs zero new search/DB/KURE/LLM calls, zero re-ranking, and zero new candidate
creation — every RetrievedChunk this module returns is either an unmodified item from the
ARM_A4_A3_LIVE result, an unmodified item from arm_a_document_binder's `retained_candidates`,
or a row/node child produced by arm_a_evidence from the DocumentIR node the parent chunk
already pointed at (never a new document_id, never a new chunk beyond arm_a_evidence's own
row-restoration).

This backend is opt-in only: existing backends (DEFAULT, ARM_A_LIVE, ARM_A4_A3_LIVE) are
completely unaffected — nothing here is on their import or call path.
"""
from __future__ import annotations

import dataclasses
from typing import Any, Mapping, Sequence

from . import arm_a_document_binder as binder
from . import arm_a_evidence as evidence
from .arm_a4_a3_live_adapter import (
    ArmA4A3LiveRetriever,
    ArmA4A3LiveServingRetriever,
    ArmA4A3LiveWorkerClient,
)
from .corpus_retriever import RetrievedChunk
from .retriever_adapter import build_line_window_retriever

ARM_A4_A3_BINDER_EVIDENCE_V2_ADAPTER_VERSION = "arm-a4-a3.binder-evidence-v2-adapter.v1"

# Section E: "최종 QA evidence 최대 20" — a defensive final cap independent of
# DocumentBinder's own budget-sums-to-total invariant.
TOTAL_EVIDENCE_CAP = binder.DEFAULT_TOTAL_EVIDENCE_BUDGET


def _tag(chunk: RetrievedChunk, **extra: Any) -> RetrievedChunk:
    """Return a *new* RetrievedChunk with extra binder/evidence-v2 metadata merged in.

    Never mutates the input chunk or its metadata mapping (input immutability, §K).
    """
    metadata = {**dict(chunk.metadata), **extra}
    return dataclasses.replace(chunk, metadata=metadata)


def _evidence_v2_for_document(question: str, doc_id: str,
                              candidates: Sequence[RetrievedChunk],
                              docs_by_id: Mapping[str, Mapping[str, Any]],
                              budget: int, *, group_id: str | None,
                              role: str | None, status: str) -> list[RetrievedChunk]:
    """Run Evidence V2 for exactly one document's candidates and cap to its budget.

    `candidates` must all share `doc_id` — the caller (bind_documents' own grouping)
    already guarantees this, so no cross-document mixing can happen inside one call.
    """
    if not candidates:
        return []
    expanded = evidence.normalize_arm_a_evidence(question, candidates, docs_by_id)
    if not expanded:
        # Defensive fallback (§D-7): arm_a_evidence itself never returns an empty list for
        # a non-empty input (it always emits at least a parent-context/unresolved row per
        # parent), but keep this as a structural safety net per the contract.
        expanded = list(candidates)
    limited = expanded[: max(0, budget)]
    tagged = [_tag(c, binder_status=status, binder_group_id=group_id, binder_role=role,
                   binder_document_id=doc_id)
              for c in limited]
    return tagged


def _passthrough(question: str, original_top_k: Sequence[RetrievedChunk],
                 status: str) -> list[RetrievedChunk]:
    """AMBIGUOUS/UNRESOLVED: no row expansion — keep the unfiltered top-k as-is
    (see contract §4 step 3 for why this is the *original* top-k, not
    DocumentBindingResult.retained_candidates)."""
    return [_tag(c, binder_status=status, binder_group_id=None, binder_role=None)
            for c in original_top_k]


def apply_binder_and_evidence_v2(question: str, conditions: Any,
                                 candidates: Sequence[RetrievedChunk],
                                 docs_by_id: Mapping[str, Mapping[str, Any]],
                                 ) -> list[RetrievedChunk]:
    """Section D execution order, minus the retrieve() call itself (caller already has
    `candidates` = ARM_A4_A3_LIVE's top-k). Pure function: never mutates its inputs."""
    result = binder.bind_documents(question, conditions, candidates)

    if result.status in (binder.STATUS_AMBIGUOUS, binder.STATUS_UNRESOLVED):
        out = _passthrough(question, candidates, result.status)
        return out[:TOTAL_EVIDENCE_CAP]

    if result.status == binder.STATUS_BOUND:
        (doc_id,) = result.selected_document_ids
        doc_candidates = tuple(c for c in result.retained_candidates if c.doc_id == doc_id)
        budget = result.document_budgets.get(doc_id, TOTAL_EVIDENCE_CAP)
        out = _evidence_v2_for_document(
            question, doc_id, doc_candidates, docs_by_id, budget,
            group_id=None, role="primary", status=result.status)
        return out[:TOTAL_EVIDENCE_CAP]

    # MULTI_DOCUMENT_BOUND: one independent Evidence V2 call per selected group — never
    # combine two groups' candidates into a single normalize_arm_a_evidence() call, so the
    # interleaving inside that function can never cross a document boundary (§F).
    out = []
    for group in result.candidate_groups:
        if not group.selected:
            continue
        (doc_id,) = group.document_ids
        budget = result.document_budgets.get(doc_id, 0)
        out.extend(_evidence_v2_for_document(
            question, doc_id, group.candidates, docs_by_id, budget,
            group_id=group.group_id, role=group.role, status=result.status))
    return out[:TOTAL_EVIDENCE_CAP]


class ArmA4A3BinderEvidenceV2ServingRetriever:
    """CorpusRetriever-shaped bridge, identical surface to ArmA4A3LiveServingRetriever —
    qa_agent.py and everything downstream of retrieve() is unmodified."""

    arm = "A4_A3_BINDER_EVIDENCE_V2"

    def __init__(self, inner: ArmA4A3LiveServingRetriever):
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


def build_arm_a4_a3_binder_evidence_v2_serving_retriever(
        *, worker_client: ArmA4A3LiveWorkerClient | None = None,
        base_factory=build_line_window_retriever, **paths: Any,
        ) -> tuple[Any, Any, str, dict[str, Any]]:
    """Same 4-tuple `(retriever, store, arm, pins)` shape as
    build_arm_a4_a3_live_serving_retriever — this backend only wraps that one's output."""
    client = worker_client or ArmA4A3LiveWorkerClient()
    live_retriever = ArmA4A3LiveRetriever(client)
    base, store = base_factory(**paths) if base_factory is not None else (None, None)
    inner = ArmA4A3LiveServingRetriever(live_retriever, base=base)
    bridge = ArmA4A3BinderEvidenceV2ServingRetriever(inner)
    try:
        readiness = client.readiness()
    except Exception as exc:  # noqa: BLE001 — mirrors arm_a4_a3_live_adapter's own handling
        readiness = {"arm_a4_a3_live_ready": False, "error": str(exc)}
    pins: dict[str, Any] = {
        "strategy": "fixed_512_chunk",
        "dense": "present",
        "retrieval_backend": "ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2",
        "arm_a4_a3_binder_evidence_v2_adapter_version": ARM_A4_A3_BINDER_EVIDENCE_V2_ADAPTER_VERSION,
        "arm_a4_a3_evidence_normalization": evidence.ARM_A_EVIDENCE_NORMALIZATION,
        "total_evidence_cap": TOTAL_EVIDENCE_CAP,
        "arm_ready": bool(readiness.get("arm_a4_a3_live_ready")),
        "text_resolver_configured": True,
        "kure_pin": readiness.get("kure_pin"),
        "retrieval_index_id": readiness.get("retrieval_index_id"),
        "corpus_snapshot_id": readiness.get("corpus_snapshot_id"),
    }
    return bridge, store, "A4_A3_BINDER_EVIDENCE_V2", pins
