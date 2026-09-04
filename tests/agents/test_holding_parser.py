"""대량보유상황보고서 서식 파서 — docs/plans/2026-09-05-holding-parser.md §2 실물 픽스처.

실측 배경(judge16): 대량보유 33문항 전부에서 기존 report_pair_diffs가 미발동(0건).
실제 서식 2종(연혁표: 라벨 붙은 표기·9칸 / 요약표: 라벨 둘째 칸) 모두
`l.split("|")[0].strip() == "직전 보고서"` 완전일치에 걸리지 않기 때문이다.
새 파서는 머리글 이름으로 열을 찾고(고정 인덱스 금지), 질문 기준일·보고자로
문서를 결박하며, 유일하게 정해지지 않으면 미발동(fail-closed)한다.
"""
from __future__ import annotations

from dart_detective.agents import calculator, validator
from dart_detective.corpus_retriever import RetrievedChunk

# ---------- §2 실물 픽스처 (원문 그대로) ----------

HISTORY = (
    "| 보고서작성기준일 | 보고자 | 보고자 | 주식등 | 주식등 | 주권 | 주권 | 의결권 있는 발행주식총수(주)\n"
    " | 보고서작성기준일 | 본인 성명 | 특별관계자수 | 주식등의 수(주) | 비율(%) | 주식수(주) | 비율(%) | 의결권 있는 발행주식총수(주)\n"
    "직전보고서 | 2023년 06월 02일 | MassachusettsFinancialServicesCompany | 1 | 2,925,317 | 5.00 | 2,925,317 | 5.00 | 58,492,759\n"
    "이번보고서 | 2024년 03월 22일 | MassachusettsFinancialServicesCompany | 1 | 2,263,085 | 3.87 | 2,263,085 | 3.87 | 58,492,759\n"
    "증    감 | 증    감 | 증    감 | 증    감 | -662,232 | -1.13 | -662,232 | -1.13 | 0"
)

SUMMARY = (
    "보유주식등의 수 및 보유비율 |  | 보유주식등의 수 | 보유비율\n"
    "보유주식등의 수 및 보유비율 | 직전 보고서 | 2,925,317 | 5.00\n"
    "보유주식등의 수 및 보유비율 | 이번 보고서 | 2,263,085 | 3.87\n"
    "의결권의 수 및보유비율 |  | 의결권의 수 | 보유비율\n"
    "의결권의 수 및보유비율 | 직전 보고서 | - | -\n"
    "의결권의 수 및보유비율 | 이번 보고서 | 2,263,085 | 3.87"
)

BASIS_DATE_LINE = "한국거래소 귀중 | 보고서작성기준일 : | 2024년 03월 22일"

# 오결합 함정: 다른 문서·다른 보고자·다른 기준일 (실제 검색 근거에 함께 등장)
TRAP = (
    "| 보고서작성기준일 | 보고자 | 보고자 | 주식등 | 주식등 | 주권 | 주권 | 의결권 있는 발행주식총수(주)\n"
    " | 보고서작성기준일 | 본인 성명 | 특별관계자수 | 주식등의 수(주) | 비율(%) | 주식수(주) | 비율(%) | 의결권 있는 발행주식총수(주)\n"
    "직전보고서 | 2023년 09월 22일 | 국민연금공단 | 1 | 4,329,578 | 7.40 | 4,329,578 | 7.40 | 58,492,759\n"
    "이번보고서 | 2024년 08월 16일 | 국민연금공단 | 1 | 3,744,240 | 6.40 | 3,744,240 | 6.40 | 58,492,759"
)

QUESTION = ("Massachusetts Financial Services Company이(가) (주)아모레퍼시픽에 대해 제출한 "
            "주식등의 대량보유상황보고서(보고서작성기준일 2024년 03월 22일)에 따르면, "
            "직전 보고서 대비 이번 보고서의 보유주식등의 수와 보유비율은 각각 어떻게 변동되었는가?")

MFS_DOC = "holding_20240403000410"
NPS_DOC = "holding_20240820000123"


def chunk(text: str, doc_id: str = MFS_DOC, chunk_id: str = "c1",
          filer: str = "Massachusetts Financial Services Company",
          node_index: int = 28) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id, doc_id=doc_id, score=1.0, section_path=("대량보유",),
        row_labels=(), evidence_text=text, node_index=node_index,
        metadata={"corp_name": "아모레퍼시픽", "filer_name": filer,
                  "rcept_no": doc_id.rsplit("_", 1)[1], "doc_group": "holding"})


def parse(question=QUESTION, chunks=None, **kw):
    chunks = chunks if chunks is not None else [chunk(HISTORY)]
    return calculator.parse_holding_report(question, chunks, **kw)


def values_by_slot(result) -> dict[str, str]:
    return {v.slot: v.value for v in result.values}


# ---------- 연혁표: 2행 머리글 병합(변형 ③) + 완전 쌍 ----------

def test_full_pair_from_history_table():
    got = parse()
    assert got is not None
    vals = values_by_slot(got)
    assert vals["직전 보고서 보유주식등의 수"] == "2,925,317"
    assert vals["직전 보고서 보유비율"] == "5.00"
    assert vals["이번 보고서 보유주식등의 수"] == "2,263,085"
    assert vals["이번 보고서 보유비율"] == "3.87"
    assert got.missing_slots == ()


def test_change_pair_is_derived_with_sign():
    got = parse()
    by_kind = {(d.kind, d.unit): d for d in got.derived}
    assert by_kind[("holding_change", "주")].value == "-662,232"
    assert by_kind[("holding_change", "%p")].value == "-1.13"


def test_reporter_is_extracted_when_question_asks():
    q = QUESTION.replace("보유주식등의 수와 보유비율은", "보고자와 보유주식등의 수·보유비율은")
    vals = values_by_slot(parse(question=q))
    assert vals["보고자"] == "MassachusettsFinancialServicesCompany"


def test_reporter_not_emitted_unless_asked():
    """질문하지 않은 보고자를 자동 출력하지 않는다(최종 검수 4)."""
    assert "보고자" not in values_by_slot(parse())


def test_reporter_only_question_omits_values():
    q = ("Massachusetts Financial Services Company이(가) 아모레퍼시픽에 대해 제출한 "
         "대량보유상황보고서(보고서작성기준일 2024년 03월 22일)의 보고자 본인 성명은 무엇인가?")
    got = parse(question=q)
    vals = values_by_slot(got)
    assert vals == {"보고자": "MassachusettsFinancialServicesCompany"}
    assert got.derived == () and got.missing_slots == ()


def test_period_filter_prev_only_question():
    q = ("Massachusetts Financial Services Company이(가) 아모레퍼시픽에 대해 제출한 "
         "대량보유상황보고서(보고서작성기준일 2024년 03월 22일)의 직전 보고서 "
         "보유주식등의 수는 몇 주인가?")
    got = parse(question=q)
    vals = values_by_slot(got)
    assert vals["직전 보고서 보유주식등의 수"] == "2,925,317"
    assert "이번 보고서 보유주식등의 수" not in vals   # 묻지 않은 기간은 싣지 않는다
    assert got.missing_slots == ()                     # 요청 밖 자리는 missing도 아니다


# ---------- 고려아연 실물(holding_20240904000440) — 요약표 그룹 분리·표지 보고자 ----------

KZ_NODE0 = (
    "(일반서식 : 자본시장과 금융투자업에 관한 법률 제147조에 의한 보고 중 '경영권에 영향을 주기 위한 목적'의 경우) | (일반서식 : 자본시장과 금융투자업에 관한 법률 제147조에 의한 보고 중 '경영권에 영향을 주기 위한 목적'의 경우) | (일반서식 : 자본시장과 금융투자업에 관한 법률 제147조에 의한 보고 중 '경영권에 영향을 주기 위한 목적'의 경우)\n"
    " |  | \n"
    "금융위원회 귀중 | 보고의무발생일　 : | 2024년 09월 02일\n"
    "한국거래소 귀중 | 보고서작성기준일 : | 2024년 09월 04일\n"
    " | 보고자 : | 최윤범"
)

KZ_NODE1 = (
    "요약정보 | 요약정보 | 요약정보 | 요약정보\n"
    "발행회사명 | 고려아연(주) | 발행회사와의 관계 | 임원(등기)\n"
    "보고구분 | 변동ㆍ변경 | 변동ㆍ변경 | 변동ㆍ변경\n"
    "보유주식등의 수 및 보유비율 |  | 보유주식등의 수 | 보유비율\n"
    "보유주식등의 수 및 보유비율 | 직전 보고서 | 10,071,580 | 48.65\n"
    "보유주식등의 수 및 보유비율 | 이번 보고서 | 10,098,385 | 48.78\n"
    "주요계약체결 주식등의 수 및 비율 |  | 주식등의 수 | 비율\n"
    "주요계약체결 주식등의 수 및 비율 | 직전 보고서 | 291,188 | 1.41\n"
    "주요계약체결 주식등의 수 및 비율 | 이번 보고서 | 291,188 | 1.41\n"
    "의결권의 수 및 보유비율 |  | 의결권의 수 | 보유비율\n"
    "의결권의 수 및 보유비율 | 직전 보고서 | - | -\n"
    "의결권의 수 및 보유비율 | 이번 보고서 | - | -\n"
    "주요계약체결 의결권의 수 및비율 |  | 의결권의 수 | 비율\n"
    "주요계약체결 의결권의 수 및비율 | 직전 보고서 | - | -\n"
    "주요계약체결 의결권의 수 및비율 | 이번 보고서 | - | -\n"
    "보고사유 | - 보유주식수 변동- 보유주식 등에 관한 계약의 변경 | - 보유주식수 변동- 보유주식 등에 관한 계약의 변경 | - 보유주식수 변동- 보유주식 등에 관한 계약의 변경"
)

KZ_DOC = "holding_20240904000440"
KZ_QUESTION = ("고려아연의 2024-09-04 대량보유상황보고서(변동)에서 보고자, 보유주식등의 수ㆍ"
               "보유비율의 직전ㆍ이번 보고서 변화와 보유목적을 알려줘.")


def kz_chunks():
    return [chunk(KZ_NODE0, doc_id=KZ_DOC, chunk_id="kz-c0", filer="최윤범", node_index=0),
            chunk(KZ_NODE1, doc_id=KZ_DOC, chunk_id="kz-c1", filer="최윤범", node_index=1)]


def test_korea_zinc_summary_groups_do_not_conflict():
    """주요계약체결·의결권 그룹이 기본 그룹과 합쳐져 충돌 폐기되던 확정 버그(최종 검수 2)."""
    got = parse(question=KZ_QUESTION, chunks=kz_chunks())
    assert got is not None
    vals = values_by_slot(got)
    assert vals["직전 보고서 보유주식등의 수"] == "10,071,580"
    assert vals["직전 보고서 보유비율"] == "48.65"
    assert vals["이번 보고서 보유주식등의 수"] == "10,098,385"
    assert vals["이번 보고서 보유비율"] == "48.78"
    assert "291,188" not in set(vals.values())          # 주요계약체결 그룹 값 미혼입
    by_unit = {d.unit: d.value for d in got.derived if d.kind == "holding_change"}
    assert by_unit["주"] == "26,805" and by_unit["%p"] == "0.13"


def test_korea_zinc_cover_page_reporter_promoted():
    got = parse(question=KZ_QUESTION, chunks=kz_chunks())
    rep = next(v for v in got.values if v.slot == "보고자")
    assert rep.value == "최윤범"
    assert "보고자" in rep.line and rep.node_index == 0  # 표지 행 provenance


def test_korea_zinc_other_group_rows_are_consumed():
    got = parse(question=KZ_QUESTION, chunks=kz_chunks())
    row = "주요계약체결 주식등의 수 및 비율 | 직전 보고서 | 291,188 | 1.41"
    assert "".join(row.split()) in got.consumed_texts   # 덤프로 재노출 금지


# ---------- 삼성전기 실물(holding_20260220000569) — 신규 보고·표지 전체 보고자·서식 필드 ----------

SE_DOC = "holding_20260220000569"
SE_FULL_REPORTER = "BlackRock Fund Advisors위 대리인  변호사 윤태한               변호사 한병하"
SE_NODE0 = (
    "금융위원회 귀중 | 보고의무발생일　 : | 2026년 02월 12일\n"
    "한국거래소 귀중 | 보고서작성기준일 : | 2026년 02월 12일\n"
    f" | 보고자 : | {SE_FULL_REPORTER}"
)
SE_NODE1 = (
    "요약정보 | 요약정보 | 요약정보 | 요약정보\n"
    "보고특례 적용전문투자자 구분 | - | - | -\n"
    "발행회사명 | 삼성전기(주) | 발행회사와의 관계 | 기타\n"
    "보고구분 | 신규 | 신규 | 신규\n"
    "보유주식등의 수 및 보유비율 |  | 보유주식등의 수 | 보유비율\n"
    "보유주식등의 수 및 보유비율 | 직전 보고서 | - | -\n"
    "보유주식등의 수 및 보유비율 | 이번 보고서 | 3,739,817 | 5.01\n"
    "의결권의 수 및보유비율 |  | 의결권의 수 | 보유비율\n"
    "의결권의 수 및보유비율 | 직전 보고서 | - | -\n"
    "의결권의 수 및보유비율 | 이번 보고서 | - | -\n"
    "보고사유 | - 단순투자목적으로 장내에서 발행회사의 주식 매수 | - 단순투자목적으로 장내에서 발행회사의 주식 매수 | - 단순투자목적으로 장내에서 발행회사의 주식 매수\n"
    "보유목적 | 단순투자 | 단순투자 | 단순투자"
)
# 같은 문서 안의 연혁표 — 과거 이력에 직전 값이 있는 함정(재검수 BLOCKER 2 재현).
SE_HIST = (
    "| 보고서작성기준일 | 보고자 | 보고자 | 주식등 | 주식등 | 주권 | 주권 | 의결권 있는 발행주식총수(주)\n"
    " | 보고서작성기준일 | 본인 성명 | 특별관계자수 | 주식등의 수(주) | 비율(%) | 주식수(주) | 비율(%) | 의결권 있는 발행주식총수(주)\n"
    "직전보고서 | 2026년 01월 02일 | BlackRockFundAdvisors | 13 | 3,730,598 | 4.99 | 3,730,598 | 4.99 | 74,693,696\n"
    "이번보고서 | 2026년 02월 12일 | BlackRockFundAdvisors | 13 | 3,739,817 | 5.01 | 3,739,817 | 5.01 | 74,693,696"
)
SE_QUESTION = ("삼성전기에 대해 2026-02-12 보고서작성기준일로 제출된 주식등의대량보유상황보고서"
               "(약식)에서 보고자, 직전/이번 보고서의 보유주식등의 수ㆍ보유비율과 보유목적은 "
               "각각 무엇인가?")


def se_chunks():
    filer = "BlackRock Fund Advisors"
    return [chunk(SE_NODE0, doc_id=SE_DOC, chunk_id="se-c0", filer=filer, node_index=0),
            chunk(SE_NODE1, doc_id=SE_DOC, chunk_id="se-c1", filer=filer, node_index=1),
            chunk(SE_HIST, doc_id=SE_DOC, chunk_id="se-c2", filer=filer, node_index=9)]


def test_new_report_does_not_backfill_prev_from_history():
    """신규 보고의 직전 '-'는 해당 없음이다 — 연혁표의 과거 값(3,730,598)으로 채우지 않는다."""
    got = parse(question=SE_QUESTION, chunks=se_chunks())
    assert got is not None
    vals = values_by_slot(got)
    assert vals["이번 보고서 보유주식등의 수"] == "3,739,817"
    assert vals["이번 보고서 보유비율"] == "5.01"
    assert vals["직전 보고서 보유주식등의 수"] == "-"
    assert vals["직전 보고서 보유비율"] == "-"
    assert "3,730,598" not in set(vals.values()) and "4.99" not in set(vals.values())
    assert got.derived == ()                            # 직전 없음 — 증감 미계산
    assert got.report_kind == "신규"
    assert any("신규" in n for n in got.notes)


def test_cover_full_reporter_name_beats_history_abbreviation():
    got = parse(question=SE_QUESTION, chunks=se_chunks())
    assert values_by_slot(got)["보고자"] == SE_FULL_REPORTER


def test_purpose_and_report_kind_extracted_from_fixed_fields():
    got = parse(question=SE_QUESTION, chunks=se_chunks())
    vals = values_by_slot(got)
    assert vals["보유목적"] == "단순투자"
    assert vals["보고구분"] == "신규"


def test_explicit_dash_without_new_kind_still_blocks_backfill():
    """보고구분 행이 없어도 요약표의 명시적 '-'는 연혁값 보충을 막는다."""
    node1 = "\n".join(l for l in SE_NODE1.split("\n") if not l.startswith("보고구분"))
    chunks = [chunk(SE_NODE0, doc_id=SE_DOC, chunk_id="se-c0", node_index=0),
              chunk(node1, doc_id=SE_DOC, chunk_id="se-c1", node_index=1),
              chunk(SE_HIST, doc_id=SE_DOC, chunk_id="se-c2", node_index=9)]
    got = parse(question=SE_QUESTION, chunks=chunks)
    vals = values_by_slot(got)
    assert vals["직전 보고서 보유주식등의 수"] == "-"
    assert "3,730,598" not in set(vals.values())


def test_consumed_texts_cover_used_rows_whitespace_normalized():
    got = parse()
    prev_row = "직전보고서 | 2023년 06월 02일 | MassachusettsFinancialServicesCompany | 1 | 2,925,317 | 5.00 | 2,925,317 | 5.00 | 58,492,759"
    assert "".join(prev_row.split()) in got.consumed_texts


def test_evidence_rows_carry_source_provenance():
    got = parse()
    prev = next(v for v in got.values if v.slot == "직전 보고서 보유주식등의 수")
    assert prev.doc_id == MFS_DOC
    assert "2,925,317" in prev.line
    assert prev.node_index == 28


# ---------- 요약표: 라벨 둘째 칸 · 의결권 그룹 배제 · '-' 미사용 ----------

def test_summary_table_doc_extracts_pair():
    chunks = [chunk(SUMMARY, chunk_id="c-sum", node_index=1),
              chunk(BASIS_DATE_LINE, chunk_id="c-base", node_index=0)]
    got = parse(chunks=chunks)
    assert got is not None
    vals = values_by_slot(got)
    assert vals["직전 보고서 보유주식등의 수"] == "2,925,317"
    assert vals["이번 보고서 보유비율"] == "3.87"
    # 의결권 그룹의 '-' 행은 값이 아니다 — 어느 슬롯도 '-'를 담지 않는다.
    assert "-" not in set(vals.values())


def test_summary_and_history_cross_check_conflict_fails_closed():
    conflicting = SUMMARY.replace("2,925,317 | 5.00", "9,999,999 | 9.99")
    chunks = [chunk(HISTORY, chunk_id="c-hist", node_index=28),
              chunk(conflicting, chunk_id="c-sum", node_index=1)]
    assert parse(chunks=chunks) is None


# ---------- 문서 선택 캐스케이드: 기준일·보고자 결박 ----------

def test_other_doc_other_reporter_is_not_mixed_in():
    """MFS 문서에 직전 행이 없어도 국민연금 문서의 쌍으로 빈자리를 채우지 않는다."""
    mfs_partial = "\n".join(l for l in HISTORY.split("\n") if not l.startswith("직전보고서"))
    chunks = [chunk(mfs_partial, chunk_id="c-mfs"),
              chunk(TRAP, doc_id=NPS_DOC, chunk_id="c-nps", filer="국민연금공단")]
    got = parse(chunks=chunks)
    assert got is not None
    vals = values_by_slot(got)
    assert vals["이번 보고서 보유주식등의 수"] == "2,263,085"
    assert "4,329,578" not in set(vals.values())
    assert set(got.missing_slots) == {"직전 보고서 보유주식등의 수", "직전 보고서 보유비율"}
    assert got.derived == ()               # 쌍 미완비 — 증감 미계산


def test_question_basis_date_picks_among_same_reporter_docs():
    later = HISTORY.replace("2024년 03월 22일", "2024년 08월 16일") \
                   .replace("2,263,085", "2,000,000").replace("3.87", "3.42")
    chunks = [chunk(HISTORY, chunk_id="c-a"),
              chunk(later, doc_id="holding_20240820000999", chunk_id="c-b")]
    got = parse(chunks=chunks)
    assert values_by_slot(got)["이번 보고서 보유주식등의 수"] == "2,263,085"


def test_reporter_named_in_question_binds_the_doc():
    q_nps = QUESTION.replace("Massachusetts Financial Services Company", "국민연금공단") \
                    .replace("2024년 03월 22일", "2024년 08월 16일")
    chunks = [chunk(HISTORY, chunk_id="c-mfs"),
              chunk(TRAP, doc_id=NPS_DOC, chunk_id="c-nps", filer="국민연금공단")]
    got = parse(question=q_nps, chunks=chunks)
    assert values_by_slot(got)["이번 보고서 보유주식등의 수"] == "3,744,240"


def test_reporter_mismatch_fails_closed():
    """질문이 보고자를 지목했는데 기준일이 맞는 문서의 보고자가 다르면 미발동."""
    q_wrong = QUESTION.replace("Massachusetts Financial Services Company", "국민연금공단")
    assert parse(question=q_wrong) is None


def test_no_question_date_with_unique_doc_still_parses():
    q = ("Massachusetts Financial Services Company이(가) 아모레퍼시픽에 대해 제출한 "
         "대량보유상황보고서에서 직전 보고서 대비 보유주식등의 수는 얼마나 변동되었는가?")
    got = parse(question=q)
    assert values_by_slot(got)["이번 보고서 보유주식등의 수"] == "2,263,085"


def test_no_question_date_two_docs_fail_closed():
    q = "아모레퍼시픽 대량보유상황보고서에서 보유주식등의 수는 얼마나 변동되었는가?"
    chunks = [chunk(HISTORY, chunk_id="c-a"),
              chunk(TRAP, doc_id=NPS_DOC, chunk_id="c-b", filer="국민연금공단")]
    assert parse(question=q, chunks=chunks) is None


def test_current_report_paren_date_binds_when_no_basis_anchor():
    """질문에 날짜가 여럿이면 '이번보고서(날짜)' 앵커가 기준일이다(gold_b_4 문형)."""
    q = ("아모레퍼시픽의 2024년 4월 3일 주식등의대량보유상황보고서(일반)에서 "
         "직전보고서(2023.06.02) 대비 이번보고서(2024.03.22)의 보유주식등의 수 변동은?")
    later = HISTORY.replace("2023년 06월 02일", "2024년 03월 22일") \
                   .replace("2024년 03월 22일 | Mass", "2024년 06월 30일 | Mass") \
                   .replace("2,925,317 | 5.00 | 2,925,317", "2,263,085 | 3.87 | 2,263,085")
    chunks = [chunk(HISTORY, chunk_id="c-a"),
              chunk(later, doc_id="holding_20240701000777", chunk_id="c-b")]
    got = parse(question=q, chunks=chunks)
    assert got is not None
    assert values_by_slot(got)["이번 보고서 보유주식등의 수"] == "2,263,085"
    assert values_by_slot(got)["직전 보고서 보유주식등의 수"] == "2,925,317"


# ---------- doc_nodes: 검색 청크에 없는 같은 문서의 행을 값 소스로 ----------

def test_doc_nodes_fill_missing_prev_row():
    """직전 행이 검색 청크에 안 뽑혔어도 같은 문서 원문(doc_nodes)에 있으면 완전 쌍."""
    cur_only = "\n".join(l for l in HISTORY.split("\n") if not l.startswith("직전보고서"))
    doc_nodes = {MFS_DOC: [(28, HISTORY)]}
    got = parse(chunks=[chunk(cur_only, chunk_id="c-cur")], doc_nodes=doc_nodes)
    assert got is not None
    assert values_by_slot(got)["직전 보고서 보유주식등의 수"] == "2,925,317"
    assert got.missing_slots == ()
    prev = next(v for v in got.values if v.slot == "직전 보고서 보유주식등의 수")
    assert prev.from_node and prev.node_index == 28


# ---------- 머리글 변형 4종 (§3-4: 정답이거나 fail-closed, 고정 인덱스 금지) ----------

def test_variant_extra_column_still_correct():
    """① 열 하나 추가 — 머리글 이름으로 열을 찾으므로 값이 그대로 맞아야 한다."""
    lines = []
    for ln in HISTORY.split("\n"):
        cells = ln.split("|")
        cells.insert(4, " 취득자금 " if len(lines) < 2 else " 1,000 ")
        lines.append("|".join(cells))
    got = parse(chunks=[chunk("\n".join(lines))])
    assert got is not None
    vals = values_by_slot(got)
    assert vals["직전 보고서 보유주식등의 수"] == "2,925,317"
    assert vals["이번 보고서 보유비율"] == "3.87"


def test_variant_blank_merged_cell_mismatch_fails_closed():
    """② 병합 셀로 머리글 셀 수가 데이터 행과 어긋나면 미발동(잘못된 열 매핑 금지)."""
    lines = HISTORY.split("\n")
    lines[1] = lines[1] + " | "                      # 머리글 2행만 셀 하나 늘어남
    got = parse(chunks=[chunk("\n".join(lines))])
    assert got is None or "직전 보고서 보유주식등의 수" not in values_by_slot(got)


def test_variant_swapped_qty_ratio_columns_still_correct():
    """④ 수량·비율 열 순서가 뒤바뀌어도 머리글 이름(그룹 표식)으로 정답을 찾는다."""
    swapped = (
        "| 보고서작성기준일 | 보고자 | 보고자 | 주식등 | 주식등 | 주권 | 주권 | 의결권 있는 발행주식총수(주)\n"
        " | 보고서작성기준일 | 본인 성명 | 특별관계자수 | 비율(%) | 주식등의 수(주) | 비율(%) | 주식수(주) | 의결권 있는 발행주식총수(주)\n"
        "직전보고서 | 2023년 06월 02일 | MassachusettsFinancialServicesCompany | 1 | 5.00 | 2,925,317 | 5.00 | 2,925,317 | 58,492,759\n"
        "이번보고서 | 2024년 03월 22일 | MassachusettsFinancialServicesCompany | 1 | 3.87 | 2,263,085 | 3.87 | 2,263,085 | 58,492,759"
    )
    got = parse(chunks=[chunk(swapped)])
    assert got is not None
    vals = values_by_slot(got)
    assert vals["직전 보고서 보유주식등의 수"] == "2,925,317"
    assert vals["직전 보고서 보유비율"] == "5.00"


def test_headerless_rows_fail_closed():
    headerless = "\n".join(HISTORY.split("\n")[2:])
    assert parse(chunks=[chunk(headerless)]) is None


# ---------- 변동어 게이트 ----------

def test_values_without_change_word_have_no_derived():
    q = ("Massachusetts Financial Services Company이(가) 아모레퍼시픽에 대해 제출한 "
         "대량보유상황보고서(보고서작성기준일 2024년 03월 22일)의 직전·이번 보고서 "
         "보유주식등의 수와 보유비율은?")
    got = parse(question=q)
    assert len(values_by_slot(got)) >= 4
    assert got.derived == ()


# ---------- describe 자연어화 + validator 정합 ----------

def test_describe_holding_change_reads_naturally():
    got = parse()
    text = calculator.describe(list(got.derived))
    assert "2,925,317에서 2,263,085로 662,232주 감소(증감 -662,232)" in text
    assert "5.00에서 3.87로 1.13%p 감소(증감 -1.13%p)" in text


def test_allowed_numbers_include_signed_and_unsigned_change():
    allowed = calculator.allowed_numbers(list(parse().derived))
    assert "-662,232" in allowed and "662,232" in allowed
    assert "-1.13" in allowed and "1.13" in allowed


def test_describe_and_promoted_rows_pass_validator():
    """§3-6: describe 출력 + 승격 근거로 validate → UNSUPPORTED가 아니어야 한다."""
    got = parse()
    sources = [{"document_id": v.doc_id, "text": v.line, "chunk_id": v.chunk_id,
                "score": 1.0} for v in got.values]
    citations = [{"document_id": v.doc_id, "quote_or_fact": v.line} for v in got.values]
    answer = calculator.describe(list(got.derived)) + "\n" + "\n".join(
        f"- {v.slot}: {v.value}" for v in got.values)
    check = validator.validate(answer, citations, sources,
                               derived=calculator.allowed_numbers(list(got.derived)))
    assert check["status"] != "UNSUPPORTED"
