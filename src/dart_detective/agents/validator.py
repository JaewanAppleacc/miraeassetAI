"""Evidence Validation — Agent가 만든 주장을 실제 원문과 대조한다.

예시:
    공시 원문: "현금및현금성자산 239,036,839,774"
    생성 문장: "회사는 현금이 부족하다."
  -> 숫자는 근거가 있으나 '부족하다'는 원문에 없는 판단이므로 unsupported inference.

출력 상태:
    SUPPORTED            숫자/인용/기간/기업이 전부 원문에 있고 판단어가 없다
    PARTIALLY_SUPPORTED  근거는 있으나 원문에 없는 판단/기간/기업 표현이 섞였다
    UNSUPPORTED          원문에 없는 숫자를 만들었거나 인용이 원문에 없다
"""
from __future__ import annotations

import re
from typing import Any, Iterable

NUM_RE = re.compile(r"\d[\d,\.]*")
YEAR_RE = re.compile(r"(19|20)\d{2}")

# 원문에 없으면 '추론'으로 표시할 판단 어휘. 사전이 아니라 게이트다 —
# 여기 걸리면 답변이 틀렸다는 뜻이 아니라 '원문이 직접 말하지 않은 판단'이라는 뜻이다.
JUDGMENT_TERMS = (
    "부족", "충분", "넉넉", "위험", "안전", "감당", "무리", "여유", "우려",
    "긍정적", "부정적", "좋다", "나쁘다", "과도", "적정", "가능성이 높", "가능성이 낮",
    "개선", "악화", "유리", "불리",
)

_UNIT_DIVISORS = (10_000, 1_000_000, 100_000_000, 1_000_000_000_000)


def _norm_num(tok: str) -> str:
    tok = tok.replace(",", "").rstrip(".")
    if tok.endswith(".0"):
        tok = tok[:-2]
    return tok


def numbers_in(text: str) -> list[str]:
    return [_norm_num(m.group()) for m in NUM_RE.finditer(text)]


def allowed_numbers(sources: Iterable[str]) -> set[str]:
    """원문 숫자 + 원 단위 금액의 만/백만/억/조 환산값만 허용한다."""
    allowed: set[str] = set()
    for src in sources:
        for tok in numbers_in(src):
            allowed.add(tok)
            if tok.isdigit():
                n = int(tok)
                for d in _UNIT_DIVISORS:
                    if n >= d:
                        allowed.add(str(n // d))
    return allowed


def _normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


# 숫자에 붙은 한글 단위. 원문이 "19,300,000,000"(원)인데 답변이 "19,300억 원"이면
# 숫자 자체는 원문에서 왔지만 100배 틀린 금액이 된다 — 실측(N11)에서 그대로 통과했다.
UNIT_MULTIPLIER = {"조": 10**12, "천억": 10**11, "억": 10**8,
                   "천만": 10**7, "백만": 10**6, "만": 10**4}
NUM_UNIT_RE = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(조|천억|천만|백만|억|만)\s*원?")
# 반올림·근사 표현("약 19억원" ← 1,930,000,000)을 살려두기 위한 여유.
# 잡으려는 것은 자릿수 오류(100배·1000배)라 5%는 충분히 좁다.
SCALE_TOLERANCE = 0.05


def _source_values(sources: Iterable[str]) -> list[float]:
    out: list[float] = []
    for src in sources:
        for tok in numbers_in(src):
            try:
                out.append(float(tok))
            except ValueError:
                continue
    return out


def unit_mismatches(answer: str, sources: Iterable[str],
                    derived: Iterable[str] = ()) -> list[str]:
    """답변의 "숫자+단위"가 원문 금액과 자릿수가 맞는지 본다.

    통과 조건은 셋 중 하나다.
      · 원문 어딘가에 그 표기가 그대로 있다("193억")
      · 환산값이 원문 숫자와 (오차 1% 안에서) 같다
      · 코드가 계산한 값이다(derived)
    셋 다 아니면 자릿수가 틀린 것이다.
    """
    source_text = "\n".join(sources)
    values = _source_values([source_text])
    derived_values = _source_values(derived)
    bad: list[str] = []
    for m in NUM_UNIT_RE.finditer(answer):
        raw, unit = m.group(1), m.group(2)
        try:
            implied = float(raw.replace(",", "")) * UNIT_MULTIPLIER[unit]
        except (ValueError, KeyError):
            continue
        if f"{raw}{unit}" in source_text or f"{raw} {unit}" in source_text:
            continue
        pool = values + derived_values
        if any(v and abs(v - implied) / max(abs(implied), 1.0) <= SCALE_TOLERANCE
               for v in pool):
            continue
        bad.append(m.group().strip())
    return bad


def validate(
    answer: str,
    citations: list[dict[str, Any]],
    sources: list[dict[str, Any]],
    derived: Iterable[str] = (),
) -> dict[str, Any]:
    """citations = [{document_id, quote_or_fact}], sources = RetrievedDoc.to_dict() 목록.

    derived: **코드가 계산해서 만든 숫자**만 넣는다(agents/calculator.py 산출물).
    원문에 없는 숫자를 무조건 허용하는 것이 아니라, 코드가 원본 값에서 계산한 결과만
    따로 허용 목록에 넣는 것이다. LLM이 스스로 만든 계산값은 여기에 들어오지 않으므로
    여전히 UNSUPPORTED로 잡힌다."""
    source_texts = [s["text"] for s in sources]
    haystack = _normalize_ws("\n".join(source_texts))
    by_doc: dict[str, list[str]] = {}
    for s in sources:
        by_doc.setdefault(s["document_id"], []).append(s["text"])

    checks: list[dict[str, Any]] = []
    hard_fail = False
    soft_fail = False

    # 1) 인용 검사 — quote_or_fact가 실제 원문의 부분 문자열인가
    for c in citations:
        quote = _normalize_ws(c.get("quote_or_fact", ""))
        doc_id = c.get("document_id", "")
        scope = _normalize_ws("\n".join(by_doc.get(doc_id, []))) if doc_id in by_doc else ""
        ok_in_doc = bool(quote) and quote in scope
        ok_anywhere = bool(quote) and quote in haystack
        checks.append({
            "check": "quote_grounded",
            "document_id": doc_id,
            "quote": c.get("quote_or_fact", "")[:120],
            "passed": ok_in_doc,
            "note": "" if ok_in_doc else (
                "다른 문서에서는 발견됨(document_id 불일치)" if ok_anywhere
                else "검색된 원문에서 찾을 수 없음"
            ),
        })
        if not ok_anywhere:
            hard_fail = True
        elif not ok_in_doc:
            soft_fail = True

    # 2) 숫자 검사 — 답변의 모든 숫자가 원문에 있는가
    #    연도(19xx/20xx)는 아래 period 검사가 따로 맡는다. 잘못된 연도는 '수치 날조'가
    #    아니라 '기간 오귀속'이라 등급이 달라야 하기 때문이다.
    allowed = allowed_numbers(source_texts)
    derived_set = {_norm_num(d) for d in derived}
    fabricated = [n for n in numbers_in(answer)
                  if n not in allowed and n not in derived_set
                  and not YEAR_RE.fullmatch(n)]
    checks.append({
        "check": "numbers_grounded",
        "passed": not fabricated,
        "fabricated": fabricated,
        "derived_allowed": sorted(derived_set),
        "note": "" if not fabricated else "원문에 없는 수치",
    })
    if fabricated:
        hard_fail = True

    # 2-1) 단위 검사 — 숫자는 원문에서 왔지만 자릿수를 바꿔 쓴 경우
    #      "19,300,000,000원"을 "19,300억 원"으로 옮기면 100배가 된다. 숫자 검사만으로는
    #      못 잡는다(19300은 백만 단위 환산값으로 이미 허용되기 때문).
    scale_errors = unit_mismatches(answer, source_texts, derived)
    checks.append({
        "check": "units_consistent",
        "passed": not scale_errors,
        "mismatched": scale_errors,
        "note": "" if not scale_errors else "원문 금액과 자릿수가 맞지 않는 단위 표기",
    })
    if scale_errors:
        hard_fail = True

    # 3) 기간(연도) 검사
    bad_years = [y.group() for y in YEAR_RE.finditer(answer) if y.group() not in haystack]
    checks.append({
        "check": "period_grounded",
        "passed": not bad_years,
        "unsupported_years": sorted(set(bad_years)),
    })
    if bad_years:
        soft_fail = True

    # 4) 판단어 검사 — 원문에 없는 평가·해석
    inferences = [t for t in JUDGMENT_TERMS if t in answer and t not in haystack]
    checks.append({
        "check": "no_unsupported_inference",
        "passed": not inferences,
        "inferences": inferences,
        "note": "" if not inferences else "원문이 직접 말하지 않은 판단 표현",
    })
    if inferences:
        soft_fail = True

    if hard_fail:
        status = "UNSUPPORTED"
    elif soft_fail:
        status = "PARTIALLY_SUPPORTED"
    else:
        status = "SUPPORTED"

    return {
        "status": status,
        "checks": checks,
        "n_sources": len(sources),
        "n_citations": len(citations),
    }
