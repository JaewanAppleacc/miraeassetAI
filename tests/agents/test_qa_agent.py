"""코퍼스 QA Agent 테스트 — 합성 문서, LLM 없음(FakeLLM 주입)."""
from __future__ import annotations

import json

import pytest

from dart_corpus.retrieval import DocumentIndex, IndexedDocument
from dart_corpus.retrieval.corp_dictionary import CorpDictionary
from dart_detective.agents import qa_agent
from dart_detective.corpus_retriever import CorpusRetriever
from dart_detective.llm import LLMResult, LLMUnavailable

UNIVERSE_ROWS = [
    {"corp_name": "HMM", "listed_name": "HMM", "stock_code": "011200"},
    {"corp_name": "삼성SDI", "listed_name": "삼성SDI", "stock_code": "006400"},
]

SUMMARY_TABLE = (
    "구분 | 제 52 기 (2025.12) | 제 51 기 (2024.12)\n"
    "매출액 | 10,891,443 | 8,400,969\n"
    "영업이익 | 1,461,202 | 584,770"
)


def indexed(doc_id, corp, *, text, base_year, subtype="annual"):
    return IndexedDocument(
        doc_id=doc_id, corp_name=corp, corp_code=corp, filer_name=corp,
        doc_group="periodic", doc_subtype=subtype,
        report_nm=f"사업보고서 ({base_year}.12)", rcept_dt=f"{base_year + 1}0318",
        base_year=base_year, base_month=12, is_correction=False, text=text,
    )


def ir_doc(doc_id, *, text, section):
    return {
        "doc_id": doc_id, "doc_group": "periodic",
        "nodes": [{"node_index": 0, "kind": "table",
                   "section_hierarchy": section, "text": text}],
    }


@pytest.fixture
def retriever() -> CorpusRetriever:
    corp_dict = CorpDictionary.from_rows(UNIVERSE_ROWS)
    documents = [
        indexed("periodic_hmm_2025", "HMM", text=SUMMARY_TABLE, base_year=2025),
        indexed("periodic_sdi_2025", "삼성SDI", text=SUMMARY_TABLE, base_year=2025),
    ]
    index = DocumentIndex(documents, corp_dict)
    docs_by_id = {
        "periodic_hmm_2025": ir_doc("periodic_hmm_2025", text=SUMMARY_TABLE,
                                    section=["III. 재무에 관한 사항", "1. 요약재무정보"]),
        "periodic_sdi_2025": ir_doc("periodic_sdi_2025", text=SUMMARY_TABLE,
                                    section=["III. 재무에 관한 사항", "1. 요약재무정보"]),
    }
    return CorpusRetriever(document_index=index, corp_dict=corp_dict,
                           docs_by_id=docs_by_id)


class FakeLLM:
    """주어진 발췌만 그대로 인용하는 착한 모델."""

    provider = "fake"

    def __init__(self, payload=None, raises: Exception | None = None):
        self.payload = payload
        self.raises = raises
        self.calls: list[tuple[str, str]] = []

    def complete_json(self, system, user, schema):
        self.calls.append((system, user))
        if self.raises:
            raise self.raises
        payload = self.payload
        if payload is None:
            quote = user.split("=== 공시 발췌 ===\n", 1)[1].split("\n")[1]
            payload = {"answer": f"근거: {quote}",
                       "evidence": [{"document_id": "periodic_hmm_2025",
                                     "quote_or_fact": quote}],
                       "uncertainty": ""}
        return LLMResult(data=payload, provider=self.provider, model="fake-1",
                         latency_ms=1, raw_text=json.dumps(payload, ensure_ascii=False))


QUESTION = "HMM의 2025년 매출액과 영업이익은?"


# ---------- 1. 질문 이해 ----------

def test_conditions_come_from_the_retrieval_parser(retriever):
    cond = retriever.conditions(QUESTION)
    assert cond.corps == frozenset({"HMM"})
    assert cond.years == frozenset({2025})


def test_slots_are_metric_times_year(retriever):
    cond = retriever.conditions(QUESTION)
    assert qa_agent.plan_slots(QUESTION, cond) == ("매출액_2025", "영업이익_2025")


def test_slot_falls_back_to_single_answer_slot(retriever):
    q = "HMM은 어떤 회사인가"
    assert qa_agent.plan_slots(q, retriever.conditions(q)) == ("answer",)


# ---------- 2. Retrieval 호출 ----------

def test_agent_calls_retrieval_and_keeps_provenance(retriever):
    chunks = retriever.retrieve(QUESTION)
    assert chunks
    top = chunks[0]
    assert top.doc_id == "periodic_hmm_2025"          # 기업 hard filter가 살아 있다
    assert top.chunk_id and top.score > 0
    assert top.section_path == ("III. 재무에 관한 사항", "1. 요약재무정보")
    assert "매출액" in top.row_labels
    assert set(top.to_dict()) == {"chunk_id", "doc_id", "score", "section_path",
                                  "row_label", "evidence_text", "metadata"}


def test_retrieval_metadata_carries_document_fields(retriever):
    meta = retriever.retrieve(QUESTION)[0].metadata
    assert meta["corp_name"] == "HMM"
    assert meta["doc_group"] == "periodic"
    assert meta["base_year"] == 2025


# ---------- 3. Evidence 매칭 ----------

def test_evidence_matches_one_chunk_per_slot(retriever):
    state = qa_agent.answer_question(QUESTION, retriever)
    slots = [m.slot for m in state.evidence_matches]
    assert slots == ["매출액_2025", "영업이익_2025"]
    for m in state.evidence_matches:
        assert m.doc_id == "periodic_hmm_2025"
        assert m.chunk_id
        assert m.reason
        assert 0 < m.confidence <= 1.0


def test_evidence_text_is_the_row_that_holds_the_metric(retriever):
    state = qa_agent.answer_question(QUESTION, retriever)
    by_slot = {m.slot: m.evidence_text for m in state.evidence_matches}
    assert by_slot["매출액_2025"].startswith("매출액 |")
    assert by_slot["영업이익_2025"].startswith("영업이익 |")


def test_no_evidence_means_no_answer_instead_of_a_guess(retriever):
    empty = CorpusRetriever(document_index=retriever.document_index,
                            corp_dict=retriever.corp_dict, docs_by_id={})
    state = qa_agent.answer_question(QUESTION, empty)
    assert state.retrieval_results == []
    assert state.evidence_matches == []
    assert "찾지 못했다" in state.answer
    assert state.to_dict()["evidence"] == []


# ---------- 4. 답변 / 환각 방지 ----------

def test_answer_without_llm_is_grounded(retriever):
    state = qa_agent.answer_question(QUESTION, retriever)
    assert state.llm == {"used": False}
    assert state.validation["status"] in {"SUPPORTED", "PARTIALLY_SUPPORTED"}
    assert "10,891,443" in state.answer


def test_answer_text_never_carries_doc_ids(retriever):
    """doc_id에는 숫자가 들어 있어 본문에 섞으면 Validator가 날조 수치로 잡는다.
    출처는 evidence 구조에만 둔다(실측 회귀: periodic_20260318000826)."""
    state = qa_agent.answer_question(QUESTION, retriever)
    assert "periodic_hmm_2025" not in state.answer
    assert state.validation["status"] != "UNSUPPORTED"
    assert all(m.doc_id for m in state.evidence_matches)


def test_generic_question_returns_several_top_chunks(retriever):
    q = "HMM의 제 52 기 구분 항목을 보여줘"      # 지표를 이름으로 부르지 않는 질문
    state = qa_agent.answer_question(q, retriever)
    assert state.slots == ("answer",)
    assert [m.slot for m in state.evidence_matches] == ["answer"] * len(
        state.evidence_matches)
    assert 1 <= len(state.evidence_matches) <= 3


def test_fake_llm_answer_is_used_when_grounded(retriever):
    llm = FakeLLM()
    state = qa_agent.answer_question(QUESTION, retriever, llm=llm)
    assert llm.calls, "LLM이 호출되지 않았다"
    assert state.llm["used"] is True and state.llm["provider"] == "fake"
    assert state.validation["status"] != "UNSUPPORTED"


def test_hallucinated_numbers_are_rejected_and_fall_back(retriever):
    llm = FakeLLM(payload={
        "answer": "HMM의 2025년 매출액은 99,999,999이다.",
        "evidence": [{"document_id": "periodic_hmm_2025",
                      "quote_or_fact": "매출액 | 99,999,999"}],
        "uncertainty": "",
    })
    state = qa_agent.answer_question(QUESTION, retriever, llm=llm)
    assert state.llm["degraded"] is True
    assert "99,999,999" not in state.answer          # 날조된 수치는 답변에 남지 않는다
    assert state.validation["status"] != "UNSUPPORTED"


def test_llm_failure_falls_back_to_excerpt_answer(retriever):
    state = qa_agent.answer_question(QUESTION, retriever,
                                     llm=FakeLLM(raises=LLMUnavailable("no key")))
    assert state.llm["used"] is False and "LLMUnavailable" in state.llm["error"]
    assert "10,891,443" in state.answer


# ---------- 5. 전체 흐름 ----------

def test_pipeline_result_shape(retriever):
    out = qa_agent.answer(QUESTION, retriever, llm=FakeLLM())
    assert set(out) >= {"answer", "evidence", "evidence_matches", "slots",
                        "conditions", "retrieval", "validation", "llm"}
    for ev in out["evidence"]:
        assert set(ev) == {"chunk_id", "text", "section_path", "doc_id"}
