"""요구 슬롯 미충족 시 1회 확장 재검색 — judge15 개선 1의 경계.

- 첫 폭에서 슬롯이 비고 넓힌 폭에 근거가 있으면: 확장 결과를 채택한다.
- 확장해도 나아지지 않으면: 원래 결과를 유지한다(폭만 넓힌 잡음 채택 금지).
- 호출자가 k를 고정했으면: 확장하지 않는다(실험 재현성 — 러너가 폭을 통제한다).
"""
from __future__ import annotations

import pytest

from dart_detective.agents import qa_agent
from dart_detective.corpus_retriever import RetrievedChunk


@pytest.fixture(autouse=True)
def _enable_expanded_retrieval(monkeypatch):
    """확장 재검색은 **원문 보충과 별도의** 스위치 뒤에 있다(기본 OFF — 재검수 3차 MEDIUM 4:
    측정된 보충 승인에 미측정 k=40 확장이 끼워 켜지지 않도록 플래그 분리)."""
    monkeypatch.setenv("DART_QA_EXPANDED_RETRIEVAL", "1")


def test_expanded_retrieval_is_off_by_default(monkeypatch):
    """스위치 없이는 확장 재검색이 발동하지 않는다 — 별도 실측·승인 전 기본값."""
    monkeypatch.delenv("DART_QA_EXPANDED_RETRIEVAL", raising=False)
    monkeypatch.delenv("DART_QA_LATE_EXPANSION", raising=False)
    r = StubRetriever(narrow=NOISE, wide=NOISE + [_chunk("hit", VALUE_LINE)])
    _ask(r)
    assert r.calls == [None]


def test_late_expansion_flag_alone_does_not_enable_k40(monkeypatch):
    """보충 플래그(DART_QA_LATE_EXPANSION)만으로는 k=40 재검색이 켜지지 않는다."""
    monkeypatch.delenv("DART_QA_EXPANDED_RETRIEVAL", raising=False)
    monkeypatch.setenv("DART_QA_LATE_EXPANSION", "1")
    r = StubRetriever(narrow=NOISE, wide=NOISE + [_chunk("hit", VALUE_LINE)])
    _ask(r)
    assert r.calls == [None]


def _chunk(cid, text, doc="exchange_20240101800001"):
    return RetrievedChunk(chunk_id=cid, doc_id=doc, score=1.0, section_path=(),
                          row_labels=(), evidence_text=text,
                          metadata={"rcept_no": "20240101800001"}, node_index=0)


class StubRetriever:
    """conditions/retrieve만 있으면 answer_question이 돈다(존재규칙·scope 미발동 질문 기준)."""

    def __init__(self, narrow, wide):
        self.narrow, self.wide = narrow, wide
        self.calls = []

    def conditions(self, question):
        from dart_corpus.retrieval.conditions import extract_conditions
        from dart_corpus.retrieval.corp_dictionary import CorpDictionary
        return extract_conditions(question, CorpDictionary.from_rows(
            [{"corp_name": "한화오션", "listed_name": "한화오션", "stock_code": "042660"}]))

    def retrieve(self, question, conditions=None, k=None):
        self.calls.append(k)
        return list(self.wide) if (k or 0) >= qa_agent.EXPANDED_RETRIEVE_K else list(self.narrow)


VALUE_LINE = "2. 계약내역 | 계약금액(원) | 635,384,978,972"
NOISE = [_chunk(f"n{i}", f"기타 안내문 {i}") for i in range(3)]


def _ask(retriever, **kw):
    return qa_agent.answer_question("한화오션의 2024년 계약금액은 얼마인가?", retriever, **kw)


def test_expands_once_when_slot_missing_and_wide_has_it():
    r = StubRetriever(narrow=NOISE, wide=NOISE + [_chunk("hit", VALUE_LINE)])
    state = _ask(r)
    assert r.calls[0] is None and qa_agent.EXPANDED_RETRIEVE_K in r.calls  # 확장 1회
    assert state.timings.get("expanded_retrieval") == 1
    assert any("635,384,978,972" in m.evidence_text for m in state.evidence_matches)


def test_keeps_original_when_expansion_does_not_help():
    r = StubRetriever(narrow=NOISE, wide=NOISE + [_chunk("junk", "여전히 무관한 줄")])
    state = _ask(r)
    assert qa_agent.EXPANDED_RETRIEVE_K in r.calls          # 시도는 하되
    assert state.timings.get("expanded_retrieval") is None  # 채택은 안 함
    assert len(state.retrieval_results) == len(NOISE)


def test_no_expansion_when_caller_fixed_k():
    r = StubRetriever(narrow=NOISE, wide=NOISE + [_chunk("hit", VALUE_LINE)])
    _ask(r, k=3)
    assert r.calls == [3]                                   # k 고정 시 확장 금지


def test_no_expansion_when_slots_already_filled():
    r = StubRetriever(narrow=NOISE + [_chunk("hit", VALUE_LINE)], wide=[])
    _ask(r)
    assert r.calls == [None]                                # 채워졌으면 재검색 없음
