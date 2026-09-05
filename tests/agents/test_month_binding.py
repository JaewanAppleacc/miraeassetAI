"""B안 최소 범위 — 월 단위 서식 항목 질문의 대상 문서 결박 + 얇은 결정론 렌더러.

gold25 Q01 실측: "HMM이 2023년 4월 GS칼텍스와 체결한 공급계약"은 '일'이 없어 결박이 없었고,
같은 회사의 10월 계약(1,282,363,356,560원) 행이 발췌에 섞여 나갔다. 여기서는 그 문형을
합성 문서 2건(4월 정답·10월 다른 계약)으로 잠근다. 질문별 정답 하드코딩 없음 — 값은 전부
문서 행에서 온다.
"""
from __future__ import annotations

import json

import pytest

from dart_corpus.retrieval import DocumentIndex, IndexedDocument
from dart_corpus.retrieval.corp_dictionary import CorpDictionary
from dart_detective import answer_wire
from dart_detective.agents import qa_agent
from dart_detective.corpus_retriever import CorpusRetriever

Q01 = "HMM이 2023년 4월 GS칼텍스와 체결한 공급계약의 계약금액과 계약기간은 얼마인가?"
APRIL = ("2. 계약내역 | 계약금액(원) | 635,384,978,972 | 635,384,978,972\n"
         "3. 계약상대 | 3. 계약상대 | GS CALTEX | GS CALTEX\n"
         "5. 계약기간 | 시작일 | 2023-04-28 | 2023-04-28\n"
         "5. 계약기간 | 종료일 | 2032-10-31 | 2032-10-31")
OCTOBER = ("2. 계약내역 | 계약금액(원) | 1,282,363,356,560 | 1,282,363,356,560\n"
           "3. 계약상대 | 3. 계약상대 | 다른선주 | 다른선주\n"
           "5. 계약기간 | 시작일 | 2026-09-01 | 2026-09-01\n"
           "5. 계약기간 | 종료일 | 2042-12-31 | 2042-12-31")
WRONG_VALUES = ("1,282,363,356,560", "2026-09-01", "2042-12-31")


def _retriever(docs: dict[str, tuple[str, str]]) -> CorpusRetriever:
    corp_dict = CorpDictionary.from_rows(
        [{"corp_name": "HMM", "listed_name": "HMM", "stock_code": "011200"}])
    indexed = [IndexedDocument(
        doc_id=d, corp_name="HMM", corp_code="HMM", filer_name="HMM",
        doc_group="exchange", doc_subtype="단일판매ㆍ공급계약체결",
        report_nm="단일판매ㆍ공급계약체결", rcept_dt=dt, base_year=int(dt[:4]),
        base_month=int(dt[4:6]), is_correction=False, text=t) for d, (dt, t) in docs.items()]
    return CorpusRetriever(document_index=DocumentIndex(indexed, corp_dict), corp_dict=corp_dict,
                           docs_by_id={d: {"doc_id": d, "doc_group": "exchange",
                                           "nodes": [{"node_index": 0, "section_hierarchy": [],
                                                      "text": t}]}
                                       for d, (dt, t) in docs.items()})


def q01_retriever() -> CorpusRetriever:
    return _retriever({"exchange_20230428800439": ("20230428", APRIL),
                       "exchange_20231027800429": ("20231027", OCTOBER)})


class BoomLLM:
    provider = "fake"

    def complete_json(self, system, user, schema):  # pragma: no cover
        raise AssertionError("확정 슬롯 질문에서 LLM이 호출되면 안 된다")


class CrashLLM:
    provider = "fake"

    def complete_json(self, system, user, schema):
        raise RuntimeError("HCX down")


# ---------- 월 창 파서 ----------

def test_month_only_question_yields_month_and_exact_date_wins():
    assert qa_agent.question_months_any(Q01) == [(2023, 4)]
    assert qa_agent.question_months_any("HMM의 2023년 4월 28일 공시") == []      # 정확 일자 우선
    assert qa_agent.question_months_any("2023.09.30 누적 매출") == []           # 완전한 날짜
    assert "20230401" in qa_agent._question_month_window(Q01) and "20230430" in qa_agent._question_month_window(Q01)
    assert "20230501" not in qa_agent._question_month_window(Q01)


# ---------- Q01: 결박 → 렌더링 ----------

def test_q01_binds_april_document_and_renders_sentence():
    state = qa_agent.answer_question(Q01, q01_retriever(), llm=BoomLLM())
    for v in ("635,384,978,972", "2023-04-28", "2032-10-31"):
        assert v in state.answer
    for v in WRONG_VALUES:
        assert v not in state.answer
    assert "계약기간은 2023년 4월 28일부터 2032년 10월 31일까지" in state.answer
    assert "계약금액은 635,384,978,972원" in state.answer
    assert {m.doc_id for m in state.evidence_matches} == {"exchange_20230428800439"}
    assert state.binding.get("month_item_binding") is True
    assert state.binding.get("resolved_doc_id") == "exchange_20230428800439"
    assert state.binding.get("deterministic_render") is True
    assert (state.llm or {}).get("skipped") == "items_all_slots_filled"
    assert state.validation["status"] == "SUPPORTED"


def test_q01_wire_context_and_trace_use_only_bound_document():
    state = qa_agent.answer_question(Q01, q01_retriever(), llm=None)
    wire = answer_wire.to_answer_wire("Q01", Q01, state.to_dict())
    ctx = json.loads(wire["retrieved_context"])
    assert {row["document_id"] for row in ctx} == {"exchange_20230428800439"}
    for v in WRONG_VALUES:
        assert v not in wire["retrieved_context"] and v not in wire["answer"]
    trace = json.loads(wire["think_trace"])
    binding = next(op for op in trace["operations"] if op["step"] == "binding")
    assert binding["month_item_binding"] is True
    assert binding["resolved_doc_id"] == "exchange_20230428800439"
    assert binding["deterministic_render"] is True


def test_q01_deterministic_answer_identical_across_llm_states():
    a = qa_agent.answer_question(Q01, q01_retriever(), llm=None).answer
    b = qa_agent.answer_question(Q01, q01_retriever(), llm=BoomLLM()).answer
    c = qa_agent.answer_question(Q01, q01_retriever(), llm=CrashLLM()).answer
    assert a == b == c


# ---------- 같은 달 후보 2건: 임의 결박 금지 ----------

def test_two_candidates_in_same_month_fail_closed_to_separated_answer():
    r = _retriever({"exchange_20230410800001": ("20230410", OCTOBER.replace("다른선주", "GS CALTEX")),
                    "exchange_20230428800439": ("20230428", APRIL)})
    state = qa_agent.answer_question(Q01, r, llm=BoomLLM())      # LLM으로 하나를 고르지 않는다
    assert (state.llm or {}).get("skipped") == "items_ambiguous_docs"
    assert "질문이 가리키는 달에" in state.answer
    assert state.answer.count("[후보 공시") == 2
    assert state.binding.get("resolved_doc_id") is None


# ---------- 기존 경로 무변경 ----------

def test_exact_date_question_does_not_use_month_binding():
    q = "HMM이 2023-04-28 GS칼텍스와 체결한 공급계약의 계약금액과 계약기간은 얼마인가?"
    state = qa_agent.answer_question(q, q01_retriever(), llm=BoomLLM())
    assert "month_item_binding" not in state.binding
    assert state.binding.get("resolved_doc_id") == "exchange_20230428800439"
    assert "635,384,978,972" in state.answer


def test_month_binding_only_for_form_item_questions():
    """서식 항목이 없는 월 질문은 기존 경로 그대로(결박·렌더링 미발동)."""
    state = qa_agent.answer_question("HMM의 2023년 4월 실적 흐름을 설명해줘", q01_retriever(), llm=None)
    assert not state.binding


# ---------- 렌더러 ----------

@pytest.mark.parametrize("item,line,value,expected", [
    ("매출액대비", "2. 계약내역 | 매출액대비(%) | 5.8", "5.8", "매출액대비는 5.8%"),
    ("계약상대", "3. 계약상대 | 3. 계약상대 | 아시아 지역 선주", "아시아 지역 선주", "계약상대는 아시아 지역 선주"),
    ("처분예정금액", "2. 처분예정금액(원) | 175,380,660,000", "175,380,660,000", "처분예정금액은 175,380,660,000원"),
])
def test_renderer_reads_unit_from_label_and_uses_topic_particle(item, line, value, expected):
    assert expected in qa_agent.render_item_sentence((item,), {item: (value, line)})
