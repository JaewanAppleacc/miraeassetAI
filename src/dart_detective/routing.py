"""③ answer_type · execution_strategy 판정과 LLM 예산 — Team Architecture v4 §7.

역할은 두 가지뿐이다.

    1. 질문 텍스트에서 전략(7종)을 정한다 — 판정 순서는 v4 §7 "판정(순서 고정)" 그대로.
    2. 전략에 따라 HCX 호출 예산(발췌 개수·maxTokens)을 정한다 — v4 §7 "실행 매트릭스" 그대로.

검색·근거 선택·검증에는 관여하지 않는다. 이 모듈은 dart_detective의 다른 모듈을 import하지
않는다(순환 방지). 필요한 신호(slot 수, 값 의문 여부, 코퍼스 존재 규칙 적중 여부)는 호출자가 넘긴다.

v4 §7 원문(요약):
    strategy 7종: DIRECT_LOOKUP · COMPARISON · CALCULATION · ENUMERATION · COUNT
                  · EXISTENCE_CHECK · NARRATIVE(기본)
    판정(순서 고정): 집계어+패밀리어 매치 → (몇 건→COUNT / 존재→EXISTENCE / 그 외→ENUMERATION,
                     최상급 "가장·최대"는 ENUMERATION→max로 CLOSED 답)
                   → 서술어(정리·설명·비교·요약·변화)→NARRATIVE
                   → 값 의문+slot≤2→DIRECT_LOOKUP → 기본 NARRATIVE
    복구: ledger 미채택 → NARRATIVE 강등 + "전수 집계 아님" 고지
    실행 매트릭스: DIRECT/COMPARISON/CALC top8·max512 · ENUMERATION ledger·max768
                  · COUNT/EXISTENCE ledger 카운트·0~1회·max256 · NARRATIVE top20·max1024
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

STRATEGIES = (
    "DIRECT_LOOKUP", "COMPARISON", "CALCULATION",
    "ENUMERATION", "COUNT", "EXISTENCE_CHECK", "NARRATIVE",
)
ANSWER_TYPES = ("CLOSED", "OPEN_ENDED")   # v4 §7: 외부 노출은 이 둘만. LIST는 공식 유형 아님.

LEDGER_NOTICE = "전수 집계 아님: 검색된 공시 범위에서 정리한 결과다."


@dataclass(frozen=True)
class Budget:
    """HCX 호출 한 번의 예산. v4 §7 실행 매트릭스."""
    context_chunks: int     # 프롬프트에 넣는 검색 발췌 수(top-k). ledger/rule 경로는 0.
    max_tokens: int         # HCX maxTokens. TPM 한도는 입력 + 이 값으로 계산된다.
    llm_calls: int          # 허용 호출 수(0 또는 1). 2-call은 게이트 통과 시만(v4 §3) — 여기서는 1.
    source: str             # "retrieval" | "ledger" | "rule"

    def to_dict(self) -> dict[str, Any]:
        return {"context_chunks": self.context_chunks, "max_tokens": self.max_tokens,
                "llm_calls": self.llm_calls, "source": self.source}


# v4 §7 실행 매트릭스 — 숫자를 바꾸면 설계 변경이다.
BUDGETS: dict[str, Budget] = {
    "DIRECT_LOOKUP":   Budget(context_chunks=8,  max_tokens=512,  llm_calls=1, source="retrieval"),
    "COMPARISON":      Budget(context_chunks=8,  max_tokens=512,  llm_calls=1, source="retrieval"),
    "CALCULATION":     Budget(context_chunks=8,  max_tokens=512,  llm_calls=1, source="retrieval"),
    "ENUMERATION":     Budget(context_chunks=0,  max_tokens=768,  llm_calls=1, source="ledger"),
    "COUNT":           Budget(context_chunks=0,  max_tokens=256,  llm_calls=1, source="ledger"),
    "EXISTENCE_CHECK": Budget(context_chunks=0,  max_tokens=256,  llm_calls=0, source="rule"),
    "NARRATIVE":       Budget(context_chunks=20, max_tokens=1024, llm_calls=1, source="retrieval"),
}


@dataclass(frozen=True)
class Route:
    strategy: str
    answer_type: str
    budget: Budget
    reasons: tuple[str, ...] = ()
    downgraded_from: str | None = None
    notice: str = ""                      # 사용자에게 고지할 문장(uncertainty에 붙는다)

    def to_dict(self) -> dict[str, Any]:
        return {
            "strategy": self.strategy,
            "answer_type": self.answer_type,
            "budget": self.budget.to_dict(),
            "reasons": list(self.reasons),
            "downgraded_from": self.downgraded_from,
            "notice": self.notice,
        }


# ---------- 어휘 ----------
# v4 §7은 "집계어·패밀리어·서술어·값 의문"이라는 범주만 정하고 어휘 목록은 정하지 않았다.
# 아래 목록은 **구현 세부(v4 미명시)** 다. 범주 자체와 판정 순서는 v4 그대로다.

# 패밀리어: 사건/공시 패밀리를 부르는 말. 집계어와 함께 나올 때만 ①로 들어간다.
FAMILY_WORDS = (
    "유상증자", "무상증자", "자기주식", "자사주", "전환사채", "신주인수권부사채", "교환사채",
    "합병", "분할", "공급계약", "단일판매", "수주", "신규시설투자", "시설투자", "타법인",
    "출자", "영업양수", "영업양도", "자산양수", "자산양도", "주식양수", "주식양도",
    "소송", "배당", "임원", "주주총회", "대량보유", "지분", "보유주식", "주식등의",
    "정정", "공시", "보고서", "계약", "투자", "발행", "취득", "처분",
)
# 집계어 — 셋으로 나뉜다. ①에서 COUNT → EXISTENCE → ENUMERATION 순으로 본다.
COUNT_WORDS = ("몇 건", "몇건", "몇 개", "몇개", "몇 번", "몇번", "몇 회", "몇회", "몇 차례",
               "건수", "횟수", "개수", "총 몇", "총몇")
EXISTENCE_WORDS = ("존재", "포함", "낸 적", "한 적", "제출한 적", "있는지 여부")
ENUMERATION_WORDS = ("모두", "전부", "모든", "목록", "나열", "열거", "리스트",
                     "어떤 것들", "무엇들", "어떤 것이 있", "무엇이 있")
SUPERLATIVE_WORDS = ("가장", "최대", "최소", "최고", "최저", "제일")

# 서술어 — v4 §7 명시 목록 그대로(정리·설명·비교·요약·변화).
NARRATIVE_WORDS = ("정리", "설명", "비교", "요약", "변화")
# "변화율"·"변화액"처럼 수치 접미사가 붙은 형태는 서술어가 아니라 값 표현이다(구현 세부).
_NARRATIVE_VALUE_FORMS = re.compile(r"(변화|비교)(율|액|량|폭|치)")

# ③ 안의 세부 — v4는 "값 의문+slot≤2 → DIRECT_LOOKUP"만 명시한다.
# COMPARISON/CALCULATION은 예산이 DIRECT와 같으므로(top8·max512) 아래 구분은 라벨에만 영향을 준다.
CALCULATION_WORDS = ("증가율", "감소율", "증감률", "증감", "증가액", "감소액",
                     "변동률", "변동액", "변화율", "변화액", "차이", "얼마나")
COMPARISON_WORDS = ("중 어느", "중 어디", "중 누가", "더 큰", "더 많", "더 높", "더 낮", "더 적",
                    "큰 곳", "높은 곳", "많은 곳")


def _hit(question: str, words: tuple[str, ...]) -> str | None:
    for w in words:
        if w in question:
            return w
    return None


# ---------- 판정 ----------

def decide_strategy(question: str, *, n_slots: int, asks_value: bool,
                    existence_hit: bool = False) -> tuple[str, tuple[str, ...], bool]:
    """v4 §7 판정 순서 그대로. 반환: (strategy, reasons, superlative)

    existence_hit: 호출자의 코퍼스 존재 규칙(qa_agent.corpus_existence)이 적중했는가.
                   적중이면 검색 없이 규칙이 답하므로 EXISTENCE_CHECK로 고정한다.
    """
    reasons: list[str] = []
    if existence_hit:
        return "EXISTENCE_CHECK", ("corpus_existence_rule",), False

    # ① 집계어 + 패밀리어
    family = _hit(question, FAMILY_WORDS)
    if family:
        count = _hit(question, COUNT_WORDS)
        if count:
            return "COUNT", (f"family:{family}", f"count:{count}"), False
        exist = _hit(question, EXISTENCE_WORDS)
        if exist:
            return "EXISTENCE_CHECK", (f"family:{family}", f"existence:{exist}"), False
        superlative = _hit(question, SUPERLATIVE_WORDS)
        if superlative:
            return "ENUMERATION", (f"family:{family}", f"superlative:{superlative}"), True
        enum = _hit(question, ENUMERATION_WORDS)
        if enum:
            return "ENUMERATION", (f"family:{family}", f"enumeration:{enum}"), False
        reasons.append(f"family:{family}")

    # ② 서술어
    stripped = _NARRATIVE_VALUE_FORMS.sub("", question)
    narrative = _hit(stripped, NARRATIVE_WORDS)
    if narrative:
        return "NARRATIVE", (*reasons, f"narrative:{narrative}"), False

    # ③ 값 의문. COMPARISON은 값 어휘 없이도 성립한다("A와 B 중 더 큰 곳은?") — 구현 세부.
    comp = _hit(question, COMPARISON_WORDS)
    if comp:
        return "COMPARISON", (*reasons, f"comparison:{comp}"), False
    if asks_value:
        calc = _hit(question, CALCULATION_WORDS)
        if calc:
            return "CALCULATION", (*reasons, "asks_value", f"calc:{calc}"), False
        if n_slots <= 2:
            return "DIRECT_LOOKUP", (*reasons, "asks_value", f"slots:{n_slots}"), False
        reasons.append(f"asks_value_but_slots:{n_slots}")

    # ④ 기본
    return "NARRATIVE", (*reasons, "default"), False


def answer_type_of(strategy: str, superlative: bool = False) -> str:
    if strategy == "NARRATIVE":
        return "OPEN_ENDED"
    if strategy == "ENUMERATION":
        return "CLOSED" if superlative else "OPEN_ENDED"
    return "CLOSED"


def route(question: str, *, n_slots: int, asks_value: bool,
          existence_hit: bool = False, ledger_available: bool = False) -> Route:
    """전략 + 예산 + 강등을 한 번에. answer_question이 검색 전에 한 번 부른다.

    ledger_available: event ledger(v4 §3 조건부 게이트)가 채택됐는가. 아직 PROPOSED라 기본 False.
                      False면 ENUMERATION/COUNT는 v4 §7 복구 규칙대로 NARRATIVE로 강등한다.
    """
    strategy, reasons, superlative = decide_strategy(
        question, n_slots=n_slots, asks_value=asks_value, existence_hit=existence_hit)
    answer_type = answer_type_of(strategy, superlative)

    # v4 §7 복구: ledger 미채택 → NARRATIVE 강등 + 고지. 규칙(corpus_existence)이 못 잡은
    # EXISTENCE_CHECK도 ledger 카운트 경로라 같은 강등을 받는다(존재 규칙 적중 시엔 조기 종료).
    needs_ledger = strategy in ("ENUMERATION", "COUNT") or (
        strategy == "EXISTENCE_CHECK" and not existence_hit)
    if needs_ledger and not ledger_available:
        return Route(
            strategy="NARRATIVE",
            answer_type="OPEN_ENDED",
            budget=BUDGETS["NARRATIVE"],
            reasons=(*reasons, "ledger_unavailable"),
            downgraded_from=strategy,
            notice=LEDGER_NOTICE,
        )
    return Route(strategy=strategy, answer_type=answer_type, budget=BUDGETS[strategy],
                 reasons=reasons)
