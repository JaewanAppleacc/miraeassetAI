"""코퍼스 Retrieval 파사드 — Agent가 부르는 가장 작은 인터페이스.

`dart_corpus.retrieval`의 2단계 파이프라인을 **그대로** 호출만 한다. 점수 계산,
조건 추출, 섹션 규칙은 전부 그쪽 코드다. 여기서 하는 일은 두 가지뿐이다.

    1. Stage 1(DocumentIndex) -> Stage 2(ChunkIndex) 호출 순서를 한 곳에 모은다.
    2. Agent가 쓰기 좋은 형태(RetrievedChunk)로 결과를 옮긴다.

이 파일은 Retrieval 성능에 영향을 주지 않는다 — 기본값(stage1_k=50,
section_alpha=0.5)은 gold 25문항에서 채택된 값 그대로이고, 새 신호를 넣지 않는다.

게임(Case Pack) 쪽 `PointInTimeRetriever`와는 다른 물건이다. 그쪽은 케이스 단위
search_index.jsonl에 simulation_date 필터를 거는 Retriever고, 이쪽은 전체 코퍼스다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

from dart_corpus.retrieval import CorpDictionary, DocumentIndex, extract_conditions
from dart_corpus.retrieval.chunk_index import (
    DEFAULT_SECTION_ALPHA, Chunk, ChunkIndex, load_documents,
)
from dart_corpus.retrieval.conditions import QueryConditions

DEFAULT_STAGE1_K = 50          # gold 25문항 11차 채택값
DEFAULT_CHUNK_K = 20


@dataclass(frozen=True)
class RetrievedChunk:
    """Stage 2 결과 한 건. 답변까지 근거를 추적할 수 있게 출처를 전부 들고 다닌다."""
    chunk_id: str
    doc_id: str
    score: float
    section_path: tuple[str, ...]
    row_labels: tuple[str, ...]
    evidence_text: str
    metadata: Mapping[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "doc_id": self.doc_id,
            "score": self.score,
            "section_path": list(self.section_path),
            "row_label": list(self.row_labels),
            "evidence_text": self.evidence_text,
            "metadata": dict(self.metadata),
        }

    # validator.validate()가 기대하는 RetrievedDoc 모양. 검증기를 재사용하기 위한 어댑터다.
    def as_source(self) -> dict[str, Any]:
        return {"document_id": self.doc_id, "text": self.evidence_text,
                "chunk_id": self.chunk_id, "score": self.score}


@dataclass
class CorpusRetriever:
    """질문 -> 근거 청크. Stage 1과 Stage 2를 순서대로 부른다."""

    document_index: DocumentIndex
    corp_dict: CorpDictionary
    docs_by_id: Mapping[str, dict]
    stage1_k: int = DEFAULT_STAGE1_K
    chunk_k: int = DEFAULT_CHUNK_K
    section_alpha: float = DEFAULT_SECTION_ALPHA
    strategy: str = "line_window"
    _doc_meta: dict[str, Mapping[str, Any]] = field(default_factory=dict, repr=False)

    @classmethod
    def from_paths(cls, doc_index_path: Path | str, documents_path: Path | str,
                   universe_csv: Path | str, **kwargs) -> "CorpusRetriever":
        corp_dict = CorpDictionary.from_universe_csv(universe_csv)
        index = DocumentIndex.from_jsonl(doc_index_path, corp_dict)
        docs = {d["doc_id"]: d for d in load_documents(documents_path)}
        return cls(document_index=index, corp_dict=corp_dict, docs_by_id=docs, **kwargs)

    def conditions(self, question: str) -> QueryConditions:
        """조건 추출은 Retrieval 쪽 parser를 그대로 쓴다 — Agent가 따로 만들지 않는다."""
        return extract_conditions(question, self.corp_dict)

    def _metadata_of(self, doc_id: str) -> Mapping[str, Any]:
        hit = self._doc_meta.get(doc_id)
        if hit is None:
            doc = next((d for d in self.document_index.documents
                        if d.doc_id == doc_id), None)
            hit = {} if doc is None else {
                "corp_name": doc.corp_name, "filer_name": doc.filer_name,
                "doc_group": doc.doc_group,
                "doc_subtype": doc.doc_subtype or doc.major_label,
                "report_nm": doc.report_nm, "rcept_dt": doc.rcept_dt,
                "base_year": doc.base_year, "base_month": doc.base_month,
                "period_year": doc.period_year, "is_correction": doc.is_correction,
            }
            self._doc_meta[doc_id] = hit
        return hit

    def retrieve(self, question: str, conditions: QueryConditions | None = None,
                 *, k: int | None = None) -> list[RetrievedChunk]:
        cond = conditions or self.conditions(question)
        top_docs = [h.doc_id for h in self.document_index.search(
            question, k=self.stage1_k, conditions=cond)]
        usable = [self.docs_by_id[d] for d in top_docs if d in self.docs_by_id]
        if not usable:
            return []
        chunk_index = ChunkIndex.from_documents(usable, strategy=self.strategy)
        hits = chunk_index.search(question, k=k or self.chunk_k,
                                  section_alpha=self.section_alpha)
        return [self._to_chunk(score, chunk) for score, chunk in hits]

    def _to_chunk(self, score: float, chunk: Chunk) -> RetrievedChunk:
        return RetrievedChunk(
            chunk_id=chunk.chunk_id,
            doc_id=chunk.doc_id,
            score=score,
            section_path=tuple(chunk.section_path),
            row_labels=tuple(sorted(chunk.row_labels)),
            evidence_text=chunk.search_text,
            metadata=self._metadata_of(chunk.doc_id),
        )


def chunk_lines(chunk: RetrievedChunk) -> Sequence[str]:
    return [ln.strip() for ln in chunk.evidence_text.split("\n") if ln.strip()]
