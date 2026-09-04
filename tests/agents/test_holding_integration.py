"""대량보유 파서 통합 — 서빙 경로(answer_question→wire)에서의 승격·부분 답변·불변조건.

판 §3-2(감사 가능성)·§3-5(소비한 행만 숨김·보유목적 보존)·§4 필수 테스트의 통합분.
LLM 없음 — 결정론 경로만 본다.
"""
from __future__ import annotations

import json

from test_holding_parser import BASIS_DATE_LINE, HISTORY, QUESTION, SUMMARY

from dart_corpus.retrieval import DocumentIndex, IndexedDocument
from dart_corpus.retrieval.corp_dictionary import CorpDictionary
from dart_detective import answer_wire
from dart_detective.agents import qa_agent
from dart_detective.corpus_retriever import CorpusRetriever

DOC_ID = "holding_20240403000410"
PURPOSE_LINE = "5. 보유목적 | 경영권에 영향을 주기 위한 목적이 아님(단순투자)"
PREV_ROW = ("직전보고서 | 2023년 06월 02일 | MassachusettsFinancialServicesCompany | 1 | "
            "2,925,317 | 5.00 | 2,925,317 | 5.00 | 58,492,759")


def holding_retriever(*, with_prev: bool = True) -> CorpusRetriever:
    history = HISTORY if with_prev else "\n".join(
        l for l in HISTORY.split("\n") if not l.startswith("직전보고서"))
    nodes = [
        {"node_index": 0, "kind": "table", "section_hierarchy": ["표지"],
         "text": BASIS_DATE_LINE},
        {"node_index": 5, "kind": "table", "section_hierarchy": ["3. 보유목적"],
         "text": PURPOSE_LINE},
        {"node_index": 28, "kind": "table", "section_hierarchy": ["대량보유자에 관한 사항"],
         "text": history},
    ]
    if with_prev:
        nodes.insert(1, {"node_index": 1, "kind": "table",
                         "section_hierarchy": ["보유주식등의 수 및 보유비율"],
                         "text": SUMMARY})
    corp_dict = CorpDictionary.from_rows(
        [{"corp_name": "아모레퍼시픽", "listed_name": "아모레퍼시픽", "stock_code": "090430"}])
    doc = IndexedDocument(
        doc_id=DOC_ID, corp_name="아모레퍼시픽", corp_code="090430",
        filer_name="Massachusetts Financial Services Company",
        doc_group="holding", doc_subtype="일반",
        report_nm="주식등의대량보유상황보고서(일반)", rcept_dt="20240403",
        base_year=2024, base_month=3, is_correction=False,
        text="\n".join(n["text"] for n in nodes))
    return CorpusRetriever(
        document_index=DocumentIndex([doc], corp_dict), corp_dict=corp_dict,
        docs_by_id={DOC_ID: {"doc_id": DOC_ID, "doc_group": "holding", "nodes": nodes}})


# ---------- 완전 쌍: 값·증감·근거 승격 ----------

def test_answer_carries_pair_values_and_change():
    state = qa_agent.answer_question(QUESTION, holding_retriever())
    assert [d.kind for d in state.derived].count("holding_change") == 2
    for value in ("2,925,317", "5.00", "2,263,085", "3.87", "662,232", "-1.13"):
        assert value in state.answer
    # 소비한 원문 행은 덤프로 다시 나가지 않는다 — 값은 위 문장이 이미 담았다.
    assert PREV_ROW not in state.answer
    assert state.validation["status"] != "UNSUPPORTED"
    assert state.fallback_stage == ""


def test_wire_retrieved_context_contains_promoted_rows():
    """§3-2 잠금: 승격된 행(원문 byte 그대로)과 선택 값이 wire 근거에 실린다."""
    state = qa_agent.answer_question(QUESTION, holding_retriever())
    wire = answer_wire.to_answer_wire("qid", QUESTION, state.to_dict())
    quoted = [e.get("quoted_text") for e in json.loads(wire["retrieved_context"])]
    assert PREV_ROW in quoted                       # 행 원문 그대로
    assert "2,925,317" in quoted                    # 값 항목(picked_value)
    slots = {e.get("slot_name") for e in json.loads(wire["retrieved_context"])}
    assert "직전 보고서 보유주식등의 수" in slots


def test_non_consumed_selected_rows_survive_exclusion_in_pipeline():
    """§3-5 통합 잠금: 서빙 경로에서 제외는 파서가 소비한 행만 숨긴다.

    보유목적 줄이 기본 선발 예산(MAX_EVIDENCE·문서당 4줄)에서 표 행에 밀리는 것은
    파서 이전부터의 선발 동작이라 이 판의 범위 밖(§6) — 여기서는 소비 안 된 선발 근거
    (기준일 행)가 답변에 그대로 남는 것을 잠근다. 보유목적 자체는 아래 메커니즘 테스트."""
    state = qa_agent.answer_question(QUESTION, holding_retriever())
    assert BASIS_DATE_LINE in state.answer          # 소비 안 된 근거는 유지
    assert PREV_ROW not in state.answer             # 소비한 행만 숨김
    assert "662,232" in state.answer


def test_exclusion_hides_only_consumed_rows_mechanism():
    """§3-5 메커니즘 단위 잠금: exclude_texts에 없는 행은 절대 숨기지 않는다."""
    consumed_row = "보유주식등의 수 및 보유비율 | 직전 보고서 | 2,925,317 | 5.00"
    matches = [
        qa_agent.EvidenceMatch(slot="answer", chunk_id="c1", doc_id=DOC_ID,
                               evidence_text=consumed_row, section_path=(),
                               confidence=1.0, reason="t"),
        qa_agent.EvidenceMatch(slot="answer", chunk_id="c2", doc_id=DOC_ID,
                               evidence_text=PURPOSE_LINE, section_path=(),
                               confidence=0.9, reason="t"),
    ]
    answer, _ = qa_agent.fallback_answer(
        matches, exclude_texts=frozenset({"".join(consumed_row.split())}))
    assert PURPOSE_LINE in answer
    assert consumed_row not in answer


# ---------- 부분 쌍: 직전 없음 → 부분 답변 ----------

def test_partial_pair_states_missing_slots_without_fabrication():
    state = qa_agent.answer_question(QUESTION, holding_retriever(with_prev=False))
    assert "2,263,085" in state.answer and "3.87" in state.answer
    assert "확인하지 못했다" in state.answer
    assert "직전 보고서 보유주식등의 수" in state.answer
    assert not any(d.kind == "holding_change" for d in state.derived)
    assert "2,925,317" not in state.answer          # 없는 직전 값을 만들어내지 않는다
