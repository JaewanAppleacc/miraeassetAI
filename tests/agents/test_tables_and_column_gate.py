"""tables.py(당기/전기·제N기 열 매핑) + FC 기간-열 결합 게이트 — 검수 발견 1 재현 잠금."""
from __future__ import annotations

from dart_detective.agents import tables
from dart_detective import grounded_answer


# ---------- tables: 열 매핑 ----------

def test_year_header_mapping_unchanged():
    lines = ["구분 | 제 49 기 2025.01.01 부터 | 제 48 기 2024.01.01 부터",
             "매출액 | 100 | 90"]
    assert tables.period_columns_of_lines(lines) == {2025: 0, 2024: 1}


def test_relative_header_needs_base_year():
    lines = ["구분 | 당기 | 전기", "매출액 | 100 | 90"]
    assert tables.period_columns_of_lines(lines) == {}
    assert tables.period_columns_of_lines(lines, base_year=2024) == {2024: 0, 2023: 1}


def test_relative_header_dangimal():
    lines = ["구분 | 당기말 | 전기말", "자산총계 | 500 | 400"]
    assert tables.period_columns_of_lines(lines, base_year=2025) == {2025: 0, 2024: 1}


def test_ordinal_header_with_base_year():
    lines = ["구분 | 제 49 기 | 제 48 기 | 제 47 기", "매출액 | 100 | 90 | 80"]
    assert tables.period_columns_of_lines(lines, base_year=2025) == {2025: 0, 2024: 1, 2023: 2}


def test_row_label_danggi_is_not_header():
    # "당기순이익"은 행 레이블 — 머리글 셀로 오인하면 안 된다.
    lines = ["구분 | 금액", "당기순이익 | 100"]
    assert tables.period_columns_of_lines(lines, base_year=2024) == {}


# ---------- FC 게이트: 기간-열 결합 ----------

# 맨숫자 머리글("2024 | 2023")은 데이터 행과 구분이 안 돼 의도적으로 안 읽는다(보수 설계).
_CHUNK = "구분 | 2024년 | 2023년\n매출액 | 100 | 90"
_DOC = "d1"


def _validate(claim):
    squashed = {_DOC: grounded_answer._squash(_CHUNK)}
    return grounded_answer.validate_claim(
        claim, squashed, {_DOC: {"base_year": 2024}}, set(),
        doc_chunks={_DOC: [_CHUNK]})


def test_column_mismatch_drops_swapped_claim():
    # 검수 재현: 2023년 열의 90을 인용하고 "2024년 매출액은 90"이라 주장 — 종전엔 SUPPORTED.
    ok, fails = _validate({"text": "2024년 매출액은 90이다", "value": "90",
                           "period": "2024", "doc_id": _DOC, "quote": "매출액 | 100 | 90"})
    assert not ok
    assert any(f.startswith("period_bound:column_mismatch:2024") for f in fails)


def test_correct_column_passes():
    ok, fails = _validate({"text": "2024년 매출액은 100이다", "value": "100",
                           "period": "2024", "doc_id": _DOC, "quote": "매출액 | 100 | 90"})
    assert ok, fails


def test_single_year_chunk_skips_column_check():
    chunk = "매출액 | 90\n(2023년 기준)"
    squashed = {_DOC: grounded_answer._squash(chunk)}
    ok, fails = grounded_answer.validate_claim(
        {"text": "2023년 매출액은 90이다", "value": "90", "period": "2023",
         "doc_id": _DOC, "quote": "매출액 | 90"},
        squashed, {_DOC: {}}, set(), doc_chunks={_DOC: [chunk]})
    assert ok, fails


def test_two_year_value_claim_pair_verification():
    """검수 4차 발견 2 + judge10 교정: 다연도 값 claim은 (기간, 값) 쌍을 표 열과 대조한다 —
    옳게 결합된 claim은 통과(일괄 폐기는 대량보유 계열 정답까지 버렸다), 스왑만 폐기."""
    ok, fails = _validate({"text": "2024년 매출 100은 2023년 90보다 크다", "value": "100",
                           "period": None, "doc_id": _DOC, "quote": "매출액 | 100 | 90"})
    assert ok, fails
    ok, fails = _validate({"text": "2024년 매출액 90은 2023년 매출액 100보다 작다", "value": "90",
                           "period": None, "doc_id": _DOC, "quote": "매출액 | 100 | 90"})
    assert not ok
    assert any("unsplit" in f for f in fails), fails


def test_two_year_value_claim_outside_table_also_split_enforced():
    # 5차 정책 변경: 문단 인용이라도 다연도+다숫자 재구성 문장은 폐기한다(스왑과 구분 불가).
    # 원문 그대로 재인용하는 예외는 test_multi_period_numeric_claim_is_split_enforced가 잠근다.
    chunk = "2024년 매출은 100이고 2023년 매출은 90이었다."
    squashed = {_DOC: grounded_answer._squash(chunk)}
    ok, fails = grounded_answer.validate_claim(
        {"text": "2024년 매출 100은 2023년 90보다 크다", "value": "100", "period": None,
         "doc_id": _DOC, "quote": chunk},
        squashed, {_DOC: {}}, set(), doc_chunks={_DOC: [chunk]})
    assert not ok and "period_bound:multi_period_claim_unsplit" in fails


def test_question_date_token_cannot_become_a_value():
    """검수 4·5차 발견 1: 질문 날짜 숫자를 값으로도, **다른 날짜형 의미로도** 전용 불가."""
    q = "2024년 3월 22일 계약금액은 얼마인가?"
    for text, tok in (("매출액은 22이다", "22"),            # 값으로 전용
                      ("계약기간은 22일", "22")):           # 날짜형 의미 전용(5차 재현)
        ok, fails = grounded_answer.validate_claim(
            {"text": text, "value": None, "period": None,
             "doc_id": _DOC, "quote": "계약금액 | 100"},
            {_DOC: grounded_answer._squash("계약금액 | 100")}, {_DOC: {}}, set(), question=q)
        assert not ok and any(f.startswith(f"numbers_bound:{tok}") for f in fails), (text, fails)
    # 표현 전체를 그대로 반복하면 허용(원래 오탐 교정 취지 유지).
    ok, fails = grounded_answer.validate_claim(
        {"text": "2024년 3월 22일 기준 계약금액은 100이다", "value": "100", "period": None,
         "doc_id": _DOC, "quote": "계약금액 | 100"},
        {_DOC: grounded_answer._squash("계약금액 | 100")}, {_DOC: {}}, set(), question=q)
    assert ok, fails


def test_relative_header_swap_caught_with_base_year():
    chunk = "구분 | 당기 | 전기\n영업이익 | 70 | 60\n(제49기 2024년, 제48기 2023년)"
    squashed = {_DOC: grounded_answer._squash(chunk)}
    ok, fails = grounded_answer.validate_claim(
        {"text": "2024년 영업이익은 60이다", "value": "60", "period": "2024",
         "doc_id": _DOC, "quote": "영업이익 | 70 | 60"},
        squashed, {_DOC: {"base_year": 2024}}, set(), doc_chunks={_DOC: [chunk]})
    assert not ok
    assert any("column_mismatch" in f for f in fails)


def test_relative_header_swap_caught_without_explicit_years():
    """검수 3차 발견 1 재현: 명시 연도가 없는 당기/전기·제N기 표도 열 오귀속을 잡아야 한다."""
    for header in ("구분 | 당기 | 전기", "구분 | 제 49 기 | 제 48 기"):
        chunk = f"{header}\n매출액 | 100 | 90"
        squashed = {_DOC: grounded_answer._squash(chunk)}
        ok, fails = grounded_answer.validate_claim(
            {"text": "2024년 매출액은 90이다", "value": "90", "period": "2024",
             "doc_id": _DOC, "quote": "매출액 | 100 | 90"},
            squashed, {_DOC: {"base_year": 2024, "rcept_dt": "20240515"}},
            set(), doc_chunks={_DOC: [chunk]})
        assert not ok, header
        assert any("column_mismatch" in f for f in fails), (header, fails)


def test_question_echo_number_is_not_allowed_as_claim_value():
    """검수 3차 발견 2 재현: 질문의 임의 숫자(999)를 문장으로 반복해도 날조로 잡아야 한다."""
    chunk = "매출액 | 100"
    assert "999" not in grounded_answer.question_context_numbers("매출액이 999인가?")
    ok, fails = grounded_answer.validate_claim(
        {"text": "매출액은 999이다", "value": None, "period": None,
         "doc_id": _DOC, "quote": "매출액 | 100"},
        {_DOC: grounded_answer._squash(chunk)}, {_DOC: {}}, set(),
        question="매출액이 999인가?", doc_chunks={_DOC: [chunk]})
    assert not ok and any(f.startswith("numbers_bound:999") for f in fails)
    # 날짜·기수 표현을 통째로 반복하면 여전히 허용된다(원래 오탐 교정 취지 유지).
    allowed = grounded_answer.context_number_allowance(
        "2024년 3월 22일 기준 제3회차 전환사채의 발행 목적은?",
        "2024년 3월 22일 기준 제3회차 전환사채이다")
    assert {"3", "22"} <= allowed


def test_multi_period_numeric_claim_is_split_enforced():
    """검수 5차 발견 2: 다연도+다숫자 claim은 value 유무·표/문장 무관 폐기(분리 강제).
    예외는 원문 문장을 그대로 옮긴 경우뿐 — 순서가 원문에서 오므로 스왑 불가."""
    chunk = "구분 | 2024년 | 2023년\n매출액 | 100 | 90"
    ok, fails = grounded_answer.validate_claim(
        {"text": "2024년 매출액은 90이고 2023년 매출액은 100이다", "value": None, "period": None,
         "doc_id": _DOC, "quote": "매출액 | 100 | 90"},
        {_DOC: grounded_answer._squash(chunk)}, {_DOC: {}}, set(), doc_chunks={_DOC: [chunk]})
    assert not ok and "period_bound:multi_period_claim_unsplit" in fails
    prose = "2024년 매출은 100이고 2023년 매출은 90이었다."
    ok, fails = grounded_answer.validate_claim(
        {"text": "2024년 매출은 90이고 2023년 매출은 100이었다", "value": None, "period": None,
         "doc_id": _DOC, "quote": prose},
        {_DOC: grounded_answer._squash(prose)}, {_DOC: {}}, set(), doc_chunks={_DOC: [prose]})
    assert not ok and "period_bound:multi_period_claim_unsplit" in fails
    # 원문 그대로 재인용은 허용.
    ok, fails = grounded_answer.validate_claim(
        {"text": "2024년 매출은 100이고 2023년 매출은 90이었다", "value": None, "period": None,
         "doc_id": _DOC, "quote": prose},
        {_DOC: grounded_answer._squash(prose)}, {_DOC: {}}, set(), doc_chunks={_DOC: [prose]})
    assert ok, fails


def test_date_expression_matches_across_formats():
    """자체 검수: 같은 날짜의 표기 변형("2024-03-22" ↔ "2024년 3월 22일")은 동치로 허용,
    부분 표현("22일")은 숫자 구성이 달라 불허."""
    allowed = grounded_answer.context_number_allowance(
        "2024-03-22 기준 보유비율은?", "2024년 3월 22일 기준으로 5.5%다")
    assert {"3", "22"} <= allowed
    assert grounded_answer.context_number_allowance(
        "2024-03-22 기준 보유비율은?", "계약기간은 22일") == set()


def test_context_expression_keys_preserve_kind_and_position():
    """검수 6차 발견 1: 숫자 집합 동치는 '제3기'↔'3일', '3월 22일'↔'22월 3일'을 통과시켰다."""
    assert grounded_answer.context_number_allowance("제3기 계약금액은?", "계약기간은 3일") == set()
    assert grounded_answer.context_number_allowance(
        "2024년 3월 22일 계약금액은?", "기준일은 2024년 22월 3일이다") == set()
    # 종류·자리가 같으면 표기 변형은 동치.
    assert {"3", "22"} <= grounded_answer.context_number_allowance(
        "2024-03-22 계약금액은?", "2024년 3월 22일 기준이다")
    assert {"3"} <= grounded_answer.context_number_allowance("제3기 실적은?", "제 3 기 실적이다")


def test_relative_period_swap_and_single_relative_binding():
    """검수 6차 발견 2 + 자체 대칭 구멍: 당기/전기·제N기·분기 스왑과 단일 당기 오귀속."""
    chunk = "구분 | 당기 | 전기\n매출액 | 100 | 90"
    sq = grounded_answer._squash
    ok, fails = grounded_answer.validate_claim(
        {"text": "당기 매출액은 90이고 전기 매출액은 100이다", "value": None, "period": None,
         "doc_id": _DOC, "quote": "매출액 | 100 | 90"},
        {_DOC: sq(chunk)}, {_DOC: {"base_year": 2024}}, set(), doc_chunks={_DOC: [chunk]})
    assert not ok and "period_bound:multi_period_claim_unsplit" in fails
    ok, fails = grounded_answer.validate_claim(
        {"text": "당기 매출액은 90이다", "value": "90", "period": None,
         "doc_id": _DOC, "quote": "매출액 | 100 | 90"},
        {_DOC: sq(chunk)}, {_DOC: {"base_year": 2024}}, set(), doc_chunks={_DOC: [chunk]})
    assert not ok and any("column_mismatch" in f for f in fails)
    ok, fails = grounded_answer.validate_claim(
        {"text": "당기 매출액은 100이다", "value": "100", "period": None,
         "doc_id": _DOC, "quote": "매출액 | 100 | 90"},
        {_DOC: sq(chunk)}, {_DOC: {"base_year": 2024}}, set(), doc_chunks={_DOC: [chunk]})
    assert ok, fails
    # "당기순이익"은 기간 토큰이 아니다 — 행 레이블 오탐 방지.
    assert "당기" not in grounded_answer._period_tokens("당기순이익은 100이다")


def test_token_column_binding_for_non_year_headers():
    """검수 7차 발견 2: 제N기·Q1·1H·전년 동기 머리글 표의 단일 기간 claim 열 결박."""
    cases = (("제49기 매출액은 90이다", "구분 | 제 49 기 | 제 48 기"),
             ("Q1 매출액은 90이다", "구분 | Q1 | Q2"),
             ("1H 매출액은 90이다", "구분 | 1H | 2H"))
    for text, header in cases:
        chunk = f"{header}\n매출액 | 100 | 90"
        ok, fails = grounded_answer.validate_claim(
            {"text": text, "value": "90", "period": None, "doc_id": _DOC,
             "quote": "매출액 | 100 | 90"},
            {_DOC: grounded_answer._squash(chunk)}, {_DOC: {"base_year": 2024}}, set(),
            question=text.split()[0] + " 매출은?", doc_chunks={_DOC: [chunk]})
        assert not ok and any("column_mismatch" in f for f in fails), (text, fails)
    # 전년 동기 다기간은 분리 강제.
    chunk = "구분 | 당기 | 전년 동기\n매출액 | 100 | 90"
    ok, fails = grounded_answer.validate_claim(
        {"text": "당기 90, 전년 동기 100", "value": None, "period": None, "doc_id": _DOC,
         "quote": "매출액 | 100 | 90"},
        {_DOC: grounded_answer._squash(chunk)}, {_DOC: {"base_year": 2024}}, set(),
        doc_chunks={_DOC: [chunk]})
    assert not ok and "period_bound:multi_period_claim_unsplit" in fails


def test_generated_answer_sentence_gate_catches_json_swap():
    """검수 7차 발견 1: FC 실패 후 JSON 답변도 문장 단위 기간-값 결박을 통과해야 채택된다."""
    table = "구분 | 2024년 | 2023년\n매출액 | 100 | 90"
    cits = [{"document_id": _DOC, "quote_or_fact": "매출액 | 100 | 90"}]
    fails = grounded_answer.check_generated_answer(
        "2024년 매출액은 90이다.", cits, {_DOC: [table]}, {_DOC: {}}, question="2024년 매출액은?")
    assert fails and "column_mismatch" in fails[0]
    assert grounded_answer.check_generated_answer(
        "2024년 매출액은 100이다.", cits, {_DOC: [table]}, {_DOC: {}},
        question="2024년 매출액은?") == []
    # FC 조립 답변(인라인 출처 포함)은 오탐 없이 통과해야 한다 — 중첩 괄호 공시명 포함.
    ans = "2024년 매출액은 100이다 (사업보고서 (2024.12), 접수번호 20250318000001, 2025-03-18)."
    assert grounded_answer.check_generated_answer(
        ans, cits, {_DOC: [table]}, {_DOC: {}}, question="2024년 매출액은?") == []


def test_period_token_canonicalization():
    """검수 8차 발견 2: 머리글 '직전 사업연도'와 claim '전기', 'Q1'과 '1분기'는 같은 기간."""
    n = tables._norm_period_token
    assert n("직전 사업연도") == n("전기") == "전기"
    assert n("이번사업연도") == n("당기") == n("당기말") == "당기"
    assert n("1분기") == n("Q1") == n("1Q") == "q1"
    assert n("상반기") == n("1H") == "h1" and n("하반기") == "h2"
    assert n("제 49 기") == "제49기" and n("2024년") == "2024"


def test_single_token_claim_fails_closed_when_column_unresolved():
    """검수 8차 발견 2: 다기간 표인데 토큰이 어느 열에도 안 붙으면 통과가 아니라 폐기."""
    t2 = "구분 | 이번 사업연도 | 직전 사업연도\n매출액 | 100 | 90"
    ok, fails = grounded_answer.validate_claim(
        {"text": "직전 사업연도 매출액은 100이다", "value": "100", "period": None,
         "doc_id": _DOC, "quote": "매출액 | 100 | 90"},
        {_DOC: grounded_answer._squash(t2)}, {_DOC: {}}, set(), doc_chunks={_DOC: [t2]})
    assert not ok and any("column_mismatch" in f for f in fails)
    ok, fails = grounded_answer.validate_claim(
        {"text": "직전 사업연도 매출액은 90이다", "value": "90", "period": None,
         "doc_id": _DOC, "quote": "매출액 | 100 | 90"},
        {_DOC: grounded_answer._squash(t2)}, {_DOC: {}}, set(), doc_chunks={_DOC: [t2]})
    assert ok, fails
    # 인식된 토큰이 표의 어떤 열도 아니면 fail-closed.
    t3 = "구분 | Q1 | Q2\n매출액 | 100 | 90"
    ok, fails = grounded_answer.validate_claim(
        {"text": "전년동기 매출액은 100이다", "value": "100", "period": None,
         "doc_id": _DOC, "quote": "매출액 | 100 | 90"},
        {_DOC: grounded_answer._squash(t3)}, {_DOC: {}}, set(), doc_chunks={_DOC: [t3]})
    assert not ok and any("period_unbound" in f for f in fails)


def test_sentence_gate_requires_per_number_citation_binding():
    """검수 8차 발견 1: 숫자 없는 인용·정답 숫자 섞기로 문장 게이트를 우회할 수 없다."""
    table = "구분 | 2024년 | 2023년\n매출액 | 100 | 90\n회사명 | HMM"
    assert grounded_answer.check_generated_answer(
        "2024년 매출액은 90이다.", [{"document_id": _DOC, "quote_or_fact": "회사명 | HMM"}],
        {_DOC: [table]}, {_DOC: {}})
    assert grounded_answer.check_generated_answer(
        "2024년 매출액은 90 또는 100이다.",
        [{"document_id": _DOC, "quote_or_fact": "매출액 | 100 | 90"}], {_DOC: [table]}, {_DOC: {}})
    assert grounded_answer.check_generated_answer(
        "2024년 매출액은 100이다.",
        [{"document_id": _DOC, "quote_or_fact": "매출액 | 100 | 90"}], {_DOC: [table]}, {_DOC: {}}) == []


def test_sentence_gate_rejects_same_number_from_unrelated_row():
    """숫자만 같은 다른 행은 기간-열 결박의 근거가 아니다.

    2023년 열의 90을 ``기타`` 행에서 다시 인용하면 종전 구현은 표 행을 특정하지
    못했다는 이유로 검증 성공(None)으로 취급해, 2024년 매출액 90을 채택했다.
    """
    table = "구분 | 2024년 | 2023년\n매출액 | 100 | 90\n기타 | 90"
    wrong_citation = [{"document_id": _DOC, "quote_or_fact": "기타 | 90"}]
    assert grounded_answer.check_generated_answer(
        "2024년 매출액은 90이다.", wrong_citation, {_DOC: [table]}, {_DOC: {}})

    # 표가 아닌 원문 문장을 그대로 답한 경우까지 막아서는 안 된다.
    prose = "2024년 매출액은 100이다."
    assert grounded_answer.check_generated_answer(
        prose, [{"document_id": _DOC, "quote_or_fact": prose}],
        {_DOC: [prose]}, {_DOC: {}}) == []


def test_column_gate_compares_complete_numeric_tokens():
    """값 90은 같은 문자열을 포함하는 190과 같은 숫자가 아니다."""
    table = "구분 | 2024년 | 2023년\n매출액 | 190 | 90"
    citation = [{"document_id": _DOC, "quote_or_fact": "매출액 | 190 | 90"}]
    assert grounded_answer.check_generated_answer(
        "2024년 매출액은 90이다.", citation, {_DOC: [table]}, {_DOC: {}})

    ok, fails = grounded_answer.validate_claim(
        {"text": "2024년 매출액은 90이다", "value": "90", "period": "2024",
         "doc_id": _DOC, "quote": "매출액 | 190 | 90"},
        {_DOC: grounded_answer._squash(table)}, {_DOC: {}}, set(),
        doc_chunks={_DOC: [table]})
    assert not ok and any("column_mismatch" in f for f in fails)


def test_column_gate_binds_explicit_metric_to_cited_row():
    """기간 열의 숫자가 맞아도 다른 지표 행을 인용하면 안 된다."""
    table = ("구분 | 2024년 | 2023년\n"
             "매출액 | 100 | 90\n"
             "영업이익 | 90 | 80")
    wrong_row = [{"document_id": _DOC, "quote_or_fact": "영업이익 | 90 | 80"}]
    assert grounded_answer.check_generated_answer(
        "2024년 매출액은 90이다.", wrong_row, {_DOC: [table]}, {_DOC: {}})

    ok, fails = grounded_answer.validate_claim(
        {"text": "2024년 매출액은 90이다", "value": "90", "period": "2024",
         "doc_id": _DOC, "quote": "영업이익 | 90 | 80"},
        {_DOC: grounded_answer._squash(table)}, {_DOC: {}}, set(),
        doc_chunks={_DOC: [table]})
    assert not ok and any("row_mismatch" in f for f in fails)

    correct_row = [{"document_id": _DOC, "quote_or_fact": "매출액 | 100 | 90"}]
    assert grounded_answer.check_generated_answer(
        "2024년 매출액은 100이다.", correct_row, {_DOC: [table]}, {_DOC: {}}) == []

    # 한 행 라벨이 다른 라벨의 부분문자열이어도 더 구체적인 명시 지표에 결박한다.
    nested = ("구분 | 2024년 | 2023년\n"
              "매출액 | 5 | 4\n"
              "매출액증가율 | 5 | 3")
    assert grounded_answer.check_generated_answer(
        "2024년 매출액증가율은 5이다.",
        [{"document_id": _DOC, "quote_or_fact": "매출액 | 5 | 4"}],
        {_DOC: [nested]}, {_DOC: {}})
