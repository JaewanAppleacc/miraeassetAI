"""⑧ Native FC 경로 — complete_tool 파싱·claim 게이트·조립·qa_agent 통합. HCX 호출 없음."""
from __future__ import annotations

import json

import pytest

from dart_detective import grounded_answer as ga
from dart_detective.llm import ClovaLLM, LLMUnavailable

DOC = "periodic_20260318000001"
DOC_META = {DOC: {"report_nm": "사업보고서 (2025.12)", "rcept_dt": "20260318", "base_year": 2025,
                  "doc_group": "periodic"}}
SOURCES = [{"document_id": DOC, "text": "구분 | 제 52 기 (2025.12)\n매출액 | 10,891,443\n영업이익 | 1,461,202"}]


def _claim(**over):
    base = {"text": "2025년 매출액은 10,891,443백만원이다", "value": "10,891,443", "unit": "백만원",
            "period": "2025", "period_kind": "FY", "doc_id": DOC, "quote": "매출액 | 10,891,443"}
    base.update(over)
    return base


# ---------- complete_tool (가짜 _post) ----------

def _clova(monkeypatch, message, captured=None):
    llm = ClovaLLM(api_key="k")
    def fake_post(payload):
        if captured is not None:
            captured.update(payload)
        return {"result": {"message": message, "usage": {"promptTokens": 5, "completionTokens": 2}}}
    monkeypatch.setattr(llm, "_post", fake_post)
    return llm


def test_complete_tool_sends_tool_choice_and_parses_dict_arguments(monkeypatch):
    captured = {}
    args = {"claims": [_claim()], "not_found_slots": [], "uncertainty": ""}
    llm = _clova(monkeypatch, {"toolCalls": [{"type": "function",
                                              "function": {"name": "submit_grounded_answer",
                                                           "arguments": args}}]}, captured)
    r = llm.complete_tool("sys", "user", ga.SUBMIT_GROUNDED_ANSWER, max_tokens=512)
    assert captured["toolChoice"]["function"]["name"] == "submit_grounded_answer"
    assert captured["tools"][0]["function"]["name"] == "submit_grounded_answer"
    # 실측 40001: tools와 출력 길이 파라미터는 함께 못 보낸다 — payload에 없어야 한다
    assert "maxTokens" not in captured and "maxCompletionTokens" not in captured
    assert "seed" in captured and "temperature" in captured
    assert r.usage["max_tokens_requested"] == 512          # 기록은 남긴다(관측용)
    assert r.data["claims"][0]["doc_id"] == DOC


def test_complete_tool_parses_string_arguments_and_flags_contract_failure(monkeypatch):
    args = json.dumps({"claims": [], "not_found_slots": ["매출액"], "uncertainty": "x"}, ensure_ascii=False)
    llm = _clova(monkeypatch, {"toolCalls": [{"type": "function",
                                              "function": {"name": "submit_grounded_answer",
                                                           "arguments": args}}]})
    r = llm.complete_tool("s", "u", ga.SUBMIT_GROUNDED_ANSWER)
    assert r.data["not_found_slots"] == ["매출액"]
    assert "fc_contract_failure" not in r.usage
    # toolCalls 없음 + content에 JSON → 복구 + 계약 실패 표시
    llm2 = _clova(monkeypatch, {"content": '{"claims": [], "not_found_slots": [], "uncertainty": ""}'})
    r2 = llm2.complete_tool("s", "u", ga.SUBMIT_GROUNDED_ANSWER)
    assert r2.usage["fc_contract_failure"] is True and r2.data["claims"] == []
    # 둘 다 없음 → 예외 (폴백 경로로)
    llm3 = _clova(monkeypatch, {})
    with pytest.raises(LLMUnavailable):
        llm3.complete_tool("s", "u", ga.SUBMIT_GROUNDED_ANSWER)


def test_enabled_requires_complete_tool_and_env(monkeypatch):
    class NoTool:
        def complete_json(self, *a, **k): ...
    assert ga.enabled(NoTool()) is False
    llm = _clova(monkeypatch, {})
    assert ga.enabled(llm) is True
    monkeypatch.setenv("DART_QA_FC", "off")
    assert ga.enabled(llm) is False


# ---------- claim 게이트 ----------

def _validate(claim, derived=()):
    squashed = {DOC: ga._squash(SOURCES[0]["text"])}
    return ga.validate_claim(claim, squashed, DOC_META, set(derived))


def test_claim_passes_when_fully_grounded():
    ok, fails = _validate(_claim())
    assert ok, fails


@pytest.mark.parametrize("claim,code", [
    (_claim(doc_id="periodic_x"), "citation_bound"),                      # 실사용 근거 밖 문서
    (_claim(quote="매출액 | 99,999"), "quote_grounded"),                   # 원문에 없는 인용
    (_claim(text="매출액은 12,345백만원이다", value="12,345"), "numbers_bound"),  # 지어낸 숫자
    (_claim(value="1,461,202", quote="매출액 | 10,891,443"), "numbers_bound"),   # 다른 행 값 귀속
    (_claim(period="2019"), "period_bound"),                              # 근거 없는 연도
])
def test_claim_gates_catch_each_violation(claim, code):
    ok, fails = _validate(claim)
    assert not ok and any(f.startswith(code) for f in fails), fails


def test_claim_unit_outside_quote_is_not_dropped():
    """표 밖 단위("단위: 백만원")가 인용에 없어도 claim은 살아야 한다 — 자릿수는 최종 validator 몫."""
    ok, fails = _validate(_claim(unit="백만원"))
    assert ok, fails


def test_claim_allows_numbers_from_question():
    """질문의 날짜·기수를 문장에서 반복하는 것은 날조가 아니다(실측 오탐 교정). 값은 예외 없음."""
    c = _claim(text="보고서작성기준일 2024년 03월 22일 기준 매출액은 10,891,443이다", unit=None)
    ok, fails = _validate(c)
    assert not ok and any(f.startswith("numbers_bound") for f in fails)
    squashed = {DOC: ga._squash(SOURCES[0]["text"])}
    ok, fails = ga.validate_claim(c, squashed, DOC_META, set(),
                                  question_numbers=set(ga.numbers_in("보고서작성기준일 2024년 03월 22일")))
    assert ok, fails
    bad_value = _claim(value="03")                          # 값 자체는 질문 허용 없음
    ok, fails = ga.validate_claim(bad_value, squashed, DOC_META, set(), question_numbers={"03"})
    assert not ok and any("value" in f for f in fails)


def test_claim_allows_derived_numbers():
    c = _claim(text="증가율은 29.64%였다", value="29.64", unit=None, quote="매출액 | 10,891,443")
    ok, fails = _validate(c, derived={"29.64"})
    assert ok, fails


# ---------- 조립 ----------

def test_compose_inlines_attribution_and_returns_number_tokens():
    answer, extra = ga.compose([_claim()], ["영업이익률"], "", DOC_META)
    assert "사업보고서 (2025.12)" in answer and "접수번호 20260318000001" in answer
    assert "2026-03-18" in answer
    assert "영업이익률" in answer and "확인하지 못했다" in answer
    # numbers_in 토큰 단위로 허용 목록에 들어간다(날짜는 2026/03/18로 쪼개짐)
    assert {"20260318000001", "2026", "03", "18"} <= extra


def test_fc_answer_end_to_end_drops_bad_claims(monkeypatch):
    good, bad = _claim(), _claim(text="영업이익은 9,999,999백만원이다", value="9,999,999",
                                 quote="영업이익 | 1,461,202")
    llm = _clova(monkeypatch, {"toolCalls": [{"type": "function", "function": {
        "name": "submit_grounded_answer",
        "arguments": {"claims": [good, bad], "not_found_slots": [], "uncertainty": "u"}}}]})
    payload, meta, extra = ga.fc_answer(llm, "prompt", sources=SOURCES, doc_meta=DOC_META,
                                        derived_allowed=[], max_tokens=512)
    assert meta["claims"]["total"] == 2 and meta["claims"]["kept"] == 1
    assert meta["prompt_version"] == ga.FC_PROMPT_VERSION
    assert "10,891,443" in payload["answer"] and "9,999,999" not in payload["answer"]
    assert payload["evidence"] == [{"document_id": DOC, "quote_or_fact": "매출액 | 10,891,443"}]
    assert "20260318000001" in extra


def test_fc_fingerprint_is_stable():
    assert ga.fc_fingerprint() == ga.fc_fingerprint() and len(ga.fc_fingerprint()) == 12


# ---------- qa_agent 통합: FC 경로가 최종 검증까지 통과하는가 ----------

def test_qa_agent_fc_path_survives_final_validator(monkeypatch):
    from dart_corpus.retrieval import DocumentIndex, IndexedDocument
    from dart_corpus.retrieval.corp_dictionary import CorpDictionary
    from dart_detective.corpus_retriever import CorpusRetriever
    from dart_detective.agents import qa_agent

    table = "구분 | 제 52 기 (2025.12)\n매출액 | 10,891,443\n영업이익 | 1,461,202"
    corp = CorpDictionary.from_rows([{"corp_name": "HMM", "listed_name": "HMM", "stock_code": "011200"}])
    doc = IndexedDocument(doc_id=DOC, corp_name="HMM", corp_code="HMM", filer_name="HMM",
                          doc_group="periodic", doc_subtype="annual",
                          report_nm="사업보고서 (2025.12)", rcept_dt="20260318",
                          base_year=2025, base_month=12, is_correction=False, text=table)
    retriever = CorpusRetriever(
        document_index=DocumentIndex([doc], corp), corp_dict=corp,
        docs_by_id={DOC: {"doc_id": DOC, "doc_group": "periodic",
                          "nodes": [{"node_index": 0, "kind": "table",
                                     "section_hierarchy": ["재무"], "text": table}]}})

    class FCLLM:
        provider = "fake-fc"
        def complete_tool(self, system, user, tool, *, max_tokens=None):
            from dart_detective.llm import LLMResult
            claim = {"text": "2025년 매출액은 10,891,443이다", "value": "10,891,443", "unit": None,
                     "period": "2025", "period_kind": "FY", "doc_id": DOC,
                     "quote": "매출액 | 10,891,443"}
            return LLMResult(data={"claims": [claim], "not_found_slots": [], "uncertainty": ""},
                             provider=self.provider, model="m", latency_ms=1)
        def complete_json(self, *a, **k):
            raise AssertionError("FC 클라이언트인데 JSON 경로로 갔다")

    state = qa_agent.answer_question("HMM의 2025년 매출액은 얼마인가?", retriever, llm=FCLLM())
    assert state.llm["used"] is True and state.llm.get("fc") is True
    assert state.llm["claims"] == {"total": 1, "kept": 1, "dropped": []}
    assert "10,891,443" in state.answer and "접수번호 20260318000001" in state.answer
    # 인라인 출처의 접수번호·일자가 '지어낸 숫자'로 잡히지 않아야 한다
    assert state.validation["status"] != "UNSUPPORTED", state.validation
    assert state.fallback_stage == ""


def test_complete_tool_retries_once_on_40009(monkeypatch):
    from dart_detective import llm as llm_mod
    llm = ClovaLLM(api_key="k")
    calls = {"n": 0}
    def fake_post(payload):
        calls["n"] += 1
        if calls["n"] == 1:
            raise LLMUnavailable('CLOVA HTTP 400: {"status":{"code":"40009","message":"Unsupported function"}}')
        return {"result": {"message": {"toolCalls": [{"type": "function", "function": {
            "name": "submit_grounded_answer",
            "arguments": {"claims": [], "not_found_slots": [], "uncertainty": ""}}}]},
            "usage": {}}}
    monkeypatch.setattr(llm, "_post", fake_post)
    monkeypatch.setattr(llm_mod.time, "sleep", lambda s: None)
    r = llm.complete_tool("s", "u", ga.SUBMIT_GROUNDED_ANSWER)
    assert calls["n"] == 2 and r.usage["fc_40009_retried"] is True

    calls["n"] = 10                                        # 두 번째도 40009면 그대로 예외
    def always_fail(payload):
        raise LLMUnavailable('CLOVA HTTP 400: {"status":{"code":"40009"}}')
    monkeypatch.setattr(llm, "_post", always_fail)
    with pytest.raises(LLMUnavailable):
        llm.complete_tool("s", "u", ga.SUBMIT_GROUNDED_ANSWER)


def test_qa_agent_falls_back_to_json_path_when_fc_unavailable(monkeypatch):
    """FC가 재시도 후에도 실패하면(실측 40009) 검증된 JSON 경로로 1회 대체한다."""
    from dart_corpus.retrieval import DocumentIndex, IndexedDocument
    from dart_corpus.retrieval.corp_dictionary import CorpDictionary
    from dart_detective.corpus_retriever import CorpusRetriever
    from dart_detective.agents import qa_agent
    from dart_detective.llm import LLMResult

    table = "매출액 | 10,891,443"
    corp = CorpDictionary.from_rows([{"corp_name": "HMM", "listed_name": "HMM", "stock_code": "011200"}])
    doc = IndexedDocument(doc_id=DOC, corp_name="HMM", corp_code="HMM", filer_name="HMM",
                          doc_group="periodic", doc_subtype="annual", report_nm="사업보고서 (2025.12)",
                          rcept_dt="20260318", base_year=2025, base_month=12, is_correction=False, text=table)
    retriever = CorpusRetriever(
        document_index=DocumentIndex([doc], corp), corp_dict=corp,
        docs_by_id={DOC: {"doc_id": DOC, "doc_group": "periodic",
                          "nodes": [{"node_index": 0, "kind": "table", "section_hierarchy": [], "text": table}]}})

    class FlakyFC:
        provider = "fake-fc"
        def complete_tool(self, *a, **k):
            raise LLMUnavailable('CLOVA HTTP 400: {"status":{"code":"40009"}}')
        def complete_json(self, system, user, schema, *, max_tokens=None):
            return LLMResult(data={"answer": "매출액은 10,891,443이다",
                                   "evidence": [{"document_id": DOC, "quote_or_fact": "매출액 | 10,891,443"}],
                                   "uncertainty": ""}, provider="fake-fc", model="m", latency_ms=1)

    state = qa_agent.answer_question("HMM의 2025년 매출액은 얼마인가?", retriever, llm=FlakyFC())
    assert state.llm["used"] is True and state.llm.get("fc_fallback_json") is True
    assert "40009" in state.llm.get("fc_error", "")
    assert "10,891,443" in state.answer and not state.llm.get("degraded")


def test_percent_of_derivation():
    from dart_detective.agents import calculator
    d = calculator.derive_percent_of(
        "현대건설 지분(32%)에 해당하는 계약금액은 얼마인가?",
        {"계약금액": "3,832,253,000,000"}, {"계약금액": "계약금액 | 3,832,253,000,000"})
    assert len(d) == 1 and d[0].kind == "percent_of"
    assert d[0].value == "1,226,320,960,000"                 # 3.832조 × 32% — LLM 산술 금지 대상
    assert calculator.derive_percent_of("비율 없는 질문", {"x": "100"}, {}) == []
    assert "1,226,320,960,000" in calculator.allowed_numbers(d)
