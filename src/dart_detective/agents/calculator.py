"""계산형 질문의 산술을 **코드가** 수행한다. LLM은 계산하지 않는다.

왜 필요한가: Q12 실호출에서 HyperCLOVA X가 올바른 원문 행 4개를 인용하고도
증가율을 2.95% / 46.67%로 계산했다(정답 3.15% / 46.28%). 그리고 Validator는 원문에
없는 숫자를 거부하므로 계산 답변은 어차피 폐기된다. 그래서 **원본 숫자 선택은
Selector가, 산술은 여기서** 한다.

원칙:
  · 계산 결과는 evidence가 아니다. 원문 행은 evidence, 계산값은 derived로 분리한다.
  · 질문 유형을 결정론적으로 확신할 수 없으면 계산하지 않는다(추측 금지).
  · 기준값이 0이거나 단위가 섞이면 계산하지 않는다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Mapping, Sequence

# 이 표현이 없으면 계산형으로 보지 않는다. 새 분류기(LLM)를 만들지 않는다.
COMPARISON_WORDS = (
    "증가율", "감소율", "증감률", "증감", "증가액", "감소액", "증가", "감소",
    "퍼센트", "%", "차이", "변화", "변했", "비교",
    # Phase1 실측: "2023년과 2025년 사이에 얼마나 변동했는가" 12문항이 전부 계산기를
    # 못 깨웠다 — "변동했"은 "변했"과 다르다.
    "변동", "얼마나",
)
# 백분율 반올림 자릿수. 팀 공통 Gold의 scoring_spec이 rounding=3, tolerance=0.001을
# 쓰므로 3자리로 맞춘다 — 2자리로 자르면 반올림 차이만으로 오답이 된다(3.15 vs 3.145).
PERCENT_DECIMALS = 3
# 사람이 읽는 문장에는 2자리가 자연스럽다("3.15% 변동"). 채점·API에는 3자리 원값을
# 그대로 쓰고, 표시만 줄인다 — 두 표기 모두 같은 계산에서 나온 값이다.
DISPLAY_DECIMALS = 2


def display_value(d: "Derived") -> str:
    """사람에게 보여줄 표기. 백분율만 표시 자릿수로 줄이고 나머지는 원값 그대로."""
    if d.unit != "%":
        return d.value
    try:
        rounded = Decimal(d.value).quantize(
            Decimal("1." + "0" * DISPLAY_DECIMALS), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        return d.value
    return f"{rounded}"
_NUM_RE = re.compile(r"-?\d[\d,]*(?:\.\d+)?")
_UNIT_RE = re.compile(r"단위\s*[::]\s*([^\s|)]+)")


@dataclass(frozen=True)
class Derived:
    """코드가 만든 값. evidence와 절대 섞지 않는다."""
    metric: str
    kind: str                        # "increase_rate" | "increase_amount"
    formula: str
    value: str
    unit: str
    source_slots: tuple[str, ...]
    source_values: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {"metric": self.metric, "kind": self.kind, "formula": self.formula,
                "value": self.value, "unit": self.unit,
                "source_slots": list(self.source_slots),
                "source_values": list(self.source_values)}


def is_comparison_question(question: str) -> bool:
    return any(w in question for w in COMPARISON_WORDS)


def parse_number(text: str) -> Decimal | None:
    """표 셀에서 숫자를 읽는다. 괄호는 음수로 본다(회계 표기)."""
    if text is None:
        return None
    raw = text.strip()
    negative = raw.startswith("(") and raw.endswith(")")
    m = _NUM_RE.search(raw)
    if not m:
        return None
    try:
        value = Decimal(m.group().replace(",", ""))
    except InvalidOperation:
        return None
    return -value if negative else value


def unit_of(line: str) -> str:
    """행/표에 적힌 단위. 못 찾으면 빈 문자열."""
    m = _UNIT_RE.search(line or "")
    return m.group(1) if m else ""


def plan_comparisons(question: str,
                     slots: Sequence[str]) -> list[tuple[str, int, int]]:
    """(지표, 이전 연도, 이후 연도) 목록. 확신할 수 없으면 빈 목록.

    slot 이름(지표_연도)만 본다 — 질문에서 유형을 새로 추론하지 않는다.
    """
    if not is_comparison_question(question):
        return []
    by_metric: dict[str, list[int]] = {}
    for slot in slots:
        m = re.fullmatch(r"(.+)_((?:19|20)\d{2})", slot)
        if m:
            by_metric.setdefault(m.group(1), []).append(int(m.group(2)))
    out = []
    for metric, years in by_metric.items():
        uniq = sorted(set(years))
        if len(uniq) >= 2:
            out.append((metric, uniq[0], uniq[-1]))
    return out


def _fmt(value: Decimal) -> str:
    return f"{value:,}"


def compute(metric: str, old_slot: str, old_raw: str,
            new_slot: str, new_raw: str,
            unit: str = "") -> list[Derived]:
    """증감액과 증감률을 만든다. 계산할 수 없으면 빈 목록."""
    old, new = parse_number(old_raw), parse_number(new_raw)
    if old is None or new is None or old == 0:
        return []
    diff = new - old
    rate = (diff / old * Decimal(100)).quantize(
        Decimal("1." + "0" * PERCENT_DECIMALS), rounding=ROUND_HALF_UP)
    slots = (old_slot, new_slot)
    values = (_fmt(old), _fmt(new))
    out = [
        Derived(metric=metric, kind="increase_amount",
                formula=f"{_fmt(new)} - {_fmt(old)}",
                value=_fmt(diff), unit=unit, source_slots=slots, source_values=values),
        Derived(metric=metric, kind="increase_rate",
                formula=f"({_fmt(new)} - {_fmt(old)}) / {_fmt(old)} × 100",
                value=f"{rate}", unit="%", source_slots=slots, source_values=values),
    ]
    out.extend(million_conversion(metric, old, new, diff, unit, slots))
    return out


MILLION = Decimal(1_000_000)
MILLION_MIN = Decimal(10_000_000)   # 이보다 작은 값은 이미 백만원 단위 표일 가능성이 크다


def million_conversion(metric: str, old: Decimal, new: Decimal, diff: Decimal,
                       unit: str, slots: tuple[str, str]) -> list[Derived]:
    """원 단위 값을 백만원으로도 적어 준다(ROUND_HALF_UP 정수).

    팀 Gold는 원문 표가 원 단위여도 기대값을 백만원으로 적는 문항이 있다(Phase1 실측
    LG생활건강·LIG넥스원). 환산은 결정론이고, 원값은 그대로 남긴다.
    """
    if unit not in ("원", "") or min(abs(old), abs(new)) < MILLION_MIN:
        return []
    q = Decimal("1")
    old_m = (old / MILLION).quantize(q, rounding=ROUND_HALF_UP)
    new_m = (new / MILLION).quantize(q, rounding=ROUND_HALF_UP)
    diff_m = (diff / MILLION).quantize(q, rounding=ROUND_HALF_UP)
    return [Derived(metric=metric, kind="amount_million",
                    formula=f"({_fmt(new)} - {_fmt(old)}) / 1,000,000",
                    value=_fmt(diff_m), unit="백만원", source_slots=slots,
                    source_values=(_fmt(old_m), _fmt(new_m)))]


def plan_entity_comparisons(question: str,
                            slots: Sequence[str]) -> list[tuple[str, str, str]]:
    """(항목, 기업A, 기업B) 목록. 같은 항목이 두 기업에 있을 때만.

    자리 이름이 '계약금액@한국항공우주' 꼴이라 누구 값인지 알 수 있다. 셋 이상이면
    어느 둘을 비교하라는 것인지 질문만으로 정할 수 없으므로 계산하지 않는다.
    """
    if not is_comparison_question(question):
        return []
    by_item: dict[str, list[str]] = {}
    for slot in slots:
        if "@" not in slot:
            continue
        item, corp = slot.rsplit("@", 1)
        by_item.setdefault(item, []).append(corp)
    out = []
    for item, corps in by_item.items():
        uniq = sorted(dict.fromkeys(corps))
        if len(uniq) == 2:
            out.append((item, uniq[0], uniq[1]))
    return out


def compare_entities(item: str, corp_a: str, raw_a: str,
                     corp_b: str, raw_b: str, unit: str = "") -> list[Derived]:
    """두 기업의 같은 항목을 견준다. 차액과 어느 쪽이 큰지."""
    a, b = parse_number(raw_a), parse_number(raw_b)
    if a is None or b is None:
        return []
    bigger, smaller = (corp_a, corp_b) if a >= b else (corp_b, corp_a)
    diff = abs(a - b)
    slots = (f"{item}@{corp_a}", f"{item}@{corp_b}")
    values = (_fmt(a), _fmt(b))
    out = [Derived(metric=item, kind="difference",
                   formula=f"|{_fmt(a)} - {_fmt(b)}|",
                   value=_fmt(diff), unit=unit,
                   source_slots=slots, source_values=values)]
    if a != b:
        out.append(Derived(metric=item, kind="larger_side",
                           formula=f"{bigger} > {smaller}",
                           value=bigger, unit="",
                           source_slots=slots, source_values=values))
    return out


_PERCENT_OF_RE = re.compile(r"(\d{1,2}(?:\.\d+)?)\s*%\s*[)\s]*에\s*해당하는")


def derive_percent_of(question: str, values: Mapping[str, str],
                      texts: Mapping[str, str]) -> list[Derived]:
    """"지분(32%)에 해당하는 금액" — 총액 × 비율을 코드가 계산한다.

    심사 실측(3df555): LLM이 이 곱셈을 직접 해 틀린 금액(1조1,567억, 정답 1조2,263억)이
    검증을 통과해 나갔다. 원본 총액 slot 값에 질문의 비율을 곱한 파생값을 만들어
    LLM 산술을 대체한다. 비율이나 총액을 못 찾으면 아무것도 만들지 않는다."""
    m = _PERCENT_OF_RE.search(question or "")
    if not m:
        return []
    pct = Decimal(m.group(1))
    out: list[Derived] = []
    for slot, raw in values.items():
        base = parse_number(raw)
        if base is None or base <= 0:
            continue
        share = (base * pct / Decimal(100)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        unit = unit_of(texts.get(slot, ""))
        out.append(Derived(metric=slot, kind="percent_of",
                           formula=f"{_fmt(base)} × {pct}%",
                           value=_fmt(share), unit=unit,
                           source_slots=(slot,), source_values=(_fmt(base),)))
    return out


def derive(question: str, slots: Sequence[str],
           values_by_slot: Mapping[str, str],
           lines_by_slot: Mapping[str, str] | None = None) -> list[Derived]:
    """계산형 질문이면 slot에 잡힌 원본 값으로 계산한다.

    values_by_slot: selector가 표 열까지 확정한 값만 들어온다. 값이 없는 slot은
    계산에 쓰지 않는다 — 열이 불확실하면 추측하지 않는다는 뜻이다.
    """
    lines_by_slot = lines_by_slot or {}
    out: list[Derived] = []
    for metric, old_year, new_year in plan_comparisons(question, slots):
        old_slot, new_slot = f"{metric}_{old_year}", f"{metric}_{new_year}"
        old_raw, new_raw = values_by_slot.get(old_slot), values_by_slot.get(new_slot)
        if not old_raw or not new_raw:
            continue
        old_unit = unit_of(lines_by_slot.get(old_slot, ""))
        new_unit = unit_of(lines_by_slot.get(new_slot, ""))
        if old_unit and new_unit and old_unit != new_unit:
            continue                 # 단위가 섞이면 계산하지 않는다
        out.extend(compute(metric, old_slot, old_raw, new_slot, new_raw,
                           unit=old_unit or new_unit))

    for item, corp_a, corp_b in plan_entity_comparisons(question, slots):
        slot_a, slot_b = f"{item}@{corp_a}", f"{item}@{corp_b}"
        raw_a, raw_b = values_by_slot.get(slot_a), values_by_slot.get(slot_b)
        if not raw_a or not raw_b:
            continue
        unit_a = unit_of(lines_by_slot.get(slot_a, ""))
        unit_b = unit_of(lines_by_slot.get(slot_b, ""))
        if unit_a and unit_b and unit_a != unit_b:
            continue                 # 단위가 섞이면 계산하지 않는다
        out.extend(compare_entities(item, corp_a, raw_a, corp_b, raw_b,
                                    unit=unit_a or unit_b))
    return out


# 대량보유상황보고서 요약 서식의 고정 행 쌍. 서식이 법정 고정이라 이름을 신뢰할 수 있다.
PAIR_LABELS = (("직전 보고서", "이번 보고서"),)
PAIR_COLUMN_NAMES = ("주식등의 수", "비율(%)")   # 요약표 열 순서(고정 서식)


def report_pair_diffs(question: str, lines: Sequence[str]) -> list[Derived]:
    """'직전 보고서 | X | R1' / '이번 보고서 | Y | R2' 쌍의 변동을 계산한다.

    질문이 변동·차이를 물을 때만. 두 줄의 숫자 칸 수가 같을 때만 — 어긋나면
    어느 칸끼리 짝인지 알 수 없으므로 계산하지 않는다.
    """
    if not any(w in question for w in ("변동", "변했", "변화", "차이", "증감", "얼마나")):
        return []
    def cells(line):
        return [parse_number(x) for x in line.split("|")[1:] if x.strip()]
    out: list[Derived] = []
    for before_label, after_label in PAIR_LABELS:
        before = next((l for l in lines if l.split("|")[0].strip() == before_label), None)
        after = next((l for l in lines if l.split("|")[0].strip() == after_label), None)
        if not before or not after:
            continue
        b_vals, a_vals = cells(before), cells(after)
        if len(b_vals) != len(a_vals) or not b_vals or any(
                v is None for v in b_vals + a_vals):
            continue
        for i, (b, a) in enumerate(zip(b_vals, a_vals)):
            name = (PAIR_COLUMN_NAMES[i] if i < len(PAIR_COLUMN_NAMES)
                    else f"{i + 1}번째 값")
            out.append(Derived(
                metric=f"직전 대비 {name}", kind="pair_change",
                formula=f"{_fmt(a)} - {_fmt(b)}", value=_fmt(a - b),
                unit="%p" if "%" in name else "",
                source_slots=(before_label, after_label),
                source_values=(_fmt(b), _fmt(a))))
        break   # 서식상 쌍은 하나다
    return out


# ---------- 대량보유상황보고서 서식 파서 (docs/plans/2026-09-05-holding-parser.md §3) ----------
# 실측(judge16): 대량보유 33문항 전부에서 위 report_pair_diffs가 미발동(0건).
# 실제 서식은 ① 연혁표(라벨 '직전보고서' 붙은 표기, 날짜·보고자 섞인 9칸)와
# ② 요약표(라벨이 둘째 칸, 첫 칸은 그룹 제목) 둘 다 완전일치 라벨에 걸리지 않는다.
# 새 파서는 머리글 이름으로 열을 찾고(고정 인덱스 금지), 질문 기준일·보고자로 문서를
# 결박하며, 유일하게 정해지지 않으면 미발동한다(fail-closed — 잘못된 쌍보다 덤프가 낫다).

PREV_QTY_SLOT = "직전 보고서 보유주식등의 수"
PREV_RATIO_SLOT = "직전 보고서 보유비율"
CUR_QTY_SLOT = "이번 보고서 보유주식등의 수"
CUR_RATIO_SLOT = "이번 보고서 보유비율"
REPORTER_SLOT = "보고자"

_HOLDING_CHANGE_WORDS = ("변동", "변했", "변화", "차이", "증감", "얼마나")
_HOLDING_DATE_RE = re.compile(
    r"((?:19|20)\d{2})\s*[.\-년/]\s*(\d{1,2})\s*[.\-월/]\s*(\d{1,2})\s*일?")
# 값 칸 판정: 금액·비율만("-"·날짜·문장은 값이 아니다 → 그 행 미사용).
_PURE_CELL_RE = re.compile(r"^\(?-?\d[\d,]*(?:\.\d+)?\)?%?$")
# 질문의 보고자: "X이(가) Y에 대해 제출한" / "보고자: X" 문형만 신뢰한다.
_Q_REPORTER_RE = re.compile(r"([^,.\n]{2,80}?)\s*이\(가\)")
_Q_REPORTER_COLON_RE = re.compile(r"보고자\s*[::]\s*([^),\n]{2,60})")


@dataclass(frozen=True)
class HoldingExtract:
    """파서가 원문에서 뽑은 값 하나 — 계산값(Derived)과 절대 섞지 않는다(조건 1)."""
    slot: str
    line: str                       # 값이 실린 원문 행 그대로
    value: str                      # 셀 값 그대로
    doc_id: str
    chunk_id: str
    node_index: int | None
    section_path: tuple[str, ...]
    rcept_no: str
    from_node: bool                 # 검색 청크가 아니라 문서 원문(node)에서 온 행인가


@dataclass(frozen=True)
class HoldingParseResult:
    values: tuple[HoldingExtract, ...]
    derived: tuple[Derived, ...]            # 증감 2개까지 (kind "holding_change")
    missing_slots: tuple[str, ...]
    consumed_texts: frozenset[str]          # 소비한 행(공백 정규화) — 폴백 덤프에서 이 행만 숨김
    doc_id: str
    filer: str
    report_kind: str = ""                   # 보고구분(신규/변동ㆍ변경 등, 서식 그대로)
    notes: tuple[str, ...] = ()             # 답변에 명시할 결정론 안내(신규 보고의 직전 '-' 등)


def _squash(text: str) -> str:
    return "".join((text or "").split())


def _norm_name(text: str) -> str:
    t = _squash(text).casefold()
    for token in ("주식회사", "(주)", "㈜"):
        t = t.replace(token, "")
    return t


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.split("|")]


def _dates_in(text: str) -> list[tuple[int, int, int]]:
    return [(int(y), int(m), int(d))
            for y, m, d in _HOLDING_DATE_RE.findall(text or "")]


def question_report_dates(question: str) -> frozenset[tuple[int, int, int]]:
    """질문이 지목한 보고서작성기준일 후보.

    앵커 우선: '기준일' 직전 표기 → '이번보고서(날짜)' → 질문에 날짜가 하나뿐이면 그것.
    여러 날짜가 앵커 없이 섞이면 결박 불가 — 빈 집합(파서는 유일 문서일 때만 진행)."""
    anchored: list[tuple[int, int, int]] = []
    cur_anchored: list[tuple[int, int, int]] = []
    all_dates: list[tuple[int, int, int]] = []
    for m in _HOLDING_DATE_RE.finditer(question or ""):
        date = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        all_dates.append(date)
        window = _squash(question[max(0, m.start() - 15):m.start()])
        if "기준일" in window:
            anchored.append(date)
        elif "이번보고서" in window:
            cur_anchored.append(date)
    if anchored:
        return frozenset(anchored)
    if cur_anchored:
        return frozenset(cur_anchored)
    if len(all_dates) == 1:
        return frozenset(all_dates)
    return frozenset()


def _question_reporter(question: str) -> str:
    m = _Q_REPORTER_COLON_RE.search(question or "")
    if m:
        return m.group(1).strip()
    m = _Q_REPORTER_RE.search(question or "")
    return m.group(1).strip() if m else ""


def _cell_if_value(cells: Sequence[str], col: int | None) -> str:
    if col is None or col >= len(cells):
        return ""
    cell = cells[col].strip()
    squashed = _squash(cell)
    if _PURE_CELL_RE.fullmatch(squashed) and any(ch.isdigit() for ch in squashed):
        return cell
    return ""


def _merge_header(hdr_lines: Sequence[str], width: int) -> list[str] | None:
    """연속한 머리글 줄들을 셀 단위로 이어붙여 논리 머리글로(2행 머리글 병합)."""
    rows = [_cells(l) for l in hdr_lines]
    rows = [r for r in rows if len(r) == width]
    if not rows:
        return None
    return [_squash("".join(r[i] for r in rows)) for i in range(width)]


def _holding_columns(header: Sequence[str]) -> dict[str, int | None] | None:
    """논리 머리글에서 열을 이름으로 확정한다. 못 찾으면 None(그 표 미발동).

    비율 열은 '주권'·'의결권' 그룹 표식이 붙은 셀을 배제한다 — 열 순서가 뒤바뀐 표에서
    "수량 열 오른쪽의 첫 비율"만 보면 주권 비율을 집는다(§3-4 변형 ④)."""
    qty = next((i for i, c in enumerate(header)
                if "주식등의수" in c and "및" not in c), None)
    if qty is None:
        return None
    cands = [i for i, c in enumerate(header)
             if "비율" in c and i != qty and "및" not in c
             and "주권" not in c and "의결권" not in c]
    if not cands:
        return None
    if len(cands) == 1:
        ratio = cands[0]
    else:
        grp = [i for i in cands if "주식등" in header[i]]
        if len(grp) == 1:
            ratio = grp[0]
        else:
            right = [i for i in cands if i > qty]
            if not right:
                return None
            ratio = right[0]
    reporter = next((i for i, c in enumerate(header) if "본인성명" in c), None)
    if reporter is None:
        reporter = next((i for i, c in enumerate(header)
                         if "보고자" in c and "특별관계자" not in c), None)
    date = next((i for i, c in enumerate(header) if "기준일" in c), None)
    return {"qty": qty, "ratio": ratio, "reporter": reporter, "date": date}


_HISTORY_LABELS = ("직전보고서", "이번보고서")


def _history_rows(lines: Sequence[tuple[str, dict]]) -> list[dict]:
    """연혁표에서 직전/이번 행을 뽑는다. 머리글은 데이터 행 바로 위의 같은 셀 수 줄들."""
    out: list[dict] = []
    i, n = 0, len(lines)
    while i < n:
        cells = _cells(lines[i][0])
        label = _squash(cells[0]) if cells else ""
        if label not in _HISTORY_LABELS:
            i += 1
            continue
        width = len(cells)
        hdr_lines: list[str] = []
        j = i - 1
        while j >= 0:
            cj = _cells(lines[j][0])
            if len(cj) != width or _is_holding_data_row(cj):
                break
            hdr_lines.insert(0, lines[j][0])
            j -= 1
        header = _merge_header(hdr_lines, width)
        cols = _holding_columns(header) if header else None
        k = i
        while k < n:
            ck = _cells(lines[k][0])
            lb = _squash(ck[0]) if ck else ""
            if lb in _HISTORY_LABELS and len(ck) == width:
                if cols:
                    text, src = lines[k]
                    date_cell = (ck[cols["date"]]
                                 if cols["date"] is not None and cols["date"] < len(ck)
                                 else text)
                    dates = _dates_in(date_cell) or _dates_in(text)
                    reporter_col = cols["reporter"]
                    out.append({
                        "label": lb, "line": text, "src": src,
                        "qty": _cell_if_value(ck, cols["qty"]),
                        "ratio": _cell_if_value(ck, cols["ratio"]),
                        "date": dates[0] if dates else None,
                        "reporter": (ck[reporter_col].strip()
                                     if reporter_col is not None and reporter_col < len(ck)
                                     else ""),
                    })
                k += 1
                continue
            if lb == "증감":                 # 증감 행은 표의 일부지만 소비하지 않는다(재계산)
                k += 1
                continue
            break
        i = k
    return out


def _is_holding_data_row(cells: Sequence[str]) -> bool:
    """머리글 판정용 — tables._is_data_row와 같은 기준 + 직전/이번 라벨 행."""
    from . import tables
    if cells and _squash(cells[0]) in _HISTORY_LABELS:
        return True
    return tables._is_data_row(cells)


# 요약표의 기본 그룹 제목(법정 고정 서식). 같은 문서에 '주요계약체결 주식등의 수 및 비율',
# '의결권의 수 및 보유비율' 그룹이 함께 있으므로(고려아연 실측 holding_20240904000440),
# 그룹 제목 전체로 결박해야 서로 다른 그룹의 값이 한 표로 합쳐져 충돌 폐기되지 않는다.
_SUMMARY_GROUP_KEY = "보유주식등의수및보유비율"


def _summary_rows(lines: Sequence[tuple[str, dict]]) -> list[dict]:
    """요약표: 데이터 행 = cell[0]이 기본 그룹 제목 AND cell[1]이 직전/이번 라벨."""
    out: list[dict] = []
    for idx, (text, src) in enumerate(lines):
        cells = _cells(text)
        if len(cells) < 3 or _SUMMARY_GROUP_KEY not in _squash(cells[0]):
            continue
        label = _squash(cells[1]) if len(cells) > 1 else ""
        if label not in _HISTORY_LABELS:
            continue
        header = None
        for j in range(idx - 1, -1, -1):
            cj = _cells(lines[j][0])
            if len(cj) != len(cells):
                continue                    # 사이에 다른 표 줄이 낄 수 있다 — 계속 위로
            if _SUMMARY_GROUP_KEY not in _squash(cj[0]):
                continue                    # 다른 그룹의 머리글은 이 그룹을 설명하지 않는다
            if _squash(cj[1]) in _HISTORY_LABELS:
                continue                    # 위쪽 데이터 행
            merged = [_squash(c) for c in cj]
            if any("주식등의수" in c and "및" not in c for c in merged):
                header = merged
                break
        cols = _holding_columns(header) if header else None
        if cols is None:
            continue                        # 머리글 없음 → 미발동(정렬 가드)
        out.append({"label": label, "line": text, "src": src,
                    "qty": _cell_if_value(cells, cols["qty"]),
                    "ratio": _cell_if_value(cells, cols["ratio"]),
                    # 명시적 '-'는 "값을 못 찾음"이 아니라 "해당 없음"이다(신규 보고 등).
                    # 연혁표 값으로 보충하면 안 되므로 구분해 둔다(재검수 BLOCKER 2).
                    "qty_null": _dash_cell(cells, cols["qty"]),
                    "ratio_null": _dash_cell(cells, cols["ratio"])})
    return out


_NULL_CELLS = {"-", "－", "―", "—"}


def _dash_cell(cells: Sequence[str], col: int | None) -> bool:
    if col is None or col >= len(cells):
        return False
    return _squash(cells[col]) in _NULL_CELLS


# 요약정보의 단독 항목 행("보고구분 | 신규 | 신규", "보유목적 | 단순투자"). 같은 값이
# 반복 셀로 오는 고정 서식이라 첫 비어있지 않은 값을 쓴다. 서로 다른 값이 나오면 판정하지
# 않는다(fail-closed).
_FIELD_NAME_RES = {
    "보고구분": re.compile(r"\d*\.?보고구분"),
    "보유목적": re.compile(r"\d*\.?보유목적"),
    "보고사유": re.compile(r"\d*\.?보고사유"),
}


def _field_value(lines: Sequence[tuple[str, dict]], name: str) -> dict | None:
    rx = _FIELD_NAME_RES[name]
    found: dict | None = None
    for text, src in lines:
        cells = _cells(text)
        for i, cell in enumerate(cells[:-1]):
            if not rx.fullmatch(_squash(cell)):
                continue
            value = next((c.strip() for c in cells[i + 1:] if c.strip()), "")
            if not value or rx.fullmatch(_squash(value)):
                continue
            if found is not None and _squash(found["value"]) != _squash(value):
                return None                 # 값이 갈리면 fail-closed
            found = {"value": value, "line": text, "src": src}
            break
    return found


# 대량보유 서식 구분 문구가 보유목적 범주를 법정으로 명시한다:
#   일반서식 "… '경영권에 영향을 주기 위한 목적'의 경우"  → 보유목적 = 경영권 영향
#   약식서식 "… 목적'이 아닌 경우 …"                     → 범주 확정 불가(일반투자/단순투자 갈림)
# 고려아연 실측: 문서 어디에도 '보유목적' 텍스트가 없고 이 서식 문구가 유일한 근거였다 —
# LLM이 이걸 읽어 답하다 실행마다 흔들렸다. 명시 필드가 있으면 필드가 우선한다.
_FORM_MGMT_PURPOSE = "경영권에영향을주기위한목적"


def _form_purpose(lines: Sequence[tuple[str, dict]]) -> dict | None:
    for text, src in lines:
        sq = _squash(text)
        if (_FORM_MGMT_PURPOSE in sq and "의경우" in sq and "아닌경우" not in sq
                and "서식" in sq):
            return {"value": "경영권 영향", "line": text, "src": src}
    return None


def _cover_reporter(lines: Sequence[tuple[str, dict]]) -> dict | None:
    """표지의 '보고자 : 이름' 행. 연혁표가 없는 문서(변동 보고서 등)의 보고자 출처.

    셀이 정확히 '보고자:'인 경우만 본다 — 연혁표 머리글의 '보고자' 셀(뒤에 이름 아닌
    '본인 성명' 셀이 옴)과 구분하기 위해서다. 서로 다른 이름이 나오면 판정하지 않는다."""
    found: dict | None = None
    for text, src in lines:
        cells = _cells(text)
        for i, cell in enumerate(cells[:-1]):
            if _squash(cell) not in ("보고자:", "보고자："):
                continue
            name = next((c.strip() for c in cells[i + 1:] if c.strip()), "")
            if not name or len(name) > 60 or "보고자" in name:
                continue
            if found is not None and _norm_name(found["reporter"]) != _norm_name(name):
                return None                 # 이름이 갈리면 fail-closed
            found = {"line": text, "src": src, "reporter": name}
    return found


def _requested_topics(question: str) -> dict[str, bool]:
    """질문이 지목한 항목·기간만 답에 싣는다(질문하지 않은 값 자동 출력 금지).

    수량·비율·보고자 어느 것도 지목되지 않으면 값 질문으로 보고 수량·비율을 켠다.
    변동어가 있으면 두 기간 모두 필요하고, 아니면 직전/이번 언급을 따른다(둘 다 없으면 둘 다)."""
    q = _squash(question or "")
    qty = any(w in q for w in ("주식등의수", "주식수", "보유주식"))
    ratio = any(w in q for w in ("비율", "지분"))
    reporter = any(w in q for w in ("보고자", "본인성명"))
    if not (qty or ratio or reporter):
        qty = ratio = True
    change = any(w in (question or "") for w in _HOLDING_CHANGE_WORDS)
    prev = change or "직전" in q or "이번" not in q
    cur = change or "이번" in q or "직전" not in q
    return {"qty": qty, "ratio": ratio, "reporter": reporter, "prev": prev, "cur": cur}


def _same_values(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
    for key in ("qty", "ratio"):
        va, vb = parse_number(a.get(key) or ""), parse_number(b.get(key) or "")
        if va is not None and vb is not None and va != vb:
            return False
    return True


def _resolve_label(rows: list[dict]) -> tuple[dict | None, bool]:
    """같은 라벨의 행들을 하나로. (행, 충돌 여부). 값이 다른 두 행이면 충돌."""
    uniq: list[dict] = []
    for row in rows:
        hit = next((u for u in uniq if _same_values(u, row)), None)
        if hit is None:
            uniq.append(row)
        else:
            for key in ("qty", "ratio", "date", "reporter",
                        "qty_null", "ratio_null"):             # 빈 칸은 다른 행이 보충
                if not hit.get(key) and row.get(key):
                    hit[key] = row[key]
    if not uniq:
        return None, False
    if len(uniq) > 1:
        return None, True
    return uniq[0], False


def _doc_profile(doc_id: str, line_groups: Sequence[Sequence[tuple[str, dict]]],
                 meta: Mapping[str, Any]) -> dict[str, Any] | None:
    hist: dict[str, list[dict]] = {lb: [] for lb in _HISTORY_LABELS}
    summ: dict[str, list[dict]] = {lb: [] for lb in _HISTORY_LABELS}
    basis_dates: set[tuple[int, int, int]] = set()
    seen_rows: set[str] = set()
    consumed: set[str] = set()
    cover: dict | None = None
    for lines in line_groups:
        for row in _history_rows(lines):
            key = _squash(row["line"])
            if key not in seen_rows:
                seen_rows.add(key)
                hist[row["label"]].append(row)
        for row in _summary_rows(lines):
            key = _squash(row["line"])
            if key not in seen_rows:
                seen_rows.add(key)
                summ[row["label"]].append(row)
        for text, _src in lines:
            if "작성기준일" in _squash(text):
                basis_dates.update(_dates_in(text))
            # 요약표 계열 그룹 행(의결권·주요계약체결 포함)은 파서가 인지하고 배제한 행이다 —
            # 원문 덤프로 다시 내보내면 기본 그룹 값과 혼동을 부른다(코덱스 최종 검수 5).
            cells = _cells(text)
            if len(cells) >= 3 and _squash(cells[1]) in _HISTORY_LABELS:
                consumed.add(_squash(text))
        if cover is None:
            cover = _cover_reporter(lines)
    conflict = False
    resolved: dict[str, dict[str, dict | None]] = {"hist": {}, "summ": {}}
    for label in _HISTORY_LABELS:
        resolved["hist"][label], c1 = _resolve_label(hist[label])
        resolved["summ"][label], c2 = _resolve_label(summ[label])
        conflict = conflict or c1 or c2
        h, s = resolved["hist"][label], resolved["summ"][label]
        if h and s and not _same_values(h, s):
            conflict = True                 # 연혁표와 요약표가 다른 값 — 판정 불가
    if not any(resolved[f][lb] for f in ("hist", "summ") for lb in _HISTORY_LABELS):
        return None
    cur = resolved["hist"]["이번보고서"]
    date = cur["date"] if cur and cur.get("date") else None
    if date is None:
        date = next(iter(basis_dates)) if len(basis_dates) == 1 else None
    filer_row = (cur.get("reporter") or "") if cur else ""
    meta_filer = str(meta.get("filer_name") or "")
    cover_name = (cover or {}).get("reporter") or ""
    # 보고자 출처 우선순위: 표지 '보고자 :' 행(전체 명칭 — 대리인 표기 포함) → 연혁표
    # 이번보고서 행(붙여쓴 축약 표기). 재검수 BLOCKER 2: 축약 행이 전체 명칭을 가렸다.
    reporter_src = cover or (cur if cur and filer_row else None)
    reporter_name = cover_name or filer_row
    all_lines = [pair for lines in line_groups for pair in lines]
    return {
        "doc_id": doc_id, "resolved": resolved, "conflict": conflict, "date": date,
        "filer_row": filer_row, "meta_filer": meta_filer,
        "filer_norms": {n for n in (_norm_name(filer_row), _norm_name(meta_filer),
                                    _norm_name(cover_name)) if n},
        "reporter_src": reporter_src, "reporter_name": reporter_name,
        "consumed": consumed,
        # 요약정보 단독 항목 — 보고구분(신규/변동)·보유목적·보고사유 결정론 추출.
        # 보유목적은 명시 필드가 없으면 서식 구분 문구(일반서식=경영권 영향)로 확정한다.
        "report_kind": _field_value(all_lines, "보고구분"),
        "purpose": _field_value(all_lines, "보유목적") or _form_purpose(all_lines),
        "report_reason": _field_value(all_lines, "보고사유"),
    }


def _extract(slot: str, row: Mapping[str, Any], value: str, doc_id: str) -> HoldingExtract:
    src = row["src"]
    return HoldingExtract(
        slot=slot, line=row["line"], value=value, doc_id=doc_id,
        chunk_id=str(src.get("chunk_id") or ""), node_index=src.get("node_index"),
        section_path=tuple(src.get("section_path") or ()),
        rcept_no=str(src.get("rcept_no") or ""), from_node=bool(src.get("from_node")))


def parse_holding_report(question: str, chunks: Sequence[Any],
                         doc_nodes: Mapping[str, Sequence[tuple[int | None, str]]] | None = None,
                         doc_meta: Mapping[str, Mapping[str, Any]] | None = None,
                         ) -> HoldingParseResult | None:
    """대량보유상황보고서에서 직전/이번 보유주식등의 수·보유비율을 결정론으로 뽑는다.

    chunks: 검색 청크(매치된 문서로 한정해 넘길 것). doc_nodes: 같은 문서의 원문 노드
    [(node_index, text)] — 검색에 안 뽑힌 행도 값 소스로 쓴다(사용 시 호출자가 근거 승격).
    반환 None = 미발동(문서를 유일하게 결박하지 못했거나 서식 판독 실패) — 덤프 유지."""
    doc_nodes = doc_nodes or {}
    doc_meta = doc_meta or {}
    groups: dict[str, list[list[tuple[str, dict]]]] = {}
    chunk_meta: dict[str, dict[str, Any]] = {}
    for c in chunks:
        meta = getattr(c, "metadata", {}) or {}
        chunk_meta.setdefault(c.doc_id, dict(meta))
        src = {"chunk_id": getattr(c, "chunk_id", ""), "node_index": getattr(c, "node_index", None),
               "from_node": False, "section_path": tuple(getattr(c, "section_path", ()) or ()),
               "rcept_no": str(meta.get("rcept_no") or "")}
        lines = [(ln.strip(), src) for ln in (getattr(c, "evidence_text", "") or "").split("\n")
                 if ln.strip()]
        if lines:
            groups.setdefault(c.doc_id, []).append(lines)
    for doc_id, nodes in doc_nodes.items():
        rcept = str((doc_meta.get(doc_id) or {}).get("rcept_no") or "")
        for node_index, text in nodes or ():
            src = {"chunk_id": f"{doc_id}#node{node_index}", "node_index": node_index,
                   "from_node": True, "section_path": (), "rcept_no": rcept}
            lines = [(ln.strip(), src) for ln in (text or "").split("\n") if ln.strip()]
            if lines:
                groups.setdefault(doc_id, []).append(lines)

    profiles = [p for p in (_doc_profile(d, gs, {**chunk_meta.get(d, {}),
                                                 **(doc_meta.get(d) or {})})
                            for d, gs in groups.items()) if p]
    q_dates = question_report_dates(question)
    if q_dates:
        profiles = [p for p in profiles if p["date"] in q_dates]
    holding_docs = [p for p in profiles if str(p["doc_id"]).startswith("holding")]
    if holding_docs and len(holding_docs) < len(profiles):
        profiles = holding_docs                 # 정기보고서 안 최대주주 표는 후순위(§3-3)
    reporter_q = _question_reporter(question)
    if reporter_q:
        rq = _norm_name(reporter_q)
        profiles = [p for p in profiles
                    if any(rq in f or f in rq for f in p["filer_norms"])]
    if len(profiles) != 1:
        return None                             # 유일하게 정해지지 않으면 미발동
    profile = profiles[0]
    if profile["conflict"]:
        return None

    resolved = profile["resolved"]
    doc_id = profile["doc_id"]
    req = _requested_topics(question)
    kind_field = profile.get("report_kind")
    new_report = bool(kind_field) and "신규" in _squash(kind_field["value"])
    values: list[HoldingExtract] = []
    missing: list[str] = []
    notes: list[str] = []
    consumed: set[str] = set(profile["consumed"])
    pair: dict[str, str] = {}
    for label, period, period_key in (("직전보고서", "직전 보고서", "prev"),
                                      ("이번보고서", "이번 보고서", "cur")):
        prev_of_new = new_report and label == "직전보고서"
        for kind, kind_label in (("qty", "보유주식등의 수"), ("ratio", "보유비율")):
            summ_row = resolved["summ"][label]
            # 요약표의 명시적 '-'는 "해당 없음"이다 — 연혁표 값으로 보충하지 않는다.
            # 신규 보고의 직전 값도 마찬가지다(재검수 BLOCKER 2: 삼성전기 신규 공시에서
            # 과거 연혁의 3,730,598이 직전 값으로 오귀속됐다).
            null_row = (summ_row if summ_row is not None and not summ_row.get(kind)
                        and summ_row.get(f"{kind}_null") else None)
            row = None
            if null_row is None and not prev_of_new:
                row = next((resolved[f][label] for f in ("hist", "summ")
                            if resolved[f][label] and resolved[f][label].get(kind)), None)
            if row is not None:
                for fmt in ("hist", "summ"):
                    used = resolved[fmt][label]
                    if used and used.get(kind):
                        consumed.add(_squash(used["line"]))
            if not (req[period_key] and req[kind]):
                continue                        # 질문하지 않은 값은 답에 싣지 않는다
            slot = f"{period} {kind_label}"
            if row is None:
                if null_row is not None:
                    values.append(_extract(slot, null_row, "-", doc_id))
                    consumed.add(_squash(null_row["line"]))
                elif not prev_of_new:
                    missing.append(slot)
                continue
            values.append(_extract(slot, row, row[kind], doc_id))
            pair[f"{label}:{kind}"] = row[kind]
    if new_report and req["prev"]:
        notes.append("※ 이 보고서의 보고구분은 '신규'다 — 직전 보고서의 값은 "
                     "'-'(해당 없음)로 보고되었다.")
        values.append(_extract("보고구분", kind_field, kind_field["value"], doc_id))
        consumed.add(_squash(kind_field["line"]))
    if req["reporter"] and profile["reporter_src"] and profile["reporter_name"]:
        values.append(_extract(REPORTER_SLOT, profile["reporter_src"],
                               profile["reporter_name"], doc_id))
        consumed.add(_squash(profile["reporter_src"]["line"]))
    # 질문이 물은 서술 항목이 서식 필드로 확정되면 결정론으로 답한다(LLM 보완 불필요).
    for topic in ("보유목적", "보고사유"):
        field = profile.get({"보유목적": "purpose", "보고사유": "report_reason"}[topic])
        if topic in (question or "") and field:
            values.append(_extract(topic, field, field["value"], doc_id))
            consumed.add(_squash(field["line"]))
    if not values:
        return None

    derived: list[Derived] = []
    if any(w in (question or "") for w in _HOLDING_CHANGE_WORDS):
        specs = (("qty", "보유주식등의 수", "주", PREV_QTY_SLOT, CUR_QTY_SLOT),
                 ("ratio", "보유비율", "%p", PREV_RATIO_SLOT, CUR_RATIO_SLOT))
        for kind, metric, unit, prev_slot, cur_slot in specs:
            prev_raw, cur_raw = pair.get(f"직전보고서:{kind}"), pair.get(f"이번보고서:{kind}")
            if not prev_raw or not cur_raw:
                continue                        # 쌍 미완비 — 부분 답변(다른 보고자로 채우지 않는다)
            old, new = parse_number(prev_raw), parse_number(cur_raw)
            if old is None or new is None:
                continue
            derived.append(Derived(
                metric=metric, kind="holding_change",
                formula=f"{cur_raw} - {prev_raw}", value=f"{new - old:,}", unit=unit,
                source_slots=(prev_slot, cur_slot), source_values=(prev_raw, cur_raw)))

    return HoldingParseResult(
        values=tuple(values), derived=tuple(derived), missing_slots=tuple(missing),
        consumed_texts=frozenset(consumed), doc_id=doc_id,
        filer=profile["reporter_name"] or profile["meta_filer"],
        report_kind=(kind_field or {}).get("value", ""), notes=tuple(notes))


def has_final_consonant(word: str) -> bool:
    """마지막 글자에 받침이 있나. 한글이 아니면 없는 것으로 본다."""
    if not word:
        return False
    ch = word.strip()[-1]
    if not ("가" <= ch <= "힣"):
        return False
    return (ord(ch) - 0xAC00) % 28 != 0


def subject_particle(word: str) -> str:
    """'계약금액이' / '차이가' — 받침에 따라 조사를 고른다."""
    return "이" if has_final_consonant(word) else "가"


_KIND_LABEL = {"percent_of": "비율 적용 금액"}


def describe(derived: Sequence[Derived]) -> str:
    """계산 결과를 사람이 읽는 문장으로. 원문 인용과 섞지 않는다."""
    if not derived:
        return ""
    lines = []
    for d in derived:
        unit = f" {d.unit}" if d.unit else ""
        if d.kind == "increase_rate":
            # holding_change와 같은 형식(§3-6): …에서 …로 N% 증가/감소 + signed 병기.
            n = parse_number(d.value)
            disp = display_value(d)
            if n == 0:
                lines.append(f"- {d.metric}: {d.source_values[0]}에서 "
                             f"{d.source_values[1]}로 변동 없음(증감률 0%)")
            else:
                word = "증가" if n is not None and n > 0 else "감소"
                lines.append(f"- {d.metric}: {d.source_values[0]}에서 {d.source_values[1]}로 "
                             f"{disp.lstrip('-')}% {word}(증감률 {disp}%)")
        elif d.kind == "difference":
            a_slot, b_slot = d.source_slots
            a_corp = a_slot.rsplit("@", 1)[-1]
            b_corp = b_slot.rsplit("@", 1)[-1]
            lines.append(f"- {d.metric} 차이: {a_corp} {d.source_values[0]} vs "
                         f"{b_corp} {d.source_values[1]} → {d.value}{unit}")
        elif d.kind == "holding_change":
            # 자연어 서술 + signed 원값 병기(자동 채점 value_forms가 "-662,232"를 찾도록).
            # 방향어는 부호로, 크기는 절댓값. 비율만 증감에 %p를 붙인다(§3-6).
            prev_v, cur_v = d.source_values
            n = parse_number(d.value)
            u = d.unit or ""
            if n == 0:
                lines.append(f"- {d.metric}: {prev_v}에서 {cur_v}로 변동 없음(증감 0)")
            else:
                word = "증가" if n is not None and n > 0 else "감소"
                signed = f"{d.value}{u if u == '%p' else ''}"
                lines.append(f"- {d.metric}: {prev_v}에서 {cur_v}로 "
                             f"{d.value.lstrip('-')}{u} {word}(증감 {signed})")
        elif d.kind == "pair_change":
            n = parse_number(d.value)
            u = (d.unit or "").strip()
            if n == 0:
                lines.append(f"- {d.metric}: {d.source_values[0]}에서 "
                             f"{d.source_values[1]}로 변동 없음(증감 0{u})")
            else:
                word = "증가" if n is not None and n > 0 else "감소"
                lines.append(f"- {d.metric}: {d.source_values[0]}에서 {d.source_values[1]}로 "
                             f"{d.value.lstrip('-')}{u} {word}(증감 {d.value}{u})")
        elif d.kind == "percent_of":
            lines.append(f"- {d.metric} × 질문의 비율({d.formula.split('×')[-1].strip()}): "
                         f"{d.value}{unit}")
        elif d.kind == "larger_side":
            lines.append(f"- {d.metric}{subject_particle(d.metric)} 더 큰 쪽: {d.value}")
        elif d.kind == "amount_million":
            lines.append(f"- {d.metric} 백만원 환산: {d.source_values[0]} → "
                         f"{d.source_values[1]} (증감 {d.value} 백만원)")
        else:
            lines.append(f"- {d.metric} 증감액: {d.value}{unit}")
    return "계산 결과(원문 값에서 코드가 계산):\n" + "\n".join(lines)


def allowed_numbers(derived: Sequence[Derived]) -> list[str]:
    """Validator에 넘길 '코드가 만든 숫자' 목록. LLM이 만든 값은 여기 들어오지 않는다."""
    out: list[str] = []
    for d in derived:
        if not any(ch.isdigit() for ch in d.value):
            continue            # 기업명 같은 값(larger_side)은 숫자 허용 목록이 아니다
        extra = d.source_values if d.kind == "amount_million" else ()
        for v in (d.value, display_value(d), *extra):   # 원값(채점용)과 표시값 둘 다 허용
            out.append(v)
            out.append(v.replace(",", ""))
            out.append(v.lstrip("-"))
            out.append(v.lstrip("-").replace(",", ""))
    return sorted({v for v in out if v})
