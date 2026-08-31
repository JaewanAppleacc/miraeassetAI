"""팀 공식 스키마 원본으로 우리 /answer 응답을 검증한다.

tests/fixtures/team_contracts/의 두 스키마는 팀 공통 기반(domain/interfaces/)에서
그대로 복사한 것이다 — 우리가 손으로 옮겨 적은 계약이 아니라 **원본 그 자체**다.
팀이 스키마를 바꾸면 이 사본을 갱신하는 순간 테스트가 이탈을 잡는다.

검증 순서는 하니스와 같다:
  1) wire 본문(문자열 5개)을 answer-wire-response.schema.json으로
  2) retrieved_context/think_trace를 JSON.parse로 되돌린 내부 모양을
     final-response.schema.json으로 (execution_mode enum이 여기서 걸린다 —
     실측에서 25건 전부 계약 위반을 냈던 그 검사다)
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from dart_detective import answer_wire

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "team_contracts"
WIRE_SCHEMA = json.loads((FIXTURES / "answer-wire-response.schema.json").read_text(encoding="utf-8"))
FINAL_SCHEMA = json.loads((FIXTURES / "final-response.schema.json").read_text(encoding="utf-8"))

wire_validator = Draft202012Validator(WIRE_SCHEMA)
final_validator = Draft202012Validator(FINAL_SCHEMA)


def state_of(**over):
    base = {
        "answer": "계약금액은 1,195,242,120,000원이다.",
        "evidence": [{"chunk_id": "c1", "text": "계약금액(원) | 1,195,242,120,000",
                      "section_path": ["공시"], "doc_id": "exchange_20230224800251"}],
        "evidence_matches": [{"slot": "계약금액", "chunk_id": "c1",
                              "doc_id": "exchange_20230224800251",
                              "evidence_text": "계약금액(원) | 1,195,242,120,000",
                              "section_path": ["공시"], "confidence": 1.0,
                              "reason": "Retrieval 1위", "node_index": 0,
                              "rcept_no": "", "picked_value": "1,195,242,120,000"}],
        "slots": ["계약금액", "answer"],
        "conditions": {"corps": ["한국항공우주"], "years": [2023]},
        "retrieval": [{"chunk_id": "c1"}],
        "derived": [],
        "validation": {"status": "SUPPORTED", "checks": []},
        "confidence": {"score": 80, "level": "높음", "reasons": []},
        "llm": {"used": False},
        "warnings": [],
        "prompt_version": "qa-2026-08-31.1",
    }
    base.update(over)
    return base


def restored(wire: dict) -> dict:
    """하니스의 fromAnswerWireResponse와 같은 복원 — 문자열을 되돌린 내부 모양."""
    return {
        "question": wire["question"],
        "retrieved_context": json.loads(wire["retrieved_context"]),
        "think_trace": json.loads(wire["think_trace"]),
        "answer": wire["answer"],
    }


def assert_valid(validator, instance):
    errors = sorted(validator.iter_errors(instance), key=lambda e: e.json_path)
    assert not errors, "\n".join(f"{e.json_path}: {e.message}" for e in errors[:5])


# ---------- 대표 상태들이 두 스키마를 모두 통과한다 ----------

@pytest.mark.parametrize("label,over", [
    ("근거 있는 답", {}),
    ("근거 없음", {"evidence": [], "evidence_matches": [],
                 "slots": ["answer"], "answer": "근거를 찾지 못했다."}),
    ("계산 답", {"derived": [{"metric": "매출액", "kind": "increase_rate",
                            "formula": "f", "value": "3.145", "unit": "%",
                            "source_slots": [], "source_values": []}]}),
    ("기업 경고", {"warnings": ["corp_unspecified"]}),
    ("LLM 채택", {"llm": {"used": True, "provider": "clova"}}),
])
def test_wire_and_restored_shape_pass_the_official_schemas(label, over):
    wire = answer_wire.to_answer_wire("Q-001", "질문", state_of(**over))
    assert_valid(wire_validator, wire)
    assert_valid(final_validator, restored(wire))


# ---------- 스키마가 실제로 지키는지 (음성 확인) ----------

def test_wire_schema_rejects_an_object_context():
    """retrieved_context를 문자열이 아니라 배열로 보내면 계약 위반이어야 한다."""
    wire = answer_wire.to_answer_wire("Q", "질문", state_of())
    wire["retrieved_context"] = []          # type: ignore[assignment]
    assert list(wire_validator.iter_errors(wire))


def test_final_schema_rejects_a_made_up_execution_mode():
    """enum 밖 execution_mode — 실측에서 25건 전부 잡혔던 그 위반."""
    wire = answer_wire.to_answer_wire("Q", "질문", state_of())
    inner = restored(wire)
    inner["think_trace"]["execution_mode"] = "BM25_TWO_STAGE"
    assert list(final_validator.iter_errors(inner))


def test_vendored_schemas_are_the_official_ones():
    """사본이 원본임을 표시하는 지문 — 팀 스키마의 고유 $id를 그대로 갖고 있어야 한다."""
    assert WIRE_SCHEMA["$id"].endswith("answer-wire-response.v0.1.json")
    assert FINAL_SCHEMA["required"] == ["question", "retrieved_context",
                                        "think_trace", "answer"]
