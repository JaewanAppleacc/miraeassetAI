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


def test_reporter_is_extracted_from_current_row():
    got = parse()
    vals = values_by_slot(got)
    assert vals["보고자"] == "MassachusettsFinancialServicesCompany"


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
