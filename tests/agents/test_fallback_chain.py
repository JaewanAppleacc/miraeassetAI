"""⑨ 3단 폴백 — 단계 순서·발췌 상한·수리 OFF 기본값·게이트 재통과. LLM·코퍼스 없음."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from dart_detective import fallback
from dart_detective.llm import LLMResult

SOURCES = [{"document_id": "d1", "text": "매출액 | 10,891,443\n영업이익 | 1,461,202"}]


def _match(doc="d1", text="매출액 | 10,891,443"):
    return SimpleNamespace(doc_id=doc, evidence_text=text, slot="매출액", picked_value="")


# ---------- 발췌 상한 ----------

def test_excerpt_limits_per_doc_and_total():
    matches = [ _match(doc=f"d{i//5}", text=f"줄{i} | {i}") for i in range(30) ]
    answer, _ = fallback.excerpt_answer(matches)
    lines = [l for l in answer.split("\n") if l.startswith("- ")]
    assert len(lines) <= fallback.MAX_LINES_TOTAL
    for d in {f"d{i//5}" for i in range(30)}:
        per = sum(1 for i, l in enumerate(lines))  # 총량만 — 문서별은 아래에서
    from collections import Counter
    docs = [f"d{i//5}" for i in range(30)]
    # 문서별 상한: 같은 문서 매치 5개 중 3개만
    m2 = [_match(doc="dX", text=f"행{i} | {i}") for i in range(5)]
    a2, _ = fallback.excerpt_answer(m2)
    assert sum(1 for l in a2.split("\n") if l.startswith("- ")) == fallback.MAX_LINES_PER_DOC


def test_excerpt_empty_matches_is_safe():
    answer, unc = fallback.excerpt_answer([])
    assert answer == fallback.SAFE_ANSWER and unc == fallback.SAFE_UNCERTAINTY


# ---------- 체인 ----------

def test_template_stage_wins_when_grounded():
    out = fallback.resolve(matches=[_match()], sources=SOURCES,
                           template=("공시에서 확인한 값:\n- 매출액: 10,891,443", "원문 그대로"))
    assert out["stage"] == "template" and out["validation"]["status"] != "UNSUPPORTED"
    assert [a["stage"] for a in out["attempts"]] == ["template"]


def test_falls_through_to_excerpt_when_template_fabricates():
    out = fallback.resolve(matches=[_match()], sources=SOURCES,
                           template=("매출액은 77,777이다", ""))          # 원문에 없는 숫자
    assert out["stage"] == "excerpt"
    assert [a["stage"] for a in out["attempts"]] == ["template", "excerpt"]
    assert "10,891,443" in out["answer"]


def test_repair_off_by_default(monkeypatch):
    monkeypatch.delenv("DART_QA_REPAIR", raising=False)
    calls = []
    class L:
        provider = "fake"
        def complete_json(self, *a, **k):
            calls.append(1)
            return LLMResult(data={"answer": "수리된 답 10,891,443", "evidence": [], "uncertainty": ""},
                             provider="fake", model="m", latency_ms=1)
    out = fallback.resolve(matches=[_match()], sources=SOURCES, llm=L(),
                           system_prompt="s", user_prompt="u", answer_schema={"type": "object"},
                           template=("77,777", ""))
    assert calls == [] and out["stage"] == "excerpt"                      # 수리 호출 안 함


def test_repair_runs_once_when_enabled_and_gates_result(monkeypatch):
    monkeypatch.setenv("DART_QA_REPAIR", "on")
    calls = []
    class L:
        provider = "fake"
        def complete_json(self, system, user, schema):
            calls.append(system)
            return LLMResult(data={"answer": "매출액은 10,891,443이다", "evidence": [], "uncertainty": ""},
                             provider="fake", model="m", latency_ms=1)
    out = fallback.resolve(matches=[_match()], sources=SOURCES, llm=L(),
                           system_prompt="본래 시스템", user_prompt="u", answer_schema={"type": "object"},
                           template=("77,777", ""))
    assert len(calls) == 1 and fallback.REPAIR_SYSTEM_SUFFIX.strip()[:6] in calls[0]
    assert out["stage"] == "repair" and out["validation"]["status"] != "UNSUPPORTED"


def test_repair_failure_falls_to_next_stage(monkeypatch):
    monkeypatch.setenv("DART_QA_REPAIR", "on")
    class L:
        provider = "fake"
        def complete_json(self, *a, **k):
            return LLMResult(data={"answer": "지어낸 88,888", "evidence": [], "uncertainty": ""},
                             provider="fake", model="m", latency_ms=1)
    out = fallback.resolve(matches=[_match()], sources=SOURCES, llm=L(),
                           system_prompt="s", user_prompt="u", answer_schema={"type": "object"},
                           template=("77,777", ""))
    assert [a["stage"] for a in out["attempts"]] == ["repair", "template", "excerpt"]
    assert out["stage"] == "excerpt"
