"""두 기업 비교 — 자리에 회사를 붙이고, 차액은 코드가 계산한다.

배경(N16 실측): "한국항공우주 FA-50 계약금액과 두산에너빌리티 Shymkent 계약금액 중
어느 쪽이 더 크고 차이는?" — LLM이 정확히 계산했지만(43,062,035,000) 그 값이 원문에
없어 Validator가 답변을 버렸다. 계산은 코드가 해야 하는 자리다.
"""
from __future__ import annotations

from dart_corpus.retrieval.conditions import QueryConditions
from dart_detective.agents import calculator, qa_agent
from dart_detective.corpus_retriever import RetrievedChunk

KAI = "2. 계약내역 | 계약금액(원) | 1,195,242,120,000"
DOOSAN = "2. 계약내역 | 계약금액(원) | 1,152,180,085,272"
QUESTION = "한국항공우주와 두산에너빌리티의 계약금액 중 어느 쪽이 더 크고 차이는 얼마인가?"


def chunk(text: str, corp: str, chunk_id: str) -> RetrievedChunk:
    return RetrievedChunk(chunk_id=chunk_id, doc_id=f"d_{corp}", score=1.0,
                          section_path=("공시",), row_labels=("계약금액",),
                          evidence_text=text, metadata={"corp_name": corp})


def conditions(corps) -> QueryConditions:
    return QueryConditions(corps=frozenset(corps), years=frozenset())


# ---------- 자리 이름에 회사가 붙는다 ----------

def test_two_companies_get_one_slot_each():
    slots = qa_agent.plan_slots(QUESTION, conditions(["한국항공우주", "두산에너빌리티"]))
    assert slots == ("계약금액@두산에너빌리티", "계약금액@한국항공우주", "answer")


def test_single_company_keeps_plain_item_slot():
    slots = qa_agent.plan_slots("한국항공우주의 계약금액은?", conditions(["한국항공우주"]))
    assert slots == ("계약금액", "answer")


def test_slot_splits_back_into_item_and_corp():
    assert qa_agent.split_entity("계약금액@한국항공우주") == ("계약금액", "한국항공우주")
    assert qa_agent.split_entity("계약금액") == ("계약금액", None)
    assert qa_agent.split_slot("매출액_2025") == ("매출액", 2025)


# ---------- 근거가 회사별로 갈린다 ----------

def test_evidence_does_not_mix_companies():
    chunks = [chunk(KAI, "한국항공우주", "c1"), chunk(DOOSAN, "두산에너빌리티", "c2")]
    matches = qa_agent.match_evidence(
        ["계약금액@한국항공우주", "계약금액@두산에너빌리티"], chunks, question=QUESTION)
    by_slot = {m.slot: m for m in matches}
    assert "1,195,242,120,000" in by_slot["계약금액@한국항공우주"].evidence_text
    assert "1,152,180,085,272" in by_slot["계약금액@두산에너빌리티"].evidence_text


def test_slot_stays_empty_when_that_company_has_no_chunk():
    matches = qa_agent.match_evidence(
        ["계약금액@한국항공우주", "계약금액@두산에너빌리티"],
        [chunk(KAI, "한국항공우주", "c1")], question=QUESTION)
    assert [m.slot for m in matches] == ["계약금액@한국항공우주"]


def test_item_line_value_is_picked_for_calculation():
    matches = qa_agent.match_evidence(
        ["계약금액@한국항공우주"], [chunk(KAI, "한국항공우주", "c1")], question=QUESTION)
    assert matches[0].picked_value == "1,195,242,120,000"


# ---------- 계산 ----------

def test_difference_and_larger_side_are_computed():
    got = calculator.derive(
        QUESTION, ["계약금액@한국항공우주", "계약금액@두산에너빌리티"],
        {"계약금액@한국항공우주": "1,195,242,120,000",
         "계약금액@두산에너빌리티": "1,152,180,085,272"})
    diff = next(d for d in got if d.kind == "difference")
    larger = next(d for d in got if d.kind == "larger_side")
    assert diff.value == "43,062,034,728"
    assert larger.value == "한국항공우주"


def test_difference_is_in_the_allowed_numbers_but_company_name_is_not():
    got = calculator.derive(
        QUESTION, ["계약금액@한국항공우주", "계약금액@두산에너빌리티"],
        {"계약금액@한국항공우주": "1,195,242,120,000",
         "계약금액@두산에너빌리티": "1,152,180,085,272"})
    allowed = calculator.allowed_numbers(got)
    assert "43,062,034,728" in allowed
    assert "한국항공우주" not in allowed


def test_missing_value_means_no_calculation():
    got = calculator.derive(QUESTION, ["계약금액@A", "계약금액@B"], {"계약금액@A": "100"})
    assert got == []


def test_three_companies_are_not_compared():
    """어느 둘을 비교하라는 것인지 질문만으로 정할 수 없다."""
    slots = ["계약금액@A", "계약금액@B", "계약금액@C"]
    assert calculator.plan_entity_comparisons(QUESTION, slots) == []


def test_non_comparison_question_is_not_calculated():
    got = calculator.derive("한국항공우주의 계약금액은 얼마인가?",
                            ["계약금액@한국항공우주", "계약금액@두산에너빌리티"],
                            {"계약금액@한국항공우주": "1,195,242,120,000",
                             "계약금액@두산에너빌리티": "1,152,180,085,272"})
    assert got == []


def test_mixed_units_are_not_compared():
    got = calculator.derive(
        QUESTION, ["계약금액@A", "계약금액@B"],
        {"계약금액@A": "100", "계약금액@B": "200"},
        {"계약금액@A": "계약금액 | 100 (단위: 백만원)",
         "계약금액@B": "계약금액 | 200 (단위: 원)"})
    assert got == []


def test_equal_values_report_difference_without_a_winner():
    got = calculator.derive(QUESTION, ["계약금액@A", "계약금액@B"],
                            {"계약금액@A": "100", "계약금액@B": "100"})
    assert [d.kind for d in got] == ["difference"]
    assert got[0].value == "100" or got[0].value == "0"


# ---------- 한국어 조사 ----------

def test_subject_particle_follows_the_final_consonant():
    assert calculator.subject_particle("계약금액") == "이"     # 받침 ㄱ
    assert calculator.subject_particle("차이") == "가"         # 받침 없음
    assert calculator.subject_particle("투자금액") == "이"
    assert calculator.subject_particle("FA-50") == "가"        # 한글 아님


def test_describe_uses_the_right_particle():
    got = calculator.derive(
        QUESTION, ["계약금액@한국항공우주", "계약금액@두산에너빌리티"],
        {"계약금액@한국항공우주": "1,195,242,120,000",
         "계약금액@두산에너빌리티": "1,152,180,085,272"})
    text = calculator.describe(got)
    assert "계약금액이 더 큰 쪽" in text
    assert "계약금액가" not in text


# ---------- 대량보유 요약 서식: 직전/이번 변동 계산 (3번-b) ----------

HOLDING_LINES = [
    '보유주식등의 수 및 보유비율 |  | 보유주식등의 수 | 보유비율',
    '직전 보고서 | 4,660,516 | 25.01',
    '이번 보고서 | 4,650,276 | 24.92',
]


def test_pair_change_is_computed_for_change_questions():
    got = calculator.report_pair_diffs('보유주식 수와 지분율은 직전 보고보다 변했는가?',
                                       HOLDING_LINES)
    assert [d.value for d in got] == ['-10,240', '-0.09']
    assert got[0].kind == 'pair_change'


def test_pair_change_needs_a_change_word():
    assert calculator.report_pair_diffs('이번 보고서 보유주식 수는?', HOLDING_LINES) == []


def test_mismatched_cell_counts_are_not_paired():
    lines = ['직전 보고서 | 4,660,516 | 25.01', '이번 보고서 | 4,650,276']
    assert calculator.report_pair_diffs('얼마나 변했나?', lines) == []


def test_non_numeric_cells_block_the_pair():
    lines = ['직전 보고서 | - | -', '이번 보고서 | 4,650,276 | 24.92']
    assert calculator.report_pair_diffs('얼마나 변했나?', lines) == []
