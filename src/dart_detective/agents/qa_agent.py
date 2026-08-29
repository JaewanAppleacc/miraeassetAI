"""코퍼스 QA Agent — Retrieval 위에 얹는 orchestration layer.

    질문
      -> 조건/의도 파싱      (Retrieval의 parser를 그대로 재사용)
      -> CorpusRetriever     (Stage 1 문서 -> Stage 2 청크, 점수 계산은 그쪽 것)
      -> Evidence 선택/검증  (slot별 근거 매칭 + validator)
      -> 답변                (LLM 주입 가능, 없으면 결정론적 발췌)

Agent는 Retrieval을 대체하지 않는다. 부르고, 결과를 해석한다.

근거 없는 답을 만들지 않기 위한 규칙:
  - 답변 문장은 근거 줄에서만 만든다. 근거가 없으면 없다고 답한다.
  - LLM 답변은 validator로 대조해 UNSUPPORTED면 버리고 발췌 답변으로 되돌린다.
  - 모든 근거는 chunk_id / doc_id / section_path를 달고 다닌다(추적 가능성).

게임 쪽 `agents/evidence_agent.py`와 역할이 겹치지 않는다 — 그쪽은 Case Pack +
PointInTimeRetriever(시점 차단)용이고, 이쪽은 전체 코퍼스 Retrieval용이다.
검증기(validator)와 LLM 인터페이스는 공유한다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from dart_corpus.retrieval.chunk_index import infer_metrics, row_label_of
from dart_corpus.retrieval.conditions import QueryConditions

from ..corpus_retriever import CorpusRetriever, RetrievedChunk, chunk_lines
from ..llm import LLMResult, LLMUnavailable
from . import validator

MAX_EVIDENCE = 5
ANSWER_SLOT = "answer"

ANSWER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "document_id": {"type": "string"},
                    "quote_or_fact": {"type": "string"},
                },
                "required": ["document_id", "quote_or_fact"],
                "additionalProperties": False,
            },
        },
        "uncertainty": {"type": "string"},
    },
    "required": ["answer", "evidence", "uncertainty"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """너는 공시 분석 Agent다. 아래에 주어진 공시 발췌만 근거로 답한다.

절대 규칙:
- 발췌에 없는 숫자를 쓰지 마라. 숫자는 발췌에 적힌 그대로 옮겨라.
- evidence[].quote_or_fact는 발췌 원문을 **글자 그대로** 복사한 한 줄이어야 한다.
- 발췌만으로 답할 수 없으면 answer에 그렇게 적고, uncertainty에 무엇이 더 필요한지 써라.
- 발췌 밖의 지식(네가 아는 회사 사실, 최신 뉴스)을 쓰지 마라."""


@dataclass(frozen=True)
class EvidenceMatch:
    """질문의 요구사항 하나(slot)와 근거 청크의 연결."""
    slot: str
    chunk_id: str
    doc_id: str
    evidence_text: str
    section_path: tuple[str, ...]
    confidence: float
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "slot": self.slot, "chunk_id": self.chunk_id, "doc_id": self.doc_id,
            "evidence_text": self.evidence_text,
            "section_path": list(self.section_path),
            "confidence": self.confidence, "reason": self.reason,
        }


@dataclass
class AgentState:
    """Agent가 한 질문을 처리하는 동안 들고 있는 전부."""
    question: str
    conditions: QueryConditions | None = None
    slots: tuple[str, ...] = ()
    retrieval_results: list[RetrievedChunk] = field(default_factory=list)
    evidence_matches: list[EvidenceMatch] = field(default_factory=list)
    answer: str = ""
    uncertainty: str = ""
    validation: dict[str, Any] = field(default_factory=dict)
    llm: dict[str, Any] = field(default_factory=lambda: {"used": False})

    def to_dict(self) -> dict[str, Any]:
        return {
            "answer": self.answer,
            "evidence": [
                {"chunk_id": m.chunk_id, "text": m.evidence_text,
                 "section_path": list(m.section_path), "doc_id": m.doc_id}
                for m in self.evidence_matches
            ],
            "evidence_matches": [m.to_dict() for m in self.evidence_matches],
            "slots": list(self.slots),
            "conditions": self.conditions.as_dict() if self.conditions else {},
            "retrieval": [c.to_dict() for c in self.retrieval_results],
            "uncertainty": self.uncertainty,
            "validation": self.validation,
            "llm": self.llm,
        }


# ---------- 1. 질문 이해 ----------

def plan_slots(question: str, conditions: QueryConditions) -> tuple[str, ...]:
    """질문이 요구하는 근거 자리(slot)를 정한다.

    지표 추출은 Retrieval의 `infer_metrics`를 그대로 쓴다 — parser를 새로 만들지 않는다.
    지표 × 연도로 자리를 만들고(예: 영업이익_2025), 지표가 없으면 자리 하나로 둔다.
    """
    metrics = infer_metrics(question)
    years = sorted(conditions.years)
    if not metrics:
        return (ANSWER_SLOT,)
    if not years:
        return tuple(metrics)
    return tuple(f"{m}_{y}" for m in metrics for y in years)


def split_slot(slot: str) -> tuple[str, int | None]:
    m = re.fullmatch(r"(.+)_((?:19|20)\d{2})", slot)
    return (m.group(1), int(m.group(2))) if m else (slot, None)


# ---------- 2. 근거 선택 ----------

def _line_for(chunk: RetrievedChunk, metric: str) -> str:
    """지표가 적힌 줄을 고른다. 못 찾으면 청크의 첫 줄."""
    lines = chunk_lines(chunk)
    for line in lines:
        if metric and (metric in row_label_of(line) or metric in line):
            return line
    return lines[0] if lines else chunk.evidence_text.strip()


def match_evidence(slots: Sequence[str], chunks: Sequence[RetrievedChunk],
                   *, limit: int = MAX_EVIDENCE) -> list[EvidenceMatch]:
    """slot마다 가장 잘 맞는 청크를 고른다. 근거가 없으면 그 slot은 비운다.

    선택은 결정론적이다 — 지표가 행 레이블에 있는지, 연도가 청크/문서에 있는지,
    그리고 Retrieval 점수 순서만 본다. LLM은 여기 관여하지 않는다.
    """
    matches: list[EvidenceMatch] = []
    used: set[str] = set()
    if tuple(slots) == (ANSWER_SLOT,):
        # 지표가 없는 질문은 자리를 나눌 수 없다. 상위 청크 몇 개를 그대로 근거로 준다.
        return [
            EvidenceMatch(slot=ANSWER_SLOT, chunk_id=c.chunk_id, doc_id=c.doc_id,
                          evidence_text=_line_for(c, ""), section_path=c.section_path,
                          confidence=round(1.0 / rank, 4),
                          reason=f"Retrieval {rank}위")
            for rank, c in enumerate(list(chunks)[:min(limit, 3)], start=1)
        ]
    for slot in slots:
        metric, year = split_slot(slot)
        best: tuple[float, RetrievedChunk, str] | None = None
        for rank, chunk in enumerate(chunks, start=1):
            reasons: list[str] = []
            weight = 0.0
            if metric != ANSWER_SLOT:
                if metric in chunk.row_labels:
                    weight += 0.5
                    reasons.append(f"행 레이블 '{metric}' 일치")
                elif metric in chunk.evidence_text:
                    weight += 0.25
                    reasons.append(f"본문에 '{metric}' 등장")
            if year is not None:
                if str(year) in chunk.evidence_text:
                    weight += 0.25
                    reasons.append(f"본문에 {year} 등장")
                elif chunk.metadata.get("period_year") == year:
                    weight += 0.15
                    reasons.append(f"문서 기준연도 {year}")
            if metric != ANSWER_SLOT and not reasons:
                continue
            rank_score = 1.0 / rank
            score = weight + rank_score
            reasons.append(f"Retrieval {rank}위")
            if chunk.chunk_id in used:
                score -= 0.1        # 같은 청크로 모든 slot을 채우지 않는다
            if best is None or score > best[0]:
                best = (score, chunk, ", ".join(reasons))
        if best is None:
            continue
        score, chunk, reason = best
        used.add(chunk.chunk_id)
        matches.append(EvidenceMatch(
            slot=slot, chunk_id=chunk.chunk_id, doc_id=chunk.doc_id,
            evidence_text=_line_for(chunk, split_slot(slot)[0]),
            section_path=chunk.section_path,
            confidence=round(min(score, 1.0), 4), reason=reason,
        ))
        if len(matches) >= limit:
            break
    return matches


# ---------- 3. 답변 ----------

def fallback_answer(matches: Sequence[EvidenceMatch]) -> tuple[str, str]:
    """LLM 없이 만드는 답변. 근거 줄만 그대로 옮기므로 항상 grounded다.

    출처(doc_id·section_path)는 답변 문장에 넣지 않는다 — doc_id에 숫자가 들어 있어서
    본문에 섞으면 Validator가 '원문에 없는 수치'로 잡는다(실측: periodic_20260318000826).
    추적은 evidence_matches가 담당한다.
    """
    if not matches:
        return ("검색된 공시에서 이 질문에 답할 근거를 찾지 못했다.",
                "질문을 좁히거나 기간·기업 조건을 명시해야 한다.")
    lines = "\n".join(f"- [{m.slot}] {m.evidence_text}" for m in matches)
    return ("검색된 공시에서 확인되는 근거는 다음과 같다.\n" + lines,
            "위 줄은 원문 발췌 그대로다. 출처는 evidence의 doc_id/section_path에 있다.")


def _llm_answer(llm: Any, question: str, matches: Sequence[EvidenceMatch]
                ) -> tuple[dict[str, Any], dict[str, Any]]:
    excerpts = "\n\n".join(
        f"[{m.doc_id}] slot={m.slot}"
        + (f" · {' > '.join(m.section_path)}" if m.section_path else "")
        + f"\n{m.evidence_text}"
        for m in matches
    )
    user = (f"질문: {question}\n\n=== 공시 발췌 ===\n{excerpts}\n=== 발췌 끝 ===")
    result: LLMResult = llm.complete_json(SYSTEM_PROMPT, user, ANSWER_SCHEMA)
    meta = {"provider": result.provider, "model": result.model,
            "latency_ms": result.latency_ms, "usage": result.usage}
    return result.data, meta


# ---------- pipeline ----------

def answer_question(question: str, retriever: CorpusRetriever, *,
                    llm: Any | None = None, k: int | None = None,
                    max_evidence: int = MAX_EVIDENCE) -> AgentState:
    """질문 하나를 끝까지 처리한다. 반환은 AgentState — 중간 단계가 전부 남는다."""
    state = AgentState(question=question)
    state.conditions = retriever.conditions(question)
    state.slots = plan_slots(question, state.conditions)
    state.retrieval_results = retriever.retrieve(question, state.conditions, k=k)
    state.evidence_matches = match_evidence(state.slots, state.retrieval_results,
                                            limit=max_evidence)

    sources = [c.as_source() for c in state.retrieval_results]
    answer, uncertainty = fallback_answer(state.evidence_matches)
    citations = [{"document_id": m.doc_id, "quote_or_fact": m.evidence_text}
                 for m in state.evidence_matches]

    if llm is not None and state.evidence_matches:
        try:
            payload, meta = _llm_answer(llm, question, state.evidence_matches)
            state.llm = {"used": True, **meta}
            llm_citations = payload.get("evidence", []) or []
            check = validator.validate(payload.get("answer", ""), llm_citations, sources)
            if check["status"] == "UNSUPPORTED":
                # 근거 없는 수치/인용 -> LLM 답변을 버린다. 발췌 답변이 최종본이다.
                state.llm["degraded"] = True
                state.llm["degraded_answer"] = payload.get("answer", "")
            else:
                answer = payload.get("answer", "")
                uncertainty = payload.get("uncertainty", "")
                citations = llm_citations
        except (LLMUnavailable, Exception) as exc:  # noqa: BLE001 — 어떤 실패든 fallback
            state.llm = {"used": False, "error": f"{type(exc).__name__}: {exc}"}

    state.answer = answer
    state.uncertainty = uncertainty
    state.validation = validator.validate(answer, citations, sources)
    return state


def answer(question: str, retriever: CorpusRetriever, **kwargs) -> dict[str, Any]:
    """dict 결과가 필요한 호출자(API/스크립트)용 얇은 래퍼."""
    return answer_question(question, retriever, **kwargs).to_dict()
