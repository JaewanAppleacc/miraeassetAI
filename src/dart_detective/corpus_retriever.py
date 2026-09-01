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

import dataclasses
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

from dart_corpus.retrieval import CorpDictionary, DocumentIndex, extract_conditions
from dart_corpus.retrieval.chunk_index import (
    DEFAULT_SECTION_ALPHA, Chunk, ChunkIndex, load_documents,
)
from dart_corpus.retrieval.conditions import QueryConditions

# 공시 서식의 항목 이름. 여기(검색 창구)에 두는 이유: retrieve()가 절단 전 재정렬
# 게이트로 쓰고, Agent도 슬롯 계획에 쓴다 — Agent가 이쪽을 import하므로 순환이 없다.
# 원래 주석: 재무지표(매출액·영업이익)는 표 구조가 "지표 × 연도"라
# infer_metrics가 맡고, 여기는 계약·투자·해지 공시처럼 "항목 | 값" 한 줄로 끝나는
# 서식을 맡는다. 서식이 정해져 있어 항목명이 원문에 거의 그대로 적힌다 —
# 그래서 사전이 짧고, 새 표현을 추측해서 늘리지 않는다.
DISCLOSURE_ITEMS: dict[str, str] = {
    "계약금액": "계약금액", "계약 금액": "계약금액", "수주금액": "계약금액",
    "해지금액": "해지금액", "해지 금액": "해지금액",
    "투자금액": "투자금액", "투자 금액": "투자금액", "투자규모": "투자금액",
    "자기자본대비": "자기자본대비", "자기자본 대비": "자기자본대비",
    "매출액대비": "매출액대비", "매출액 대비": "매출액대비",
    "최근매출액": "최근매출액",
    "종료일": "종료일", "만료일": "종료일",
    "시작일": "시작일", "착수일": "시작일",
    "해지일자": "해지일자", "해지일": "해지일자",
    "해지사유": "해지 주요사유", "해지 사유": "해지 주요사유",
    "계약상대": "계약상대", "계약 상대": "계약상대", "계약상대방": "계약상대",
    "공급지역": "판매ㆍ공급지역", "판매지역": "판매ㆍ공급지역",
    "투자목적": "투자목적", "투자대상": "투자대상",
    "이사회결의일": "이사회결의일", "결의일": "이사회결의일",
    "자기자본": "자기자본",
}


def extract_disclosure_items(question: str) -> tuple[str, ...]:
    """질문에 **직접 적힌** 공시 항목만 뽑는다. 추론하지 않는다.

    "자기자본 대비 비율"은 '자기자본대비' 하나다 — 더 긴 항목이 잡히면 그 안에
    들어가는 짧은 항목('자기자본')은 버린다. 안 그러면 같은 값을 두 자리가 다툰다.
    """
    hits = list(dict.fromkeys(norm for word, norm in DISCLOSURE_ITEMS.items()
                              if word in question))
    return tuple(h for h in hits
                 if not any(other != h and h in other for other in hits))


DEFAULT_STAGE1_K = 50          # gold 25문항 11차 채택값
DEFAULT_CHUNK_K = 20
# 항목 질문에서 원문 공시 조각에 주는 가산(절단 전). 스윕 실측으로 채택.
ITEM_DOC_BONUS = 0.15
# 질문이 못 박은 접수일과 같은 날 접수된 문서의 청크 가산. 날짜가 없는 질문엔 0 효과.
DATE_DOC_BONUS = 0.3
_ISO_DATE_RE = re.compile(r"((?:19|20)\d{2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?!\d)")


def question_dates(question: str) -> list[tuple[int, int, int]]:
    """질문 속 '2024-04-17' / '2024.04.17' 꼴 날짜. 월·일 범위 밖이면 버린다."""
    out = []
    for y, m, d in _ISO_DATE_RE.findall(question or ""):
        y, m, d = int(y), int(m), int(d)
        if 1 <= m <= 12 and 1 <= d <= 31:
            out.append((y, m, d))
    return out
PRIMARY_DOC_GROUPS = ("exchange", "major")


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
    # 원문 노드 번호. 팀 공통 계약의 source_locator가 이 번호를 요구한다.
    node_index: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "doc_id": self.doc_id,
            "score": self.score,
            "section_path": list(self.section_path),
            "row_label": list(self.row_labels),
            "evidence_text": self.evidence_text,
            "node_index": self.node_index,
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
    _scope_cache: dict[str, dict[int, str]] = field(default_factory=dict, repr=False)

    @classmethod
    def from_paths(cls, doc_index_path: Path | str, documents_path: Path | str,
                   universe_csv: Path | str, **kwargs) -> "CorpusRetriever":
        corp_dict = CorpDictionary.from_universe_csv(universe_csv)
        index = DocumentIndex.from_jsonl(doc_index_path, corp_dict)
        docs = {d["doc_id"]: d for d in load_documents(documents_path)}
        return cls(document_index=index, corp_dict=corp_dict, docs_by_id=docs, **kwargs)

    def statement_scopes(self, doc_id: str) -> Mapping[int, str]:
        """노드 번호 -> "연결" | "별도". 표 바로 앞 제목 문단으로 가른다.

        사업보고서 요약재무정보에는 같은 섹션 안에 표가 둘 있다.
            가. 요약연결재무정보   <- 연결
            나. 요약재무정보       <- 별도
        표 자체에는 구분이 없고 앞 문단에만 있다. 검색 점수는 그대로 두고, 근거를 고를 때
        참고하려고 여기서 문서 한 번만 훑어 만든다.
        """
        cached = self._scope_cache.get(doc_id)
        if cached is not None:
            return cached
        scopes: dict[int, str] = {}
        current = ""
        for node in (self.docs_by_id.get(doc_id) or {}).get("nodes") or []:
            text = (node.get("text") or "").strip()
            if node.get("kind") != "table" and text:
                head = text[:60]
                if "연결" in head and "별도" not in head and "개별" not in head:
                    current = "연결"
                elif ("별도" in head or "개별" in head
                      or head.startswith(("나. 요약재무정보", "요약재무정보"))):
                    current = "별도"
                elif _looks_like_heading(text):
                    # 제목인데 연결/별도 표기가 없다 — 이전 표기를 먼 표까지 끌고 가지
                    # 않는다. 모르는 것은 모르는 채로 둔다.
                    current = ""
            elif node.get("kind") == "table":
                # 표 자신의 첫 줄에 표기가 있으면 그것이 우선이다.
                first = text.split(chr(10), 1)[0][:60]
                if "연결" in first and "별도" not in first:
                    scopes[node.get("node_index", -1)] = "연결"
                elif "별도" in first or "개별" in first:
                    scopes[node.get("node_index", -1)] = "별도"
                elif current:
                    scopes[node.get("node_index", -1)] = current
        self._scope_cache[doc_id] = scopes
        return scopes

    def conditions(self, question: str) -> QueryConditions:
        """조건 추출은 Retrieval 쪽 parser를 그대로 쓴다 — Agent가 따로 만들지 않는다.

        예외 하나: "2024-04-17"처럼 하이픈/점으로 쓴 날짜는 Retrieval parser가 연도로
        읽지 않는다(Phase1 실측: 삼성E&A·신한지주 2건이 날짜 필터 없이 같은 회사의
        다른 해 공시에 밀려 상위 50 밖). 여기서 연도만 보태 준다 — 검색 코어는 그대로다.
        """
        cond = extract_conditions(question, self.corp_dict)
        dates = question_dates(question)
        if dates:
            years = frozenset(cond.years) | {y for y, _, _ in dates}
            if years != cond.years:
                cond = dataclasses.replace(cond, years=years)
        return cond

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
                "rcept_no": getattr(doc, "rcept_no", ""),
                "base_year": doc.base_year, "base_month": doc.base_month,
                "period_year": doc.period_year, "is_correction": doc.is_correction,
            }
            self._doc_meta[doc_id] = hit
        return hit

    def retrieve(self, question: str, conditions: QueryConditions | None = None,
                 *, k: int | None = None) -> list[RetrievedChunk]:
        cond = conditions or self.conditions(question)
        dates = {f"{y:04d}{m:02d}{d:02d}" for y, m, d in question_dates(question)}
        # 질문이 접수일을 날짜로 못 박았으면(2024-04-17) 그 날 접수된 공시를 Stage 1
        # 절단 앞으로 당긴다. 같은 회사가 한 해에 같은 유형 공시를 수십 건 내는 경우
        # BM25만으로는 특정 날짜 문서가 50위 안에 못 든다(Phase1 실측 2건).
        stage1_k = self.stage1_k * (4 if dates else 1)
        top_docs = [h.doc_id for h in self.document_index.search(
            question, k=stage1_k, conditions=cond)]
        if dates:
            top_docs = ([d for d in top_docs if self._rcept_dt(d) in dates]
                        + [d for d in top_docs if self._rcept_dt(d) not in dates])[:self.stage1_k]
        usable = [self.docs_by_id[d] for d in top_docs if d in self.docs_by_id]
        if not usable:
            return []
        chunk_index = ChunkIndex.from_documents(usable, strategy=self.strategy)
        want = k or self.chunk_k
        if dates:
            # 청크 단계에서도 접수일 일치 문서를 절단 전에 가산한다(ITEM_DOC_BONUS와 같은 틀).
            date_docs = {d for d in top_docs if self._rcept_dt(d) in dates}
            hits = chunk_index.search(question, k=len(chunk_index.chunks),
                                      section_alpha=self.section_alpha)
            hits = sorted(((score * (1.0 + DATE_DOC_BONUS)
                            if chunk.doc_id in date_docs else score, chunk)
                           for score, chunk in hits), key=lambda x: -x[0])[:want]
            return [self._to_chunk(score, chunk) for score, chunk in hits]
        # 계약금액·투자금액 같은 항목 질문의 답은 원문 공시(exchange/major) 서식에 있다.
        # 사업보고서의 요약 한 줄이 짧아서(BM25 길이 정규화) 원문을 이기는 실측(N05)이
        # 있어, 항목이 잡힌 질문에서만 원문 공시 조각을 절단 전에 가산한다.
        # beta 스윕(0/0.15/0.3/0.5) 실측: gold25 E-R 전 구간 완전 불변,
        # 새 24문항 상위20 35->36/36. 최소 유효값 0.15를 쓴다.
        if extract_disclosure_items(question):
            hits = chunk_index.search(question, k=len(chunk_index.chunks),
                                      section_alpha=self.section_alpha)
            hits = sorted(((score * (1.0 + ITEM_DOC_BONUS)
                            if chunk.doc_group in PRIMARY_DOC_GROUPS else score, chunk)
                           for score, chunk in hits), key=lambda x: -x[0])[:want]
        else:
            hits = chunk_index.search(question, k=want,
                                      section_alpha=self.section_alpha)
        return [self._to_chunk(score, chunk) for score, chunk in hits]

    def _rcept_dt(self, doc_id: str) -> str:
        return str(self._metadata_of(doc_id).get("rcept_dt") or "")

    def _to_chunk(self, score: float, chunk: Chunk) -> RetrievedChunk:
        return RetrievedChunk(
            chunk_id=chunk.chunk_id,
            doc_id=chunk.doc_id,
            score=score,
            section_path=tuple(chunk.section_path),
            row_labels=tuple(sorted(chunk.row_labels)),
            evidence_text=chunk.search_text,
            metadata=self._metadata_of(chunk.doc_id),
            node_index=chunk.node_index,
        )


_HEADING_PREFIX = tuple(f"{c}." for c in "가나다라마바사아자차") + tuple(f"{i}." for i in range(1, 10))


def _looks_like_heading(text: str) -> bool:
    """짧고 목차 번호로 시작하는 문단 — 표 제목일 가능성이 높다."""
    line = text.split(chr(10), 1)[0].strip()
    return len(line) <= 40 and line.startswith(_HEADING_PREFIX)


def chunk_lines(chunk: RetrievedChunk) -> Sequence[str]:
    return [ln.strip() for ln in chunk.evidence_text.split("\n") if ln.strip()]
