"""arm_a_serving_bridge — Arm A adapter(RetrieverAdapter Protocol)를 answer_api가 소비하는
CorpusRetriever 모양으로 잇는 최소 브리지.

Turn A-PLUS-QA-LIVE-WIRING-V1. answer_api._get_retriever()는 retriever_adapter.build_serving_retriever()
가 돌려주는 4-tuple `(retriever, store, arm, pins)`를 소비한다. 그 `retriever`는 qa_agent가 쓰는
CorpusRetriever 인터페이스여야 한다:

    conditions(question) -> QueryConditions
    retrieve(question, conditions=None, *, k=None) -> list[RetrievedChunk]
    docs_by_id: Mapping[str, dict]                      (원문 노드 읽기 — 대량보유 파서 등)
    statement_scopes(doc_id) -> Mapping[int, str]       (있으면 사용 — 연결/별도 soft 신호)
    document_index / _rcept_dt                          (있으면 사용 — 접수일 결박)

arm_a_adapter.ArmAFrozenResultsRetriever는 다른 모양(search/fetch_node/readiness, Chunk TypedDict)
이다. 이 파일은 그 둘을 잇기만 한다:

  - retrieve(): adapter.search() 결과(Chunk)를 RetrievedChunk로 옮긴다. rank·score·doc_id·chunk_id·
    node_index는 A값 그대로, metadata['provenance']에 node_indices 전체·chunk_text_sha256·score_type·
    row/col을 보존한다(첫 node로 축소 금지). 문서 메타(corp_name·rcept_dt·doc_group…)는 base(기존
    CorpusRetriever)의 문서 색인에서 붙인다 — B/D와 같은 DocumentIR·manifest이므로 새 사실이 아니다.
  - conditions()/docs_by_id/statement_scopes/document_index/_rcept_dt는 base에 위임한다. 검색 순위는
    A 것이고, 원문 읽기·조건 추출은 기존 코어 그대로다.
  - text: A 결과에는 본문이 없다. 호출자가 주입한 TextResolver가 없거나 SHA 검증에 실패하면
    TextResolutionRequired(code=TEXT_RESOLUTION_REQUIRED)로 fail-closed한다. 빈 문자열로 진행하지 않는다.

기존 B/D 경로(build_serving_retriever)는 이 파일이 import만 하고 호출·수정하지 않는다. answer_api가
retrieval_backend 설정으로 둘 중 하나를 고른다(기본값은 기존 경로, 동작 불변).
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any, Callable, Mapping

from dart_corpus.retrieval.conditions import QueryConditions

from . import arm_a_adapter as aa
from .corpus_retriever import RetrievedChunk
from .retriever_adapter import Chunk, build_line_window_retriever

RETRIEVAL_BACKEND_DEFAULT = "DEFAULT"
RETRIEVAL_BACKEND_ARM_A = "ARM_A_FIXED_RRF"
RETRIEVAL_BACKENDS = (RETRIEVAL_BACKEND_DEFAULT, RETRIEVAL_BACKEND_ARM_A)
RETRIEVAL_BACKEND_ENV = "DART_QA_RETRIEVAL_BACKEND"

# A.run.json config.strategy(codex/fourarm-a2-integration-v01 @ 900d3cc). pins에 그대로 적는다 —
# score.py --final의 config 의미 대조(strategy≠line_window, dense=present)와 같은 어휘.
ARM_A_STRATEGY = "fixed_512_chunk"
ARM_A_DENSE = "present"

BaseFactory = Callable[..., tuple[Any, Any]]


class ServingBridgeError(RuntimeError):
    """브리지가 내는 오류의 공통 베이스. `code`는 answer_api가 trace/meta에 적는 식별자."""
    code = "ARM_A_BRIDGE_ERROR"


class TextResolutionRequired(ServingBridgeError):
    """text_resolver가 없거나, 돌려준 본문이 A의 chunk_text_sha256과 다르거나, 비어 있다."""
    code = "TEXT_RESOLUTION_REQUIRED"


class UnknownQuestionForFrozenArmA(ServingBridgeError):
    """frozen replay 한계: 이 질문은 A가 실행한 101문항 집합에 없다."""
    code = "UNKNOWN_QUESTION_FOR_FROZEN_ARM_A"


def retrieved_chunk_from_arm_a(chunk: Chunk, doc_meta: Mapping[str, Any] | None = None) -> RetrievedChunk:
    """Chunk(TypedDict, adapter 출력) -> RetrievedChunk(qa_agent 입력). 값은 옮기기만 한다."""
    text = chunk.get("text")
    if not isinstance(text, str) or text == "":
        raise TextResolutionRequired(
            f"chunk_id={chunk.get('chunk_id')}: 본문이 비어 있다 — 빈 문자열로 진행하지 않는다")
    node_index = int(chunk["node_index"])
    provenance = dict((chunk.get("metadata") or {}).get("provenance") or {})
    provenance.setdefault("node_indices", [node_index])
    provenance.setdefault("locator", chunk.get("locator"))
    metadata: dict[str, Any] = {
        **dict(doc_meta or {}),
        "arm": "A",
        "retrieval_backend": RETRIEVAL_BACKEND_ARM_A,
        "score_type": provenance.get("score_type"),
        "provenance": provenance,
    }
    metadata.setdefault("doc_group", chunk.get("doc_group") or chunk["doc_id"].split("_", 1)[0])
    return RetrievedChunk(
        chunk_id=chunk["chunk_id"],
        doc_id=chunk["doc_id"],
        score=float(chunk["score"]),
        section_path=tuple(chunk.get("section_path") or ()),
        row_labels=(),
        evidence_text=text,
        metadata=metadata,
        node_index=node_index,
    )


class ArmAServingRetriever:
    """CorpusRetriever 모양의 껍데기. 검색 순위는 adapter(A), 나머지는 base(기존 코어)."""

    arm = "A"
    strategy = ARM_A_STRATEGY

    def __init__(self, adapter: aa.ArmAFrozenResultsRetriever, base: Any = None,
                 docs_by_id: Mapping[str, dict] | None = None):
        self._adapter = adapter
        self._base = base
        self.docs_by_id = (docs_by_id if docs_by_id is not None
                           else (getattr(base, "docs_by_id", None) or {}))
        self.last: dict[str, Any] = {}

    def __getattr__(self, name: str) -> Any:
        # document_index / _rcept_dt / stage1_k … — base가 있으면 그대로 노출한다.
        base = self.__dict__.get("_base")
        if base is None:
            raise AttributeError(name)
        return getattr(base, name)

    def conditions(self, question: str) -> QueryConditions:
        if self._base is not None:
            return self._base.conditions(question)
        return QueryConditions()

    def statement_scopes(self, doc_id: str) -> Mapping[int, str]:
        fn = getattr(self._base, "statement_scopes", None) if self._base is not None else None
        return fn(doc_id) if callable(fn) else {}

    def retrieve(self, question: str, conditions: Any = None, *, k: int | None = None
                 ) -> list[RetrievedChunk]:
        if self._adapter.text_resolver is None:
            raise TextResolutionRequired(
                "text_resolver가 주입되지 않았다 — A.results.jsonl에는 본문이 없다 (fail-closed)")
        kk = int(k or 20)
        cond_map = (conditions.as_dict() if hasattr(conditions, "as_dict")
                    else (dict(conditions) if conditions else None))
        try:
            chunks = self._adapter.search(question, cond_map, k=kk)
        except (aa.TextResolutionRequiredError, aa.TextIntegrityMismatchError) as exc:
            raise TextResolutionRequired(str(exc)) from exc
        except aa.UnknownQuestionForFrozenArmAError as exc:
            raise UnknownQuestionForFrozenArmA(str(exc)) from exc
        meta_of = getattr(self._base, "_metadata_of", None) if self._base is not None else None
        out = []
        for c in chunks:
            doc_meta = meta_of(c["doc_id"]) if callable(meta_of) else {}
            out.append(retrieved_chunk_from_arm_a(c, doc_meta))
        self.last = {"k": kk, "n": len(out), "arm": self.arm}
        return out


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def build_arm_a_serving_retriever(*, text_resolver: aa.TextResolver | None,
                                  results_path: str | os.PathLike | None = None,
                                  gold_questions_path: str | os.PathLike | None = None,
                                  base_factory: BaseFactory | None = build_line_window_retriever,
                                  **paths: Any) -> tuple[Any, Any, str, dict[str, Any]]:
    """build_serving_retriever()와 같은 4-tuple `(retriever, store, arm, pins)`를 A 경로로 만든다.

    text_resolver는 호출자가 주입한다(빈 값 허용 안 함 — 없으면 readiness.arm_ready=False,
    retrieve()는 TEXT_RESOLUTION_REQUIRED). base_factory는 기존 build_line_window_retriever
    (조건 추출·원문 노드 읽기·문서 메타). 테스트는 가짜 base를 주입한다.
    """
    results_path = results_path or os.environ.get("ARM_A_RESULTS_PATH")
    if not results_path:
        raise ServingBridgeError(
            "ARM_A_FIXED_RRF 백엔드는 results_path(또는 ARM_A_RESULTS_PATH env)가 필요하다")
    gold_path = gold_questions_path or os.environ.get("ARM_A_GOLD_QUESTIONS_PATH")
    adapter = aa.ArmAFrozenResultsRetriever(results_path=results_path,
                                            gold_questions_path=gold_path,
                                            text_resolver=text_resolver)
    base, store = base_factory(**paths) if base_factory is not None else (None, None)
    bridge = ArmAServingRetriever(adapter, base=base)
    ready = adapter.readiness()
    pins: dict[str, Any] = {
        "strategy": ARM_A_STRATEGY,
        "dense": ARM_A_DENSE,
        "retrieval_backend": RETRIEVAL_BACKEND_ARM_A,
        "arm_a_adapter_version": aa.ARM_A_ADAPTER_VERSION,
        "arm_a_results_sha256": _sha256_file(Path(results_path)),
        "arm_a_mode": ready.get("mode"),
        "arm_a_n_questions": ready.get("n_questions_loaded"),
        "text_resolver_configured": bool(ready.get("text_resolver_configured")),
        "arm_ready": bool(ready.get("ready")),
    }
    return bridge, store, "A", pins
