"""③ 라우팅(v4 §7) — 판정 순서·예산 매트릭스·강등·max_tokens 전달. LLM 호출 없음."""
from __future__ import annotations

import json

import pytest

from dart_corpus.retrieval.conditions import QueryConditions
from dart_detective import answer_wire, routing
from dart_detective.agents import qa_agent
from dart_detective.llm import ClovaLLM, LLMResult


# ---------- 판정 순서 (v4 §7 "판정(순서 고정)") ----------

@pytest.mark.parametrize("question,n_slots,asks_value,expected", [
    # ① 집계어+패밀리어 → COUNT / EXISTENCE / ENUMERATION
    ("삼성전자가 2024년에 낸 유상증자 공시는 몇 건인가?", 1, True, "COUNT"),
    ("현대차가 2023년에 자기주식 취득 공시를 낸 적이 있는가?", 1, False, "EXISTENCE_CHECK"),
    ("SK하이닉스의 2025년 공급계약 공시를 모두 나열해줘", 1, False, "ENUMERATION"),
    ("2024년 유상증자 규모가 가장 큰 공시는 무엇인가?", 1, True, "ENUMERATION"),   # 최상급
    # ② 서술어 → NARRATIVE (값 의문보다 먼저)
    ("삼성전자의 2023년과 2025년 사업보고서 핵심 사업 변화를 설명해줘", 2, False, "NARRATIVE"),
    ("LG전자의 2024년 매출액 규모를 정리해줘", 1, True, "NARRATIVE"),
    # ③ 값 의문 + slot≤2 → DIRECT_LOOKUP
    ("삼성전자의 2024년 매출액은 얼마인가?", 1, True, "DIRECT_LOOKUP"),
    ("HMM의 2024년과 2025년 영업이익은 얼마인가?", 2, True, "DIRECT_LOOKUP"),
    # ③ 값 의문이지만 slot이 3 이상 → 기본 NARRATIVE
    ("삼성전자의 2023·2024·2025년 매출액은 얼마인가?", 3, True, "NARRATIVE"),
    # ④ 기본
    ("삼성전자 사업보고서의 위험요인은?", 1, False, "NARRATIVE"),
])
def test_decision_order(question, n_slots, asks_value, expected):
    strategy, reasons, _ = routing.decide_strategy(
        question, n_slots=n_slots, asks_value=asks_value)
    assert strategy == expected, reasons


def test_calculation_and_comparison_inside_step3():
    s, _, _ = routing.decide_strategy(
        "삼성전자의 2024년 대비 2025년 매출액 증가율은 얼마인가?", n_slots=2, asks_value=True)
    assert s == "CALCULATION"
    s, _, _ = routing.decide_strategy(
        "삼성전자와 SK하이닉스 중 2025년 설비투자가 더 큰 곳은?", n_slots=2, asks_value=False)
    assert s == "COMPARISON"


def test_value_suffix_is_not_narrative():
    """'변화율'은 값 표현이다 — 서술어 '변화'로 오분류하면 안 된다."""
    s, _, _ = routing.decide_strategy(
        "HMM의 2024년 대비 2025년 매출액 변화율은 얼마인가?", n_slots=2, asks_value=True)
    assert s == "CALCULATION"


def test_existence_rule_hit_wins():
    s, reasons, _ = routing.decide_strategy(
        "삼성전자의 2024년 매출액은 얼마인가?", n_slots=1, asks_value=True, existence_hit=True)
    assert s == "EXISTENCE_CHECK" and reasons == ("corpus_existence_rule",)


def test_superlative_enumeration_is_closed():
    _, _, superlative = routing.decide_strategy(
        "2024년 유상증자 규모가 가장 큰 공시는?", n_slots=1, asks_value=True)
    assert superlative is True
    assert routing.answer_type_of("ENUMERATION", superlative=True) == "CLOSED"
    assert routing.answer_type_of("ENUMERATION", superlative=False) == "OPEN_ENDED"


# ---------- 예산 매트릭스 (v4 §7 "실행 매트릭스") ----------

def test_budget_matrix_matches_v4():
    b = routing.BUDGETS
    for s in ("DIRECT_LOOKUP", "COMPARISON", "CALCULATION"):
        assert (b[s].context_chunks, b[s].max_tokens) == (8, 512), s
    assert b["ENUMERATION"].max_tokens == 768
    assert b["COUNT"].max_tokens == 256
    assert b["EXISTENCE_CHECK"].max_tokens == 256 and b["EXISTENCE_CHECK"].llm_calls == 0
    assert (b["NARRATIVE"].context_chunks, b["NARRATIVE"].max_tokens) == (20, 1024)
    assert set(b) == set(routing.STRATEGIES)


def test_answer_types_are_only_closed_or_open_ended():
    assert routing.ANSWER_TYPES == ("CLOSED", "OPEN_ENDED")
    for s in routing.STRATEGIES:
        assert routing.answer_type_of(s) in routing.ANSWER_TYPES


# ---------- 강등 (v4 §7 복구: ledger 미채택 → NARRATIVE + 고지) ----------

@pytest.mark.parametrize("question", [
    "삼성전자가 2024년에 낸 유상증자 공시는 몇 건인가?",            # COUNT
    "SK하이닉스의 2025년 공급계약 공시를 모두 나열해줘",             # ENUMERATION
    "현대차가 2023년에 자기주식 취득 공시를 낸 적이 있는가?",         # EXISTENCE(규칙 미적중)
])
def test_ledger_paths_downgrade_to_narrative_without_ledger(question):
    r = routing.route(question, n_slots=1, asks_value=True)
    assert r.strategy == "NARRATIVE"
    assert r.downgraded_from in ("COUNT", "ENUMERATION", "EXISTENCE_CHECK")
    assert r.budget == routing.BUDGETS["NARRATIVE"]
    assert r.notice == routing.LEDGER_NOTICE
    assert "ledger_unavailable" in r.reasons


def test_ledger_available_keeps_strategy():
    r = routing.route("삼성전자가 2024년에 낸 유상증자 공시는 몇 건인가?",
                      n_slots=1, asks_value=True, ledger_available=True)
    assert r.strategy == "COUNT" and r.downgraded_from is None and r.notice == ""


def test_existence_rule_hit_is_not_downgraded():
    r = routing.route("x", n_slots=1, asks_value=False, existence_hit=True)
    assert r.strategy == "EXISTENCE_CHECK" and r.downgraded_from is None
    assert r.budget.llm_calls == 0


def test_route_to_dict_shape():
    d = routing.route("삼성전자의 2024년 매출액은 얼마인가?", n_slots=1, asks_value=True).to_dict()
    assert set(d) == {"strategy", "answer_type", "budget", "reasons", "downgraded_from", "notice"}
    assert set(d["budget"]) == {"context_chunks", "max_tokens", "llm_calls", "source"}


# ---------- max_tokens가 실제 요청에 실리는가 ----------

def _clova_with_captured_post(monkeypatch):
    llm = ClovaLLM(api_key="test-key")
    captured: dict = {}

    def fake_post(payload):
        captured.update(payload)
        return {"result": {"message": {"content": '{"answer": "x", "evidence": [], "uncertainty": ""}'},
                           "usage": {"promptTokens": 10, "completionTokens": 3}}}
    monkeypatch.setattr(llm, "_post", fake_post)
    return llm, captured


def test_clova_per_call_max_tokens(monkeypatch):
    llm, captured = _clova_with_captured_post(monkeypatch)
    result = llm.complete_json("sys", "user", {"type": "object"}, max_tokens=512)
    assert captured["maxTokens"] == 512
    assert result.usage["max_tokens_requested"] == 512


def test_clova_default_max_tokens_when_not_given(monkeypatch):
    llm, captured = _clova_with_captured_post(monkeypatch)
    result = llm.complete_json("sys", "user", {"type": "object"})
    assert captured["maxTokens"] == 2048
    assert result.usage["max_tokens_requested"] == 2048


class _FakeNoKw:
    """max_tokens를 모르는 옛 시그니처 — 기존 테스트의 가짜 LLM과 같은 모양."""
    provider = "fake"

    def complete_json(self, system, user, schema):
        return LLMResult(data={"answer": "a", "evidence": [], "uncertainty": ""},
                         provider="fake", model="m", latency_ms=1)


class _FakeKw(_FakeNoKw):
    def __init__(self):
        self.seen = None

    def complete_json(self, system, user, schema, *, max_tokens=None):
        self.seen = max_tokens
        return super().complete_json(system, user, schema)


def test_llm_answer_passes_max_tokens_only_when_accepted():
    _, meta = qa_agent._llm_answer(_FakeNoKw(), "u", max_tokens=512)
    assert meta["max_tokens"] is None            # 못 받는 클라이언트 — 인자를 안 넘긴다
    kw = _FakeKw()
    _, meta = qa_agent._llm_answer(kw, "u", max_tokens=512)
    assert kw.seen == 512 and meta["max_tokens"] == 512


# ---------- answer_question에 기록되는가 ----------

class _EmptyRetriever:
    """검색 결과가 없는 최소 retriever. 라우팅·고지 기록만 본다."""
    docs_by_id: dict = {}

    def conditions(self, question):
        return QueryConditions()

    def retrieve(self, question, conditions=None, *, k=None):
        return []


def test_answer_question_records_route_and_notice():
    state = qa_agent.answer_question(
        "SK하이닉스의 2025년 공급계약 공시를 모두 나열해줘", _EmptyRetriever())
    d = state.to_dict()
    assert d["route"]["strategy"] == "NARRATIVE"
    assert d["route"]["downgraded_from"] == "ENUMERATION"
    assert d["route"]["budget"]["max_tokens"] == 1024
    assert routing.LEDGER_NOTICE in state.uncertainty


def test_answer_question_direct_budget_recorded():
    state = qa_agent.answer_question("삼성전자의 2024년 매출액은 얼마인가?", _EmptyRetriever())
    assert state.route.strategy == "DIRECT_LOOKUP"
    assert state.route.budget.context_chunks == 8 and state.route.budget.max_tokens == 512
    assert state.route.notice == "" and routing.LEDGER_NOTICE not in state.uncertainty


# ---------- 공식 5필드 응답(wire)에 실리는가 — 내부 state가 아니라 사용자가 받는 것 ----------

def _route_step(wire: dict) -> dict:
    trace = json.loads(wire["think_trace"])
    return next(op for op in trace["operations"] if op["step"] == "route")


def test_wire_answer_carries_downgrade_notice():
    state = qa_agent.answer_question(
        "SK하이닉스의 2025년 공급계약 공시를 모두 나열해줘", _EmptyRetriever())
    wire = answer_wire.to_answer_wire("Q-1", state.question, state.to_dict())
    assert set(wire) == {"question_id", "question", "retrieved_context", "think_trace", "answer"}
    assert all(isinstance(v, str) for v in wire.values())
    assert routing.LEDGER_NOTICE in wire["answer"]            # 사용자가 읽는 본문에 고지
    step = _route_step(wire)
    assert step["downgraded_from"] == "ENUMERATION"
    assert step["notice"] == routing.LEDGER_NOTICE


def test_wire_answer_has_no_notice_for_direct_lookup():
    state = qa_agent.answer_question("삼성전자의 2024년 매출액은 얼마인가?", _EmptyRetriever())
    wire = answer_wire.to_answer_wire("Q-2", state.question, state.to_dict())
    assert routing.LEDGER_NOTICE not in wire["answer"]
    step = _route_step(wire)
    assert step["strategy"] == "DIRECT_LOOKUP" and step["downgraded_from"] is None
    assert step["notice"] == ""
