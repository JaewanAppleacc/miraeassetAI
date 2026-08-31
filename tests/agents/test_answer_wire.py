"""주최측 공식 `GET /answer` 계약 — 문자열 5개.

팀 평가 하니스가 이 형식으로 블랙박스 호출한다. 우리 파이프라인은 그대로 두고
포맷만 바꾼 것이므로, 여기서 검증할 것은 "계약을 지키는가"와
"없는 값을 지어내지 않는가" 두 가지다.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from dart_corpus.retrieval.conditions import QueryConditions
from dart_detective import answer_wire, qa_service
from dart_detective.agents import qa_agent
from dart_detective.corpus_retriever import RetrievedChunk

WIRE_FIELDS = {"question_id", "question", "retrieved_context", "think_trace", "answer"}


def state_of(**over):
    base = {
        "answer": "계약금액은 1,195,242,120,000원이다.",
        "evidence": [{"chunk_id": "c1", "text": "계약금액(원) | 1,195,242,120,000",
                      "section_path": ["공시", "계약내역"], "doc_id": "exchange_1"}],
        "evidence_matches": [{"slot": "계약금액", "chunk_id": "c1", "doc_id": "exchange_1",
                              "evidence_text": "계약금액(원) | 1,195,242,120,000",
                              "section_path": ["공시", "계약내역"],
                              "confidence": 1.0, "reason": "Retrieval 1위"}],
        "slots": ["계약금액", "answer"],
        "conditions": {"corps": ["한국항공우주"], "years": [2023]},
        "retrieval": [{"chunk_id": "c1"}],
        "derived": [],
        "validation": {"status": "SUPPORTED", "checks": [{"check": "numbers_grounded",
                                                          "passed": True}]},
        "confidence": {"score": 80, "level": "높음", "reasons": []},
        "llm": {"used": False},
        "warnings": [],
        "prompt_version": qa_agent.PROMPT_VERSION,
    }
    base.update(over)
    return base


# ---------- wire 형식 ----------

def test_wire_has_exactly_five_string_fields():
    wire = answer_wire.to_answer_wire("Q-001", "질문", state_of())
    assert set(wire) == WIRE_FIELDS
    assert all(isinstance(v, str) for v in wire.values())


def test_context_and_trace_are_json_encoded_strings():
    wire = answer_wire.to_answer_wire("Q-001", "질문", state_of())
    context = json.loads(wire["retrieved_context"])
    trace = json.loads(wire["think_trace"])
    assert isinstance(context, list) and isinstance(trace, dict)
    assert context[0]["document_id"] == "exchange_1"
    assert context[0]["quoted_text"] == "계약금액(원) | 1,195,242,120,000"


def test_question_id_is_echoed_from_the_request():
    wire = answer_wire.to_answer_wire("question_seed_v07_01", "질문", state_of())
    assert wire["question_id"] == "question_seed_v07_01"


def test_trace_carries_only_the_allowed_sections():
    trace = json.loads(answer_wire.to_answer_wire("Q", "질문", state_of())["think_trace"])
    assert set(trace) == {"execution_mode", "operations", "calculation", "validation"}


def test_trace_never_leaks_the_prompt():
    trace = answer_wire.to_answer_wire("Q", "질문", state_of())["think_trace"]
    assert qa_agent.SYSTEM_PROMPT[:30] not in trace


# ---------- 계산값 ----------

def test_calculation_carries_the_code_computed_value():
    derived = [{"metric": "계약금액", "kind": "difference",
                "formula": "|a - b|", "value": "43,062,034,728", "unit": "",
                "source_slots": ["계약금액@A", "계약금액@B"],
                "source_values": ["1,195,242,120,000", "1,152,180,085,272"]}]
    trace = json.loads(answer_wire.to_answer_wire(
        "Q", "질문", state_of(derived=derived))["think_trace"])
    assert trace["calculation"]["primary_value"] == "43,062,034,728"
    assert trace["calculation"]["metric"] == "계약금액"


def test_calculation_is_empty_when_nothing_was_computed():
    trace = json.loads(answer_wire.to_answer_wire("Q", "질문", state_of())["think_trace"])
    assert trace["calculation"] == {}


# ---------- answerability ----------

@pytest.mark.parametrize("over,expected", [
    ({}, "SUPPORTED"),
    ({"evidence": [], "evidence_matches": []}, "EVIDENCE_NOT_FOUND"),
    ({"warnings": ["corp_unspecified"]}, "UNKNOWN_COMPANY"),
    ({"validation": {"status": "UNSUPPORTED", "checks": []}}, "EVIDENCE_NOT_FOUND"),
])
def test_answerability_reflects_what_we_actually_know(over, expected):
    trace = json.loads(answer_wire.to_answer_wire(
        "Q", "질문", state_of(**over))["think_trace"])
    assert trace["validation"]["answerability"] == expected


# ---------- HTTP ----------

class FakeRetriever:
    def conditions(self, question):
        return QueryConditions(corps=frozenset({"한국항공우주"}), years=frozenset({2023}))

    def retrieve(self, question, conditions, k=None):
        return [RetrievedChunk(chunk_id="c1", doc_id="exchange_1", score=1.0,
                               section_path=("공시",), row_labels=("계약금액",),
                               evidence_text="계약금액(원) | 1,195,242,120,000",
                               metadata={"corp_name": "한국항공우주"})]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("CLOVA_API_KEY", raising=False)
    app = FastAPI()
    app.include_router(qa_service.router)
    app.dependency_overrides[qa_service.get_retriever] = lambda: FakeRetriever()
    return TestClient(app)


def test_get_answer_returns_the_wire_contract(client):
    r = client.get("/answer", params={"question_id": "Q-001",
                                      "question": "한국항공우주 계약금액은?"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == WIRE_FIELDS
    assert body["question_id"] == "Q-001"
    assert body["question"] == "한국항공우주 계약금액은?"
    json.loads(body["retrieved_context"])
    json.loads(body["think_trace"])


@pytest.mark.parametrize("params", [
    {"question": "질문만 있음"},
    {"question_id": "Q-001"},
    {"question_id": "Q-001", "question": "   "},
    {"question_id": "  ", "question": "질문"},
])
def test_missing_or_blank_parameters_are_rejected(client, params):
    assert client.get("/answer", params=params).status_code in (400, 422)


# ---------- 팀 계약 규격 맞추기 ----------

def state_with_provenance(**over):
    s = state_of(**over)
    s["evidence_matches"][0].update({"node_index": 0, "rcept_no": "20230428800439",
                                     "picked_value": "635,384,978,972"})
    return s


def test_source_locator_follows_the_team_contract():
    wire = answer_wire.to_answer_wire("Q", "질문", state_with_provenance())
    ctx = json.loads(wire["retrieved_context"])
    assert ctx[0]["source_locator"] == "exchange_1/20230428800439.xml#node=0"


def test_source_locator_falls_back_when_provenance_is_missing():
    ctx = json.loads(answer_wire.to_answer_wire(
        "Q", "질문", state_of())["retrieved_context"])
    assert ctx[0]["source_locator"] == "공시/계약내역"


def test_exact_value_span_is_emitted_alongside_the_full_line():
    ctx = json.loads(answer_wire.to_answer_wire(
        "Q", "질문", state_with_provenance())["retrieved_context"])
    quotes = [c["quoted_text"] for c in ctx]
    assert "계약금액(원) | 1,195,242,120,000" in quotes      # 줄 전체
    assert "635,384,978,972" in quotes                        # 값만 (Gold의 evidence_span 형태)


def test_looked_up_values_use_the_gold_field_names():
    calc = json.loads(answer_wire.to_answer_wire(
        "Q", "질문", state_with_provenance())["think_trace"])["calculation"]
    assert calc["result"]["contract_amount"] == 635384978972


def test_values_without_a_gold_field_name_are_not_invented():
    s = state_of()
    s["evidence_matches"][0].update({"slot": "알수없는항목", "picked_value": "123"})
    calc = json.loads(answer_wire.to_answer_wire("Q", "질문", s)["think_trace"])["calculation"]
    assert calc == {}


def test_unconfirmed_values_are_left_out():
    s = state_of()
    s["evidence_matches"][0]["picked_value"] = None
    calc = json.loads(answer_wire.to_answer_wire("Q", "질문", s)["think_trace"])["calculation"]
    assert calc == {}


def test_year_slots_become_metric_year_fields():
    s = state_of()
    s["evidence_matches"][0].update({"slot": "매출액_2025", "picked_value": "61,118,127"})
    calc = json.loads(answer_wire.to_answer_wire("Q", "질문", s)["think_trace"])["calculation"]
    assert calc["result"]["revenue_2025"] == 61118127
    assert "revenue_2025_million_krw" not in calc["result"]      # 표에 단위 표기가 없다


def test_unit_suffixed_name_only_when_the_table_says_the_unit():
    s = state_of()
    s["evidence_matches"][0].update({
        "slot": "매출액_2025", "picked_value": "61,118,127",
        "evidence_text": "매출액 | 61,118,127  (단위: 백만원)"})
    calc = json.loads(answer_wire.to_answer_wire("Q", "질문", s)["think_trace"])["calculation"]
    assert calc["result"]["revenue_2025_million_krw"] == 61118127


def test_derived_values_get_rule_based_names():
    derived = [{"metric": "매출액", "kind": "increase_rate", "formula": "f",
                "value": "3.15", "unit": "%", "source_slots": [], "source_values": []},
               {"metric": "영업이익", "kind": "increase_rate", "formula": "f",
                "value": "46.28", "unit": "%", "source_slots": [], "source_values": []}]
    calc = json.loads(answer_wire.to_answer_wire(
        "Q", "질문", state_of(derived=derived))["think_trace"])["calculation"]
    assert calc["result"]["revenue_change_percent"] == 3.15
    assert calc["result"]["operating_profit_change_percent"] == 46.28


def test_unknown_metric_gets_no_invented_field_name():
    derived = [{"metric": "자기주식수", "kind": "increase_rate", "formula": "f",
                "value": "1.0", "unit": "%", "source_slots": [], "source_values": []}]
    calc = json.loads(answer_wire.to_answer_wire(
        "Q", "질문", state_of(derived=derived))["think_trace"])["calculation"]
    assert not any(k.startswith("자기주식") for k in calc)
    assert "change_percent" not in calc


def test_locator_derives_the_receipt_number_from_the_document_id():
    s = state_of()
    s["evidence_matches"][0].update({"doc_id": "exchange_20230428800439",
                                     "node_index": 0, "rcept_no": ""})
    ctx = json.loads(answer_wire.to_answer_wire("Q", "질문", s)["retrieved_context"])
    assert ctx[0]["source_locator"] == "exchange_20230428800439/20230428800439.xml#node=0"
