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
    return [
        Derived(metric=metric, kind="increase_amount",
                formula=f"{_fmt(new)} - {_fmt(old)}",
                value=_fmt(diff), unit=unit, source_slots=slots, source_values=values),
        Derived(metric=metric, kind="increase_rate",
                formula=f"({_fmt(new)} - {_fmt(old)}) / {_fmt(old)} × 100",
                value=f"{rate}", unit="%", source_slots=slots, source_values=values),
    ]


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
    if not any(w in question for w in ("변동", "변했", "차이", "증감", "얼마나")):
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


def describe(derived: Sequence[Derived]) -> str:
    """계산 결과를 사람이 읽는 문장으로. 원문 인용과 섞지 않는다."""
    if not derived:
        return ""
    lines = []
    for d in derived:
        unit = f" {d.unit}" if d.unit else ""
        if d.kind == "increase_rate":
            lines.append(f"- {d.metric}: {d.source_values[0]} → {d.source_values[1]} "
                         f"({display_value(d)}% 변동)")
        elif d.kind == "difference":
            a_slot, b_slot = d.source_slots
            a_corp = a_slot.rsplit("@", 1)[-1]
            b_corp = b_slot.rsplit("@", 1)[-1]
            lines.append(f"- {d.metric} 차이: {a_corp} {d.source_values[0]} vs "
                         f"{b_corp} {d.source_values[1]} → {d.value}{unit}")
        elif d.kind == "pair_change":
            lines.append(f"- {d.metric}: {d.source_values[0]} → {d.source_values[1]} "
                         f"({'+' if not d.value.startswith('-') else ''}{d.value}{unit.strip() or ''} 변동)")
        elif d.kind == "larger_side":
            lines.append(f"- {d.metric}{subject_particle(d.metric)} 더 큰 쪽: {d.value}")
        else:
            lines.append(f"- {d.metric} 증감액: {d.value}{unit}")
    return "계산 결과(원문 값에서 코드가 계산):\n" + "\n".join(lines)


def allowed_numbers(derived: Sequence[Derived]) -> list[str]:
    """Validator에 넘길 '코드가 만든 숫자' 목록. LLM이 만든 값은 여기 들어오지 않는다."""
    out: list[str] = []
    for d in derived:
        if not any(ch.isdigit() for ch in d.value):
            continue            # 기업명 같은 값(larger_side)은 숫자 허용 목록이 아니다
        for v in (d.value, display_value(d)):   # 원값(채점용)과 표시값 둘 다 허용
            out.append(v)
            out.append(v.replace(",", ""))
            out.append(v.lstrip("-"))
            out.append(v.lstrip("-").replace(",", ""))
    return sorted({v for v in out if v})
