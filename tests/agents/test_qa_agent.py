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


# ---------- slot 분해 ----------

def plan(retriever, question):
    return qa_agent.plan_slots(question, retriever.conditions(question))


def test_two_years_produce_one_slot_per_metric_and_year(retriever):
    """비교 질문은 지표 × 연도로 자리가 갈린다 — 한 자리에 두 해를 섞으면 안 된다."""
    got = plan(retriever, "HMM의 2023년과 2025년 매출액을 비교해줘")
    assert got == ("매출액_2023", "매출액_2025")


def test_metric_without_year_keeps_the_metric_alone(retriever):
    assert plan(retriever, "HMM의 영업이익은?") == ("영업이익",)


def test_metric_synonyms_normalize_to_one_slot(retriever):
    """'순이익'과 '당기순이익'은 같은 행 레이블이다 — 자리를 둘로 나누지 않는다."""
    assert plan(retriever, "HMM의 순이익은?") == ("당기순이익",)


def test_inferred_metrics_expand_a_question_without_metric_words(retriever):
    """지표를 이름으로 부르지 않는 질문도 상위어 규칙으로 자리를 만든다."""
    assert plan(retriever, "HMM의 2025년 실적은 어땠나") == ("매출액_2025", "영업이익_2025")


def test_slots_are_deduplicated(retriever):
    got = plan(retriever, "HMM의 2025년 매출과 매출액은?")
    assert got == ("매출액_2025",)


def test_split_slot_separates_metric_and_year():
    assert qa_agent.split_slot("영업이익_2025") == ("영업이익", 2025)
    assert qa_agent.split_slot("answer") == ("answer", None)
    assert qa_agent.split_slot("자기주식_취득") == ("자기주식_취득", None)


def test_each_slot_gets_its_own_chunk_when_possible(retriever):
    """같은 청크로 모든 자리를 채우지 않는다 — 자리마다 근거를 따로 지목한다."""
    state = qa_agent.answer_question("HMM의 2025년 매출액과 영업이익은?", retriever)
    texts = [m.evidence_text for m in state.evidence_matches]
    assert len(texts) == len(set(texts))


# ---------- 연도 × 표 열 매핑 (Phase 8) ----------

def chunk_of(text: str):
    from dart_detective.corpus_retriever import RetrievedChunk
    return RetrievedChunk(chunk_id="c1", doc_id="d1", score=1.0, section_path=(),
                          row_labels=("매출액",), evidence_text=text, metadata={})


COMPARE_TABLE = "\n".join([
    "제 49 기 2025.01.01 부터 2025.12.31 까지",
    "제 48 기 2024.01.01 부터 2024.12.31 까지",
    "제 47 기 2023.01.01 부터 2023.12.31 까지",
    "매출액 | 61,118,127 | 57,236,995 | 59,254,361",
])
OLD_TABLE = "\n".join([
    "제 47 기 2023.01.01 부터 2023.12.31 까지",
    "제 46 기 2022.01.01 부터 2022.12.31 까지",
    "매출액 | 59,254,361 | 51,906,293",
])


def test_period_columns_reads_year_to_column():
    assert qa_agent.period_columns(chunk_of(COMPARE_TABLE)) == {2025: 0, 2024: 1, 2023: 2}


def test_period_columns_reads_pipe_style_header():
    text = "\n".join([
        "구분 | (2025.01.01.~ 2025.12.31) | (2024.01.01.~ 2024.12.31)",
        "매출액 | 61,118,127 | 57,236,995",
    ])
    assert qa_agent.period_columns(chunk_of(text)) == {2025: 0, 2024: 1}


def test_value_at_picks_the_column_value():
    line = "매출액 | 61,118,127 | 57,236,995 | 59,254,361"
    assert qa_agent.value_at(line, 0) == "61,118,127"
    assert qa_agent.value_at(line, 2) == "59,254,361"
    assert qa_agent.value_at(line, 9) is None


def test_year_slot_rejects_table_without_that_year():
    """Q12 회귀 — 2023년 표가 2025 자리에 들어가면 안 된다.
    '2025'라는 글자가 본문에 있어도 표 머리글에 2025 열이 없으면 쓰지 않는다."""
    old = chunk_of(OLD_TABLE + "\n주) 2025년 이후 계획은 별도 공시")
    assert qa_agent.match_evidence(("매출액_2025",), [old]) == []
    got = qa_agent.match_evidence(("매출액_2023",), [old])
    assert got and got[0].evidence_text.startswith("매출액 | 59,254,361")


def test_two_year_slots_map_to_different_columns_of_one_table():
    got = {m.slot: m for m in
           qa_agent.match_evidence(("매출액_2025", "매출액_2023"), [chunk_of(COMPARE_TABLE)])}
    assert set(got) == {"매출액_2025", "매출액_2023"}
    assert "61,118,127" in got["매출액_2025"].reason      # 선택 값이 이유에 남는다
    assert "59,254,361" in got["매출액_2023"].reason
    assert got["매출액_2025"].evidence_text == got["매출액_2023"].evidence_text  # 같은 행


def test_correct_year_table_beats_wrong_year_table():
    """두 표가 경쟁하면 요청 연도 열을 가진 표가 이긴다(순위가 낮아도)."""
    got = qa_agent.match_evidence(("매출액_2025",),
                                  [chunk_of(OLD_TABLE), chunk_of(COMPARE_TABLE)])
    assert got and got[0].evidence_text.startswith("매출액 | 61,118,127")


def test_slot_without_matching_evidence_is_left_empty(retriever):
    """근거가 없는 자리는 비운다 — 아무 청크나 끌어다 채우지 않는다."""
    matches = qa_agent.match_evidence(("부채총계_2025",),
                                      retriever.retrieve("HMM의 2025년 매출액은?"))
    assert matches == []


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
                                  "row_label", "evidence_text", "metadata",
                                  "node_index"}


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


def test_llm_receives_whole_chunks_not_only_the_picked_lines(retriever):
    """slot 줄만 넘기면 문맥이 좁다 — 25문항 실측에서 gold 근거 140건 중 9건만 전달됐다.
    근거 선택(출처 추적)과 별개로 상위 청크를 통째로 발췌로 준다."""
    llm = FakeLLM()
    state = qa_agent.answer_question(QUESTION, retriever, llm=llm)
    _, user = llm.calls[0]
    assert "제 51 기" in user, "표 머리글이 빠져 어느 기간인지 알 수 없다"
    assert "매출액_2025" in user, "요구 항목(slot)이 프롬프트에 없다"
    assert state.llm_context_chunk_ids


def test_llm_context_is_recorded_even_without_llm(retriever):
    """키가 없어도 '무엇을 넘겼을 것인가'가 남아야 측정할 수 있다."""
    state = qa_agent.answer_question(QUESTION, retriever)
    assert state.llm_context_chunk_ids
    assert state.to_dict()["llm_context"] == list(state.llm_context_chunk_ids)


def test_llm_context_size_is_capped(retriever):
    state = qa_agent.answer_question(QUESTION, retriever, llm_context_chunks=1)
    assert len(state.llm_context_chunk_ids) == 1


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


def test_llm_answer_without_citations_is_not_adopted(retriever):
    """검수 5차 발견 3: 인용 0개인 LLM 답변은 비수치 서술이라도 채택하지 않는다(v4 §11)."""
    llm = FakeLLM(payload={"answer": "회사는 해운업을 영위한다", "evidence": [],
                           "uncertainty": ""})
    state = qa_agent.answer_question(QUESTION, retriever, llm=llm)
    assert state.llm.get("degraded") is True
    assert state.llm.get("degraded_reason") == "citation_unbound"
    assert "회사는 해운업을 영위한다" not in state.answer


def test_json_fallback_swapped_answer_is_not_adopted(retriever):
    """검수 7차 발견 1(파이프라인): 스왑된 JSON 답변은 period_unbound로 폐기돼야 한다."""
    quote = "매출액 | 10,891,443 | 8,400,969"
    llm = FakeLLM(payload={"answer": "2025년 매출액은 8,400,969이다",   # 2024년(제51기) 열 값
                           "evidence": [{"document_id": "periodic_hmm_2025",
                                         "quote_or_fact": quote}],
                           "uncertainty": ""})
    state = qa_agent.answer_question("HMM의 2025년 매출액은 얼마인가?", retriever, llm=llm)
    assert state.llm.get("degraded") is True
    assert state.llm.get("degraded_reason") == "period_unbound"
    assert "8,400,969이다" not in state.answer
