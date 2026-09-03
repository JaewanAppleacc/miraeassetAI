"""④ retriever_adapter — 에이전트와 4-arm 러너가 검색 코어를 부르는 유일한 문 (interfaces.md §3).

승자가 A/B/C/D 중 누구든 에이전트 층은 `bind(arm)`만 바꾼다. 함수는 셋뿐이다.

    search(question, conditions, k) -> list[Chunk]     검색 발췌(top-k, rank 순)
    fetch_node(doc_id, node_index)  -> Node            근거 확정용 원문 역참조
    readiness()                     -> dict            SHA pin·의존성 (vFINAL 19번, /ready)

locator 규약(§0-2): 본질은 (doc_id, node_index). 문자열은 "{doc_id}/{rcept_no}.xml#node={node_index}".

B/D 바인딩(LineWindowAdapter)은 기존 CorpusRetriever(Stage 1 DocumentIndex → Stage 2 line-window
ChunkIndex)를 **그대로** 호출하고, 문서는 NodeStore가 지연 로딩한다. 검색 점수·조건 추출은 손대지 않는다.
  D = BM25-only.
  B = D + LOW 세그먼트(vFINAL 1번, segments.py)일 때만 dense 재정렬. 재정렬기는 주입(inject)한다 —
      이 저장소에는 아직 KURE 구현이 없다(retrieval_experiment_report.md: CPU 환경에서 미실행).
      주입되지 않은 B는 readiness()가 ready=False를 돌려준다. B를 D로 조용히 바꾸지 않는다.
A/C 바인딩은 팀원1의 pgvector 스택이 이 Protocol을 구현한다.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence, TypedDict, runtime_checkable

from dart_corpus.retrieval import DocumentIndex
from dart_corpus.retrieval.conditions import QueryConditions
from dart_corpus.retrieval.corp_dictionary import CorpDictionary
from dart_corpus.retrieval.node_store import NodeStore, default_document_ir_dir
from dart_corpus.retrieval.segments import conditions_from_dict, segment_of

from .corpus_retriever import CorpusRetriever, RetrievedChunk

ARMS = ("A", "B", "C", "D")
ARM_LABELS = {
    "A": "FIXED+FULL_DENSE",
    "B": "LINE_WINDOW+LOW_ONLY_DENSE",
    "C": "FIXED+DENSE_OFF",
    "D": "LINE_WINDOW+DENSE_OFF",
}
REPO_ROOT = Path(__file__).resolve().parents[2]


class Chunk(TypedDict):
    chunk_id: str
    doc_id: str
    node_index: int
    locator: str
    text: str
    header: str
    section_path: list[str]
    doc_group: str
    score: float
    metadata: dict


class Node(TypedDict):
    doc_id: str
    node_index: int
    kind: str
    section_path: list[str]
    lines: list[str]
    text: str


@runtime_checkable
class DenseReranker(Protocol):
    """B arm의 LOW 세그먼트 재정렬기. 구현체는 KURE-v1(rev pin)이어야 한다(v4 §8)."""
    model_rev: str

    def rerank(self, question: str, chunks: Sequence[Chunk]) -> list[Chunk]: ...


@runtime_checkable
class RetrieverAdapter(Protocol):
    arm: str

    def search(self, question: str, conditions: Mapping[str, Any] | None = None,
               k: int = 20) -> list[Chunk]: ...

    def fetch_node(self, doc_id: str, node_index: int) -> Node: ...

    def readiness(self) -> dict[str, Any]: ...


def rcept_no_of(doc_id: str) -> str:
    tail = doc_id.rsplit("_", 1)[-1]
    return tail if tail.isdigit() else ""


def locator_of(doc_id: str, node_index: int) -> str:
    return f"{doc_id}/{rcept_no_of(doc_id)}.xml#node={node_index}"


def chunk_from_retrieved(c: RetrievedChunk) -> Chunk:
    node_index = int(c.node_index) if c.node_index is not None else -1
    return Chunk(
        chunk_id=c.chunk_id,
        doc_id=c.doc_id,
        node_index=node_index,
        locator=locator_of(c.doc_id, node_index),
        text=c.evidence_text,
        header="",
        section_path=list(c.section_path),
        doc_group=str(c.metadata.get("doc_group") or c.doc_id.split("_", 1)[0]),
        score=float(c.score),
        metadata=dict(c.metadata),
    )


class LineWindowAdapter:
    """B/D — 기존 CorpusRetriever 위의 얇은 껍데기. 검색 로직은 한 줄도 여기 없다."""

    def __init__(self, retriever: CorpusRetriever, store: NodeStore, arm: str = "D",
                 dense: DenseReranker | None = None, dense_pool: int | None = None):
        if arm not in ("B", "D"):
            raise ValueError(f"LineWindowAdapter는 B/D 전용이다: {arm}")
        self.arm = arm
        self.retriever = retriever
        self.store = store
        self.dense = dense
        # B·LOW에서 재정렬할 BM25 후보 수. 재정렬기가 값을 갖고 있으면 그것을 따른다(as-built 기록).
        self.dense_pool = int(dense_pool or getattr(dense, "dense_pool", 0) or 0)
        self.last: dict[str, Any] = {}      # 직전 search의 세그먼트·재정렬 여부 (러너 기록용)

    def search(self, question: str, conditions: Mapping[str, Any] | None = None,
               k: int = 20) -> list[Chunk]:
        cond: QueryConditions = (conditions_from_dict(conditions) if conditions is not None
                                 else self.retriever.conditions(question))
        segment = segment_of(cond)
        use_dense = self.arm == "B" and segment == "LOW"
        if use_dense and self.dense is None:
            raise RuntimeError("arm B는 LOW 세그먼트에서 dense 재정렬기가 필요하다 — 주입되지 않았다")
        # B·LOW는 BM25 후보를 dense_pool개까지 넓혀 받아 재정렬한 뒤 k개로 자른다.
        pool = max(k, self.dense_pool) if use_dense else k
        hits = self.retriever.retrieve(question, cond, k=pool)
        chunks = [chunk_from_retrieved(h) for h in hits]
        reranked = False
        if use_dense:
            chunks = list(self.dense.rerank(question, chunks))[:k]
            reranked = True
        self.last = {"segment": segment, "dense_reranked": reranked, "pool": pool,
                     "conditions": cond.as_dict()}
        return chunks

    def fetch_node(self, doc_id: str, node_index: int) -> Node:
        n = self.store.fetch_node(doc_id, node_index)
        return Node(doc_id=n["doc_id"], node_index=n["node_index"], kind=n.get("kind") or "",
                    section_path=list(n.get("section_hierarchy") or []),
                    lines=list(n.get("lines") or []), text=n.get("text") or "")

    def readiness(self) -> dict[str, Any]:
        store = self.store.readiness()
        needs_dense = self.arm == "B"
        dense_ok = (self.dense is not None) if needs_dense else True
        return {
            "arm": self.arm,
            "label": ARM_LABELS[self.arm],
            "ready": bool(store["n_docs"]) and dense_ok,
            "mode": "real",
            "n_docs": store["n_docs"],
            "pins": {
                **store["pins"],
                "strategy": self.retriever.strategy,
                "stage1_k": self.retriever.stage1_k,
                "chunk_k": self.retriever.chunk_k,
                "dense_model_rev": getattr(self.dense, "model_rev", None) if needs_dense else None,
                "dense_pool": self.dense_pool if needs_dense else None,
                **(self.dense.pins() if (needs_dense and hasattr(self.dense, "pins")) else {}),
            },
            "dense": ("present" if self.dense is not None else "absent") if needs_dense else "off",
            "external_services": [],
        }


# ---------- 바인딩 ----------

def _env_path(name: str, default: Path) -> Path:
    v = os.environ.get(name)
    return Path(v) if v else default


def load_corp_dictionary(universe_csv: Path | str,
                         aliases_path: Path | str | None = None) -> CorpDictionary:
    """universe.csv + 채택 별칭(corp_aliases.v1.json: alias→corp_name)으로 기업 사전을 만든다.

    별칭 점검(docs/reports/alias_coverage.md) 실측: 통용 표기(LG엔솔·포스코·현대중공업 등)가
    미매칭이면 기업 필터가 비어 **엉뚱한 회사** 문서가 상위에 온다(LG엔솔→LG이노텍 실측).
    검색 코어(corp_dictionary.py)는 수정하지 않는다 — 별칭을 listed_name 행으로 주입만 한다.
    별칭 파일의 corp_name이 universe에 없으면 무시한다(오타로 유령 기업을 만들지 않기 위해)."""
    import csv
    with Path(universe_csv).open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    known = {r.get("corp_name", "").strip() for r in rows}
    path = (Path(aliases_path) if aliases_path
            else _env_path("DART_QA_ALIASES", REPO_ROOT / "data" / "corpus" / "corp_aliases.v1.json"))
    if path.exists():
        import json as _json
        data = _json.loads(path.read_text(encoding="utf-8"))
        for corp_name, aliases in data.items():
            if corp_name.startswith("_") or corp_name not in known:
                continue
            for alias in aliases:
                rows.append({"corp_name": corp_name, "listed_name": alias, "stock_code": ""})
    return CorpDictionary.from_rows(rows)


def build_line_window_retriever(*, doc_index: Path | str | None = None,
                                universe_csv: Path | str | None = None,
                                index_dir: Path | str | None = None,
                                document_ir_dir: Path | str | None = None,
                                cache_size: int | None = None) -> tuple[CorpusRetriever, NodeStore]:
    """기존 CorpusRetriever + NodeStore. 경로는 인자 > 환경변수 > 저장소 기본값."""
    index_dir = Path(index_dir) if index_dir else _env_path("DART_QA_INDEX_DIR", REPO_ROOT / "data" / "index")
    doc_index = Path(doc_index) if doc_index else _env_path("DART_QA_DOC_INDEX", index_dir / "doc_index.jsonl")
    universe_csv = (Path(universe_csv) if universe_csv
                    else _env_path("DART_QA_UNIVERSE", REPO_ROOT / "data" / "corpus" / "universe.csv"))
    document_ir_dir = Path(document_ir_dir) if document_ir_dir else _env_path(
        "DART_QA_DOCUMENT_IR_DIR", default_document_ir_dir())
    corp = load_corp_dictionary(universe_csv)
    index = DocumentIndex.from_jsonl(doc_index, corp)
    kwargs = {"cache_size": cache_size} if cache_size else {}
    store = NodeStore(index_dir, document_ir_dir, **kwargs)
    retriever = CorpusRetriever(document_index=index, corp_dict=corp, docs_by_id=store)
    return retriever, store


def bind(arm: str | None = None, *, dense: DenseReranker | None = None,
         **paths: Any) -> RetrieverAdapter:
    """DART_QA_ARM(또는 인자)으로 어댑터를 고른다. A/C는 팀원1 구현이 들어올 자리다.

    B는 dense를 안 주면 KURE 재정렬기를 만든다(dense_rerank.build_kure_reranker). 패키지·모델이
    없으면 거기서 명확히 실패한다 — B를 D로 조용히 바꾸지 않는다.
    """
    arm = (arm or os.environ.get("DART_QA_ARM") or "D").upper()
    if arm not in ARMS:
        raise ValueError(f"알 수 없는 arm: {arm} (A/B/C/D)")
    if arm in ("B", "D"):
        if arm == "B" and dense is None:
            from .dense_rerank import build_kure_reranker
            dense = build_kure_reranker()
        retriever, store = build_line_window_retriever(**paths)
        return LineWindowAdapter(retriever, store, arm=arm, dense=dense)
    raise NotImplementedError(
        f"arm {arm}({ARM_LABELS[arm]})의 어댑터는 A/C 스택(팀원1)이 RetrieverAdapter Protocol로 구현한다")


class _DenseLowServingRetriever:
    """B arm 서빙용 — CorpusRetriever 위임 + LOW 세그먼트 dense 재정렬.

    qa_agent는 CorpusRetriever 인터페이스(conditions/retrieve/docs_by_id/statement_scopes)를
    쓰므로 어댑터(search)를 직접 못 꽂는다. 재정렬 규칙은 LineWindowAdapter.search와 동일:
    LOW에서만, BM25 후보 dense_pool개를 재정렬해 k개로 자른다. (검수 발견 3 — 서빙이
    선택 arm을 실제로 타지 않던 문제의 B쪽 배선.)
    """

    def __init__(self, retriever: CorpusRetriever, dense: DenseReranker,
                 dense_pool: int | None = None):
        self._retriever = retriever
        self._dense = dense
        self._pool = int(dense_pool or getattr(dense, "dense_pool", 0) or 50)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._retriever, name)

    def retrieve(self, question: str, conditions: Any = None, k: int | None = None) -> list:
        cond = conditions if conditions is not None else self._retriever.conditions(question)
        kk = k or 20
        if segment_of(cond) != "LOW":
            return self._retriever.retrieve(question, cond, k=kk)
        hits = self._retriever.retrieve(question, cond, k=max(kk, self._pool))
        ranked = self._dense.rerank(question, [chunk_from_retrieved(h) for h in hits])
        order = {c["chunk_id"]: i for i, c in enumerate(ranked)}
        return sorted(hits, key=lambda h: order.get(h.chunk_id, len(order)))[:kk]


def build_serving_retriever(arm: str | None = None, **paths: Any
                            ) -> tuple[Any, NodeStore, str, dict[str, Any]]:
    """서빙(answer_api)용 retriever. 반환: (retriever, store, 실제 arm, arm pin).

    bind()와 같은 선택 규칙(DART_QA_ARM, 기본 D)을 따르되, qa_agent가 소비할 수 있는
    CorpusRetriever 인터페이스로 돌려준다. A/C는 명확히 실패한다 — readiness가
    ready=False로 드러나며, 환경변수만 바꿔 다른 arm을 주장할 수 없다.
    """
    arm = (arm or os.environ.get("DART_QA_ARM") or "D").upper()
    if arm not in ("B", "D"):
        raise NotImplementedError(
            f"서빙 arm {arm}은 아직 배선되지 않았다 — A/C 스택 통합 시 build_serving_retriever에 추가")
    retriever, store = build_line_window_retriever(**paths)
    pins: dict[str, Any] = {"strategy": retriever.strategy}
    if arm == "B":
        from .dense_rerank import build_kure_reranker
        dense = build_kure_reranker()
        pins.update(dense.pins() if hasattr(dense, "pins") else {})
        return _DenseLowServingRetriever(retriever, dense), store, arm, pins
    return retriever, store, arm, pins
