"""LLM provider 어댑터 — 네트워크 없이 계약만 검증한다.

실제 HyperCLOVA X 호출은 키가 있어야 하므로 여기서 하지 않는다. 대신
  - 키가 없으면 조용히 None(결정론적 경로)으로 떨어지는지
  - Claude가 자동 선택되지 않는지 (제출 요건: HyperCLOVA X만 허용)
  - 응답 파싱이 코드펜스/설명 섞인 출력도 견디는지
를 본다.
"""
from __future__ import annotations

import pytest

from dart_detective import llm as llm_mod

ENV_KEYS = ("DART_DETECTIVE_LLM", "DART_DETECTIVE_LLM_PROVIDER",
            "CLOVA_API_KEY", "CLOVA_MODEL", "CLOVA_ENDPOINT",
            "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def test_no_credentials_means_deterministic_path():
    assert llm_mod.get_llm() is None


def test_clova_is_selected_when_key_present(monkeypatch):
    monkeypatch.setenv("CLOVA_API_KEY", "test-key")
    client = llm_mod.get_llm()
    assert client is not None and client.provider == "clova"
    assert isinstance(client, llm_mod.LLMClient)


def test_anthropic_is_never_auto_selected(monkeypatch):
    """평가 대상은 HyperCLOVA X뿐이다 — Claude 자격증명이 있어도 자동 선택 금지."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-not-real")
    assert llm_mod.get_llm() is None


def test_llm_can_be_forced_off(monkeypatch):
    monkeypatch.setenv("CLOVA_API_KEY", "test-key")
    monkeypatch.setenv("DART_DETECTIVE_LLM", "off")
    assert llm_mod.get_llm() is None


def test_clova_requires_a_key():
    with pytest.raises(llm_mod.LLMUnavailable):
        llm_mod.ClovaLLM(api_key="")


def test_clova_url_is_model_scoped(monkeypatch):
    monkeypatch.setenv("CLOVA_API_KEY", "test-key")
    client = llm_mod.ClovaLLM(model="HCX-005",
                              endpoint="https://example.invalid/v3/chat-completions")
    assert client.url == "https://example.invalid/v3/chat-completions/HCX-005"


def test_clova_parses_chat_completion_response(monkeypatch):
    client = llm_mod.ClovaLLM(api_key="test-key")
    captured: dict = {}

    def fake_post(payload):
        captured.update(payload)
        return {"result": {"message": {"role": "assistant",
                                       "content": '```json\n{"answer": "3.8"}\n```'},
                           "usage": {"completionTokens": 7}}}

    monkeypatch.setattr(client, "_post", fake_post)
    result = client.complete_json("시스템", "질문", {"type": "object"})
    assert result.data == {"answer": "3.8"}
    assert result.provider == "clova" and result.usage["completionTokens"] == 7
    assert captured["messages"][0]["role"] == "system"
    assert "JSON" in captured["messages"][0]["content"]


def test_clova_empty_response_is_unavailable(monkeypatch):
    client = llm_mod.ClovaLLM(api_key="test-key")
    monkeypatch.setattr(client, "_post", lambda payload: {"status": {"code": "40000"}})
    with pytest.raises(llm_mod.LLMUnavailable):
        client.complete_json("시스템", "질문", {"type": "object"})


@pytest.mark.parametrize("text,expected", [
    ('{"a": 1}', {"a": 1}),
    ('```json\n{"a": 1}\n```', {"a": 1}),
    ('답변입니다: {"a": 1} 이상입니다', {"a": 1}),
])
def test_extract_json_survives_wrappers(text, expected):
    assert llm_mod.extract_json(text) == expected


def test_extract_json_rejects_non_json():
    with pytest.raises(llm_mod.LLMUnavailable):
        llm_mod.extract_json("JSON이 아닙니다")
