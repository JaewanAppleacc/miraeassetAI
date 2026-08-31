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
PERCENT_DECIMALS = 2                 # 백분율 반올림 자릿수(고정)
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
    return out


def describe(derived: Sequence[Derived]) -> str:
    """계산 결과를 사람이 읽는 문장으로. 원문 인용과 섞지 않는다."""
    if not derived:
        return ""
    lines = []
    for d in derived:
        if d.kind == "increase_rate":
            lines.append(f"- {d.metric}: {d.source_values[0]} → {d.source_values[1]} "
                         f"({d.value}% 변동)")
        else:
            unit = f" {d.unit}" if d.unit else ""
            lines.append(f"- {d.metric} 증감액: {d.value}{unit}")
    return "계산 결과(원문 값에서 코드가 계산):\n" + "\n".join(lines)


def allowed_numbers(derived: Sequence[Derived]) -> list[str]:
    """Validator에 넘길 '코드가 만든 숫자' 목록. LLM이 만든 값은 여기 들어오지 않는다."""
    out: list[str] = []
    for d in derived:
        out.append(d.value)
        out.append(d.value.replace(",", ""))
        out.append(d.value.lstrip("-"))
        out.append(d.value.lstrip("-").replace(",", ""))
    return sorted({v for v in out if v})
