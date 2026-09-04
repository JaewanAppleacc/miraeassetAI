"""전수 테스트 인사이트 라운드(2026-09-05) 회귀 잠금 — 검색 Stage 2 교정·비교계산 기간/단위 결박·대량보유 필드.

실측 배경은 docs/CLAUDE.md '전수 테스트 인사이트' 블록. 여기서는 오프라인으로 확인한 동작만 잠근다.
"""
from __future__ import annotations

from dart_detective import corpus_retriever as cr
from dart_detective.agents import calculator, qa_agent
from dart_detective.corpus_retriever import RetrievedChunk

# ---------- 검색 Stage 2: 접수일 허용 오차·1위 문서 청크 보장 ----------


def test_question_rcept_dates_tolerate_one_day():
    """질문은 공시 이벤트일(03-17), 접수일은 하루 뒤(03-18) — 둘 다 대조 집합에 든다."""
    dates = cr.question_rcept_dates("삼성중공업의 2025-03-17 에탄운반선 공급계약 공시에서")
    assert {"20250316", "20250317", "20250318"} <= dates
    assert "20250319" not in dates


def test_guarantee_top_doc_moves_quota_chunks_to_front():
    class C:  # noqa: D401 — 최소 청크 대역
        def __init__(self, doc_id, cid):
            self.doc_id, self.chunk_id = doc_id, cid
    hits = [(0.9, C("periodic_1", "p1")), (0.8, C("periodic_1", "p2")), (0.7, C("exchange_gold", "g1")),
            (0.6, C("periodic_2", "p3")), (0.5, C("exchange_gold", "g2"))]
    out = cr.guarantee_top_doc(hits, "exchange_gold", 3)
    assert [h[1].chunk_id for h in out[:2]] == ["g1", "g2"]    # 1위 문서 청크가 앞으로
    assert len(out) == len(hits)                              # 유실·중복 없음
    assert cr.guarantee_top_doc(hits, "", 3) == hits           # 문서 없으면 원형


# ---------- 비교계산: 분기/반기 월 결박·누적 열·요약재무정보 우선·단위 괴리 가드 ----------


def test_period_months_from_question_wording():
    assert qa_agent.period_months("2023년 1분기보고서(2023.03)와 2025년 1분기보고서") == frozenset({3})
    assert qa_agent.period_months("2023년 반기보고서(2023.06)와 2025년 반기보고서") == frozenset({6})
    assert qa_agent.period_months("2023.09.30 누적와(과) 2025.09.30 누적 사이") == frozenset({9})
    assert qa_agent.period_months("2023년 1월~6월와(과) 2025년 1월~6월 사이") == frozenset({6})
    assert qa_agent.period_months("2023년과 2025년 연결 실적") == frozenset()


def _chunk(text, doc_id, period_year, base_month, section=("III. 재무에 관한 사항", "2. 연결재무제표")):
    return RetrievedChunk(chunk_id=f"c-{doc_id}", doc_id=doc_id, score=1.0, section_path=section,
                          row_labels=("매출액",), evidence_text=text,
                          metadata={"period_year": period_year, "base_month": base_month,
                                    "base_year": period_year, "corp_name": "X"})


HALF_2025 = ("구분 | 제 60 기 반기 | 제 59 기 | 제 58 기\n"
             "매출액 | 5,945,554 | 13,527,367 | 27,340,601")          # 2025 반기보고서: 전전기 열 = 2023 연간
HALF_2023 = ("구분 | 제 58 기 반기 | 제 57 기 반기\n"
             " | 3개월 | 누적 | 3개월 | 누적\n"
             "매출액 | 7,138,316 | 13,527,367 | 7,381,002 | 14,000,000")  # 2023 반기보고서 손익계산서


def test_same_period_slot_binds_to_that_years_document():
    """2023년 반기 자리를 2025년 반기보고서의 전전기(연간) 열로 채우지 않는다."""
    chunks = [_chunk(HALF_2025, "periodic_2025", 2025, 6), _chunk(HALF_2023, "periodic_2023", 2023, 6)]
    q = "현대제철의 2023년 반기보고서(2023.06)와 2025년 반기보고서(2025.06)에서 매출액을 비교하면 얼마나 증감했는가?"
    matches = qa_agent.match_evidence(["매출액_2023", "매출액_2025"], chunks, question=q,
                                      bind_doc_year=True, bind_months=frozenset({6}))
    by = {m.slot: m for m in matches}
    assert by["매출액_2023"].doc_id == "periodic_2023"
    assert by["매출액_2023"].picked_value == "13,527,367"        # 누적 열(3개월 7,138,316이 아님)
    assert by["매출액_2025"].doc_id == "periodic_2025"


def test_quarter_month_binding_rejects_third_quarter_report_for_q1_question():
    q1_doc = _chunk("구분 | 제 60 기 1분기 | 제 59 기\n매출액 | 546,799 | 1,900,000", "periodic_q1", 2023, 3)
    q3_doc = _chunk("구분 | 제 60 기 3분기 | 제 59 기\n매출액 | 1,628,530 | 2,220,752", "periodic_q3", 2023, 9)
    matches = qa_agent.match_evidence(["매출액_2023"], [q3_doc, q1_doc], question="2023년 1분기 매출액",
                                      bind_doc_year=True, bind_months=frozenset({3}))
    assert matches and matches[0].doc_id == "periodic_q1"


def test_summary_table_preferred_for_same_period_comparison():
    summary = _chunk("구분 | 2023년 반기 | 2022년 반기\n매출액 | 13,527,367 | 14,000,000", "periodic_2023", 2023, 6,
                     section=("III. 재무에 관한 사항", "1. 요약재무정보"))
    summary = RetrievedChunk(**{**summary.__dict__, "chunk_id": "c-summary"})
    income = _chunk(HALF_2023, "periodic_2023", 2023, 6)
    matches = qa_agent.match_evidence(["매출액_2023"], [income, summary], question="2023년 반기 매출액 비교",
                                      bind_doc_year=True, bind_months=frozenset({6}))
    assert matches[0].chunk_id == "c-summary"                 # 검색 순위(income이 1위)를 넘어 요약표 우선


def test_magnitude_gap_blocks_mixed_unit_calculation():
    """원 단위 표와 백만원 표가 섞이면(5,573만% 증가 실측) 계산하지 않는다."""
    got = calculator.derive("2023년과 2025년 매출액은 얼마나 변동했는가?", ["매출액_2023", "매출액_2025"],
                            {"매출액_2023": "1,628,530", "매출액_2025": "907,622,648,219"})
    assert got == []
    ok = calculator.derive("2023년과 2025년 매출액은 얼마나 변동했는가?", ["매출액_2023", "매출액_2025"],
                           {"매출액_2023": "546,799", "매출액_2025": "907,623"})
    assert any(d.kind == "increase_rate" for d in ok)


# ---------- 대량보유: 발행회사명·관계·보고서 작성기준일·보유목적 표현 ----------

from test_holding_parser import KZ_QUESTION, kz_chunks, values_by_slot  # noqa: E402


def test_issuer_and_relationship_extracted_with_reporter():
    vals = values_by_slot(calculator.parse_holding_report(KZ_QUESTION, kz_chunks()))
    assert vals["발행회사명"] == "고려아연(주)"
    assert vals["발행회사와의 관계"] == "임원(등기)"
    assert vals["보유목적"].startswith("경영권 영향")


def test_report_dates_emitted_only_for_periods_actually_used():
    from test_holding_parser import HISTORY, MFS_DOC, QUESTION, chunk, se_chunks, SE_QUESTION
    full = values_by_slot(calculator.parse_holding_report(QUESTION, [chunk(HISTORY)]))
    assert full["직전 보고서 작성기준일"] == "2023년 06월 02일"
    assert full["이번 보고서 작성기준일"] == "2024년 03월 22일"
    new_report = values_by_slot(calculator.parse_holding_report(SE_QUESTION, se_chunks()))
    assert "직전 보고서 작성기준일" not in new_report          # 신규 보고 — 억제한 연혁 행은 날짜로도 승격 금지
    assert "이번 보고서 작성기준일" in new_report
