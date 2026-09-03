"""Phase 11 — parser/transport 실패만 결정론적으로 복구한다.

복구 대상은 "LLM이 정상 구조로 답했는데 우리 쪽 처리가 실패한 것"뿐이다.
LLM이 틀리게 답한 것은 그대로 실패로 남아야 한다 — 아래 거부 테스트가 그 경계다.
"""
from __future__ import annotations

import pytest

from dart_detective import llm as llm_mod
from dart_detective.agents import qa_agent


# ---------- A. answer가 list로 오는 경우 ----------

def test_answer_list_becomes_one_string():
    got = qa_agent.answer_text(["첫 줄입니다.", "둘째 줄입니다."])
    assert got == "첫 줄입니다.\n둘째 줄입니다."


def test_answer_list_of_non_strings_is_stringified_safely():
    assert qa_agent.answer_text(["a", 3, None]) == "a\n3"


def test_answer_list_of_dicts_is_serialized_not_rewritten():
    """Phase 10 Q06 실제 형태 — dict 리스트. 값은 그대로 두고 타입만 편다."""
    got = qa_agent.answer_text([
        {"투자 대상": "Floating Dock 확장", "투자 금액": "332,800,000,000원"},
        {"투자 대상": "Floating Crane", "투자 금액": "268,000,000,000원"},
    ])
    assert got == ("투자 대상: Floating Dock 확장 · 투자 금액: 332,800,000,000원\n"
                   "투자 대상: Floating Crane · 투자 금액: 268,000,000,000원")


def test_nested_list_inside_dict_is_joined():
    got = qa_agent.answer_text([{"유보상태변화": ["2023-06-05 공시", "2024-07-02 본계약"]}])
    assert got == "유보상태변화: 2023-06-05 공시, 2024-07-02 본계약"


def test_answer_string_is_untouched():
    assert qa_agent.answer_text("  그대로  ") == "그대로"


def test_answer_none_or_empty_stays_empty():
    assert qa_agent.answer_text(None) == ""
    assert qa_agent.answer_text([]) == ""
    assert qa_agent.answer_text([""]) == ""


def test_answer_dict_of_fields_is_serialized_not_rewritten():
    """Phase1 실측 형태 — 항목별 dict. 값은 그대로 두고 "키: 값"으로만 편다."""
    got = qa_agent.answer_text({"계약상대방": "현대자동차(주)", "계약금액": "3,365,500,000,000원",
                                "계약기간": {"시작일": "2025-01-01", "종료일": "2029-12-31"}})
    assert got == ("계약상대방: 현대자동차(주)\n계약금액: 3,365,500,000,000원\n"
                   "계약기간: 시작일: 2025-01-01 · 종료일: 2029-12-31")


def test_answer_wrapped_dict_is_unwrapped():
    assert qa_agent.answer_text({"answer": "x"}) == "x"
    assert qa_agent.answer_text({"answer": ["a", "b"]}) == "a\nb"


def test_answer_dict_values_still_go_through_validator():
    from dart_detective.agents import validator
    answer = qa_agent.answer_text({"계약금액": "999,999원"})
    assert validator.validate(answer, [], [{"document_id": "d1", "text": "계약금액 | 100"}]
                              )["status"] == "UNSUPPORTED"


def test_change_question_wakes_calculator():
    from dart_detective.agents import calculator
    assert calculator.is_comparison_question(
        "두산로보틱스의 연결기준 매출액은 2023년과 2025년 사이에 얼마나 변동했는가?")


# ---------- B. JSON object 추출 ----------

@pytest.mark.parametrize("text,expected", [
    ('{"a": 1}', {"a": 1}),
    ('```json\n{"a": 1}\n```', {"a": 1}),
    ('답변입니다: {"a": 1} 이상입니다', {"a": 1}),
    ('  \n{"a": {"b": 2}}\n  ', {"a": {"b": 2}}),
    ('설명\n```\n{"a": "중괄호 { 포함 문자열"}\n```\n끝', {"a": "중괄호 { 포함 문자열"}),
])
def test_extract_json_recovers_wrapped_object(text, expected):
    assert llm_mod.extract_json(text) == expected


def test_extract_json_rejects_plain_text():
    with pytest.raises(llm_mod.LLMUnavailable):
        llm_mod.extract_json("JSON이 아닙니다")


def test_extract_json_rejects_malformed_object():
    """중괄호는 있지만 깨진 JSON — 의미 추론으로 고치지 않는다."""
    with pytest.raises(llm_mod.LLMUnavailable):
        llm_mod.extract_json('{"a": 1, "b" 2}')


def test_extract_json_rejects_invalid_escape():
    with pytest.raises(llm_mod.LLMUnavailable):
        llm_mod.extract_json(r'{"a": "잘못된 \escape"}')


def test_extract_json_rejects_multiple_objects():
    """어느 것이 답인지 모호하면 실패로 남긴다."""
    with pytest.raises(llm_mod.LLMUnavailable):
        llm_mod.extract_json('{"answer": "A"}\n{"answer": "B"}')


def test_extract_json_takes_object_followed_by_prose():
    """뒤에 붙은 설명에 중괄호가 없으면 오브젝트 하나로 본다."""
    assert llm_mod.extract_json('{"a": 1}\n\n이상입니다.') == {"a": 1}


def test_extract_json_rejects_json_array():
    with pytest.raises(llm_mod.LLMUnavailable):
        llm_mod.extract_json('[{"a": 1}]')


# ---------- C. HTTP 429 재시도 ----------

class FakeHTTPError(Exception):
    def __init__(self, code):
        self.code = code


@pytest.fixture
def clova(monkeypatch):
    monkeypatch.setattr(llm_mod.time, "sleep", lambda *_: None)
    return llm_mod.ClovaLLM(api_key="test-key")


def test_429_is_retried_once_and_succeeds(clova, monkeypatch):
    calls = {"n": 0}

    def fake_open(request, timeout=None, context=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise llm_mod.urllib.error.HTTPError(clova.url, 429, "Too Many Requests",
                                                 None, None)
        return _FakeResponse('{"result": {"message": {"content": "{\\"a\\": 1}"}}}')

    monkeypatch.setattr(llm_mod.urllib.request, "urlopen", fake_open)
    body = clova._post({"messages": []})
    assert calls["n"] == 2
    assert clova.last_retries == 1
    assert body["result"]["message"]["content"] == '{"a": 1}'


def test_two_consecutive_429_falls_back(clova, monkeypatch):
    calls = {"n": 0}

    def fake_open(request, timeout=None, context=None):
        calls["n"] += 1
        raise llm_mod.urllib.error.HTTPError(clova.url, 429, "Too Many Requests",
                                             None, None)

    monkeypatch.setattr(llm_mod.urllib.request, "urlopen", fake_open)
    with pytest.raises(llm_mod.LLMUnavailable):
        clova._post({"messages": []})
    assert calls["n"] == 2          # 최초 1 + 재시도 1. 무한 반복 없음
    assert clova.last_retries == 1


def test_non_429_http_error_is_not_retried(clova, monkeypatch):
    calls = {"n": 0}

    def fake_open(request, timeout=None, context=None):
        calls["n"] += 1
        raise llm_mod.urllib.error.HTTPError(clova.url, 500, "Server Error", None, None)

    monkeypatch.setattr(llm_mod.urllib.request, "urlopen", fake_open)
    with pytest.raises(llm_mod.LLMUnavailable):
        clova._post({"messages": []})
    assert calls["n"] == 1
    assert clova.last_retries == 0


def test_connection_error_is_not_retried(clova, monkeypatch):
    calls = {"n": 0}

    def fake_open(request, timeout=None, context=None):
        calls["n"] += 1
        raise llm_mod.urllib.error.URLError("연결 없음")

    monkeypatch.setattr(llm_mod.urllib.request, "urlopen", fake_open)
    with pytest.raises(llm_mod.LLMUnavailable):
        clova._post({"messages": []})
    assert calls["n"] == 1


class _FakeResponse:
    def __init__(self, body: str):
        self._body = body.encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


# ---------- 경계: 느슨해지지 않았는지 ----------

def test_recovered_answer_still_goes_through_validator():
    """list를 합쳐 만든 답이라도 근거 없는 숫자는 통과하지 못한다."""
    from dart_detective.agents import validator
    answer = qa_agent.answer_text(["매출액은 999,999원이다."])
    check = validator.validate(answer, [], [{"document_id": "d1",
                                             "text": "매출액 | 100"}])
    assert check["status"] == "UNSUPPORTED"


# ---------- evidence가 문자열 배열로 오는 경우 (run A Q18 실측) ----------

def test_string_citations_are_normalized_not_crashed():
    got = qa_agent.normalize_citations(["원문 한 줄", {"document_id": "d1",
                                                     "quote_or_fact": "다른 줄"}, 3, None])
    assert got == [{"document_id": "", "quote_or_fact": "원문 한 줄"},
                   {"document_id": "d1", "quote_or_fact": "다른 줄"}]


def test_non_list_citations_become_empty():
    assert qa_agent.normalize_citations("문자열") == []
    assert qa_agent.normalize_citations(None) == []
