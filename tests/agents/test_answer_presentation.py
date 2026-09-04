"""유보/폴백 답변 표시층 정리 — 코덱스 검수 조건 6 회귀 잠금.

원칙: 원문 byte는 retrieved_context가 보존하고, answer 표시층만 정리한다.
정리는 기계적(태그 제거·완전 동일 중복 제거)이며 숫자·표 구분자를 바꾸지 않는다.
"""
from __future__ import annotations

import json

from dart_detective import answer_wire, fallback
from dart_detective.agents import qa_agent


def _m(slot, text, doc_id="d1", picked=None):
    return qa_agent.EvidenceMatch(
        slot=slot, chunk_id=f"c-{doc_id}", doc_id=doc_id, evidence_text=text,
        section_path=(), confidence=1.0, reason="t", picked_value=picked)


# ---------- 유보 전용 템플릿 (알테오젠 문형) ----------

def test_withheld_answer_has_no_raw_excerpt_dump():
    found = {"유보사항": "계약금액 세부 내역 및 개발 품목", "유보사유": "계약상 비밀유지",
             "유보기한": "2042년 12월 28일"}
    raw_row = "2. 주요내용 | 2. 주요내용 | ※ 투자유의사항본 계약은 의약품규제기관의"
    matches = [_m("answer", raw_row), _m("계약상대", "계약상대방: MedImmune Limited")]
    answer, uncertainty = qa_agent.withheld_answer(found, matches)
    assert "유보사항: 계약금액 세부 내역 및 개발 품목" in answer
    assert "유보사유: 계약상 비밀유지" in answer
    assert "유보기한" in answer and "2042년 12월 28일" in answer
    # 원문 표 행 덤프가 answer에 없어야 한다 — retrieved_context 몫이다.
    assert raw_row not in answer and "※ 투자유의사항" not in answer
    assert "retrieved_context" in answer            # 근거 위치 안내
    assert "유보" in uncertainty


def test_withheld_answer_preserves_non_withheld_values():
    found = {"유보사항": "계약금액", "유보사유": "비밀유지"}
    matches = [_m("계약상대", "계약상대방 | ABC", picked="ABC"),
               _m("answer", "긴 원문 줄 | 1,234 | 5,678")]
    answer, _ = qa_agent.withheld_answer(found, matches)
    assert "유보되지 않은 항목 중 공시에서 확인되는 값:" in answer
    assert "ABC" in answer
    assert "1,234" not in answer                    # 값 미확정 원문 행은 덤프하지 않는다


# ---------- 발췌 정리: 태그 제거·완전 동일 중복만 제거 ----------

def test_fallback_answer_strips_internal_slot_tags():
    matches = [_m("answer", "매출액 | 100 | 90")]
    answer, _ = qa_agent.fallback_answer(matches)
    assert "[answer]" not in answer
    assert "매출액 | 100 | 90" in answer            # 표 구분자·값은 원문 그대로(치환 금지)


def test_fallback_answer_dedupes_only_exact_rows_after_whitespace_norm():
    # 공백만 다른 두 줄(대량보유 주석 실측) → 1줄. 금액이 다른 유사 행 → 병합 금지.
    matches = [
        _m("answer", "주) 상기 최대주주 변동내역은 대량보유상황보고서 기준이며"),
        _m("answer", "주) 상기 최대주주 변동내역은 대량보유상황보고서  기준이며"),
        _m("answer", "직전보고서 | 2023년 09월 22일 | 4,329,578 | 7.40"),
        _m("answer", "직전보고서 | 2023년 09월 22일 | 4,329,578 | 7.41"),
    ]
    answer, _ = qa_agent.fallback_answer(matches)
    assert answer.count("최대주주 변동내역") == 1
    assert "7.40" in answer and "7.41" in answer    # 숫자 다른 행은 둘 다 보존


def test_multi_period_table_row_kept_verbatim():
    row = "구분 | 2024년 | 2023년\n매출액 | 100 | 90"
    answer, _ = qa_agent.fallback_answer([_m("answer", row)])
    assert row in answer                            # 다기간 표는 열 의미 보존 위해 원문 그대로


def test_excerpt_answer_dedupes_exact_only():
    matches = [_m("a", "같은 줄 원문 텍스트 123", doc_id="d1"),
               _m("b", "같은  줄 원문 텍스트 123", doc_id="d2"),
               _m("c", "다른 줄 원문 텍스트 124", doc_id="d3")]
    answer, _ = fallback.excerpt_answer(matches)
    assert answer.count("원문 텍스트 123") == 1 and "124" in answer


# ---------- retrieved_context 무변경 ----------

def test_retrieved_context_is_independent_of_answer_presentation():
    """표시층 정리는 answer만 바꾼다 — retrieved_context는 evidence 원문 byte 그대로."""
    raw = "2. 주요내용 | ※ 투자유의사항 | 계약금: US$ 25,000,000"
    match = _m("answer", raw).__dict__ | {"slot": "answer"}
    state = {
        "question": "q", "answer": "유보 템플릿 답변", "uncertainty": "",
        "evidence_matches": [match],
        "evidence": [], "validation": {"status": "SUPPORTED", "answerability": "WITHHELD",
                                       "checks": []},
        "route": {}, "calculation": {},
    }
    wire = answer_wire.to_answer_wire("qid", "q", state)
    ctx = json.loads(wire["retrieved_context"])
    assert any(raw == e.get("quoted_text") for e in ctx)   # 원문 byte 그대로 보존
    assert raw not in wire["answer"]
