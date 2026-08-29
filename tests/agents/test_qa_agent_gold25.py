"""Gold 25 일부로 도는 end-to-end smoke.

실제 코퍼스 인덱스(experiments/gold25_retrieval/, .gitignore)가 있어야 돌아간다.
없으면 skip한다 — CI에서 실패하지 않되, 로컬에서는 질문 -> Retrieval -> 근거 -> 답변이
한 번에 도는지 확인한다. LLM은 쓰지 않는다(결정론적 경로).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from dart_corpus.evaluation.gold25 import load_gold_questions
from dart_detective.agents import qa_agent
from dart_detective.corpus_retriever import CorpusRetriever

REPO = Path(__file__).resolve().parents[2]
EXP = REPO / "experiments" / "gold25_retrieval"
DOC_INDEX = EXP / "doc_index.jsonl"
EVIDENCE_DOCS = EXP / "evidence_documents.jsonl"
GOLD = REPO / "data" / "eval" / "gold25.jsonl"
UNIVERSE = sorted((REPO / "data").rglob("universe.csv"))

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not (DOC_INDEX.exists() and EVIDENCE_DOCS.exists() and UNIVERSE),
                       reason="코퍼스 인덱스가 없다(experiments/gold25_retrieval/)"),
]

SMOKE_QIDS = ("Q09", "Q14")


@pytest.fixture(scope="module")
def retriever() -> CorpusRetriever:
    return CorpusRetriever.from_paths(DOC_INDEX, EVIDENCE_DOCS, UNIVERSE[0])


@pytest.mark.parametrize("qid", SMOKE_QIDS)
def test_gold_question_runs_end_to_end(retriever, qid):
    question = {q.qid: q for q in load_gold_questions(GOLD)}[qid].question
    state = qa_agent.answer_question(question, retriever)

    assert state.conditions is not None and state.slots
    assert state.retrieval_results, "Retrieval이 후보를 하나도 못 냈다"
    assert state.evidence_matches, "근거를 하나도 못 골랐다"
    assert state.answer
    assert state.validation["status"] != "UNSUPPORTED"
    for match in state.evidence_matches:
        source = next(c for c in state.retrieval_results
                      if c.chunk_id == match.chunk_id)
        assert match.evidence_text in source.evidence_text   # 근거는 원문 그대로다
        assert match.doc_id == source.doc_id
