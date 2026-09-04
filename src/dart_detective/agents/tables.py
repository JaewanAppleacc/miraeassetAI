"""표 머리글 판독 — 연도·당기/전기/제N기 열 매핑과 값 칸 추출.

qa_agent(근거 선발)와 grounded_answer(FC claim 기간-열 게이트)가 같이 쓴다.
qa_agent가 갖고 있던 로직을 그대로 옮기고, 당기/전기·제N기 매핑을 더했다
(검수 발견 1·개선 P3: 연도 머리글이 없는 비교표에서 열 오선택이 SUPPORTED로 통과하던 구멍).

판독이 애매하면(같은 연도가 여러 열, 머리글 없음) 빈 dict를 돌려준다 —
잘못된 매핑보다 빈 근거가 낫다는 원칙은 그대로다.
"""
from __future__ import annotations

import re
from typing import Sequence

# 표 머리글에서 기간을 읽는다. "제 49 기 2025.01.01 부터 ..." / "(2025.01.01.~ 2025.12.31)"
_PERIOD_YEAR_RE = re.compile(r"(?:제\s*\d+\s*기[^|]*?)?((?:19|20)\d{2})\s*[.년]\s*\d{1,2}")
# "2025년 반기"처럼 년 뒤에 숫자가 없는 표기(반기보고서 머리글, Q10 실측).
# 한 줄에 이런 셀이 2개 이상일 때만 머리글로 인정한다 — 각주("주) 2025년 이후 …")는
# 셀이 하나라 여기 걸리지 않는다.
_PERIOD_YEAR_LOOSE_RE = re.compile(r"(?:제\s*\d+\s*기[^|]*?)?((?:19|20)\d{2})\s*(?:[.년]\s*\d{1,2}|년)")
_VALUE_RE = re.compile(r"\d[\d,]*")
# 당기/전기 계열 머리글 셀. "당기순이익" 같은 행 레이블과 섞이지 않게 셀 전체 일치만 본다.
_RELATIVE_PERIOD_RE = re.compile(r"(당기|전기|전전기)(말)?")
_RELATIVE_OFFSET = {"당기": 0, "전기": 1, "전전기": 2}
# "제 49 기" / "제49기(당기)" — 숫자 기수 머리글. base_year와 결합해야 연도가 된다.
_ORDINAL_PERIOD_RE = re.compile(r"제\s*(\d+)\s*기(말)?\s*(?:\((당기|전기|전전기)\))?")


def _is_data_row(cells: Sequence[str]) -> bool:
    return len(cells) > 1 and sum(
        1 for c in cells if _VALUE_RE.fullmatch(c.replace(",", ""))) >= 2


def _relative_header(cells: Sequence[str], base_year: int | None) -> list[int]:
    """당기/전기/전전기(또는 제N기) 머리글 셀 → 연도 목록(열 순서). 못 읽으면 []."""
    words: list[int] = []
    ordinals: list[int] = []
    for cell in cells:
        c = cell.strip()
        if not c:
            continue
        m = _RELATIVE_PERIOD_RE.fullmatch(c)
        if m:
            words.append(_RELATIVE_OFFSET[m.group(1)])
            continue
        m = _ORDINAL_PERIOD_RE.fullmatch(c)
        if m:
            ordinals.append(int(m.group(1)))
    if base_year is None or not isinstance(base_year, int):
        return []
    if len(words) >= 2:
        return [base_year - off for off in words]
    if len(ordinals) >= 2:
        top = max(ordinals)             # 최신 기수 = 문서 기준연도
        return [base_year - (top - n) for n in ordinals]
    return []


def period_columns_of_lines(lines: Sequence[str],
                            base_year: int | None = None) -> dict[int, int]:
    """표 머리글을 읽어 {연도: 값 열 번호(0부터)}를 만든다.

    왜 필요한가: 청크 본문에 "2025"라는 글자가 있다는 이유만으로 그 청크를 2025년 값으로
    쓰면, 2023년 사업보고서(비교 열에 2023/2022/2021이 있는 표)가 2025 자리에 들어간다.
    연도 표기가 없는 당기/전기/제N기 머리글은 base_year(문서 기준연도)로 환산한다.
    """
    order: list[int] = []
    for line in lines:
        cells = [c.strip() for c in line.split("|")]
        if _is_data_row(cells):
            continue                      # 데이터 행은 머리글이 아니다
        found: list[int] = []
        loose: list[int] = []
        for cell in cells:
            m = _PERIOD_YEAR_RE.search(cell)
            if m:
                found.append(int(m.group(1)))
            lm = _PERIOD_YEAR_LOOSE_RE.search(cell)
            if lm:
                loose.append(int(lm.group(1)))
        if len(cells) > 1 and len(loose) > 1:
            # 한 줄에 여러 기간 셀 — 라벨 칸을 뺀 순서가 곧 값 열 순서다.
            # 이 다중 셀 머리글에서만 "2025년"식 표기를 인정한다.
            order = loose
            break
        if not found and len(cells) > 1:
            rel = _relative_header(cells, base_year)
            if rel:
                order = rel
                break
        if found:
            order.extend(found)
    if not order:
        return {}
    mapping: dict[int, int] = {}
    for idx, year in enumerate(order):
        if year in mapping:               # 같은 연도가 두 열에 — 애매하면 포기
            return {}
        mapping[year] = idx
    return mapping


# 기간 머리글 셀로 인정하는 형태(정규화 후 fullmatch). 연도 표기는 period_columns_of_lines가
# 따로 다루고, 여기는 연도로 환산되지 않는 토큰(제N기·분기·전년 동기·영문 Q/H 등)까지 —
# 검수 7차 발견 2: 연도 매핑이 안 되는 표에서 단일 기간 claim의 열 결박이 없었다.
_PERIOD_CELL_RES = tuple(re.compile(p) for p in (
    r"(당기|전기|전전기)(말)?",
    r"제?\d{1,3}기(말)?",
    r"q[1-4]|[1-4]q|[1-4]분기",
    r"h[12]|[12]h|상반기|하반기|반기",
    r"전년동기|전년도|전년",
    r"(직전|이번)보고서",
    r"((?:19|20)\d{2})년?",
))


def _norm_period_token(s: str) -> str:
    return re.sub(r"\s+", "", s).lower().rstrip("말")


def period_token_columns(lines: Sequence[str]) -> dict[str, int]:
    """머리글에서 {정규화 기간 토큰: 값 열 번호}를 만든다 — 연도 환산이 불가능한 표용.

    한 줄에 기간형 셀이 2개 이상일 때만 머리글로 인정한다(연도 매핑과 같은 원칙).
    같은 토큰이 두 열이면 애매하므로 포기한다.
    """
    for line in lines:
        cells = [c.strip() for c in line.split("|")]
        if _is_data_row(cells) or len(cells) < 2:
            continue
        mapping: dict[str, int] = {}
        idx = 0
        matched = 0
        for cell in cells:
            norm = _norm_period_token(cell)
            if not norm:
                continue
            if any(rx.fullmatch(norm) for rx in _PERIOD_CELL_RES):
                if norm in mapping:
                    return {}
                mapping[norm] = idx
                matched += 1
                idx += 1
        if matched >= 2:
            return mapping
    return {}


def value_at(line: str, column: int) -> str | None:
    """표 행에서 지정한 값 열의 숫자. 라벨 칸(첫 칸)은 세지 않는다."""
    cells = [c.strip() for c in line.split("|")]
    if len(cells) <= column + 1:
        return None
    cell = cells[column + 1]
    return cell if _VALUE_RE.search(cell) else None
