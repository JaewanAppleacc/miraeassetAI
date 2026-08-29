"""질문 -> 공시 검색 조건.

공시 질문은 거의 항상 네 가지를 함께 말한다.

    기업 + 기간 + 공시유형 + 사건 식별어

지금까지의 실측에서 검색 실패의 대부분이 이 조건들을 **검색이 전혀 보지 않아서**
생겼다(다른 기업의 사업보고서가 상위를 점령하는 식). 여기서 그 조건을 구조화한다.

기간에 대한 주의 — 실측으로 확인된 함정:
    사업보고서 (2025.12)는 **2026년 3월에 접수**된다. 질문의 "2025년"을 접수일에
    걸면 정답 문서가 통째로 탈락한다. 그래서 정기공시는 manifest의
    `base_year`(보고서 기준연도)로, 나머지 공시는 사건 발생일 = `rcept_dt`로 본다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .corp_dictionary import CorpDictionary

YEAR_RE = re.compile(r"(20\d{2})\s*년")
MONTH_RE = re.compile(r"(20\d{2})\s*년\s*(\d{1,2})\s*월")
HANGUL_RUN_RE = re.compile(r"[가-힣]{2,}")
LATIN_RUN_RE = re.compile(r"[A-Za-z][A-Za-z0-9&#\-]{1,}")

# 질문 -> doc_group. 여러 개가 잡히면 전부 유지한다(multi-hop 질문은 그룹을 넘나든다).
GROUP_RULES: dict[str, tuple[str, ...]] = {
    "periodic": ("사업보고서", "분기보고서", "반기보고서", "분기", "반기", "연결",
                 "매출액", "영업이익", "실적", "재무", "성장"),
    "exchange": ("계약", "공급계약", "수주", "해지", "설비투자", "시설투자", "투자 규모",
                 "투자규모", "투자 계획", "투자계획", "LOI", "본계약", "프로젝트",
                 "허가", "유보"),
    "major": ("자기주식", "신탁", "유상증자", "소각", "취득", "처분", "발행", "증자"),
    "holding": ("대량보유", "지분율", "보유주식", "보유지분", "지분", "보고자"),
}

PERIODIC_SUBTYPE_RULES: dict[str, tuple[str, ...]] = {
    "annual": ("사업보고서", "연간", "연도별"),
    "half": ("반기",),
    "quarter": ("분기",),
}
EXCHANGE_SUBTYPE_RULES: dict[str, tuple[str, ...]] = {
    "신규시설투자등": ("설비투자", "시설투자", "투자 규모", "투자규모", "투자 계획",
                  "투자계획", "증설"),
    "단일판매공급계약해지": ("해지", "종료된 계약"),
    "단일판매공급계약체결": ("계약금액", "공급계약", "계약기간", "수주", "본계약", "계약"),
    "투자판단관련주요경영사항": ("허가", "LOI", "투자판단", "경영사항", "유보"),
}
# major는 manifest에 doc_subtype이 비어 있다. report_nm 괄호 안 문구로 라벨링한다.
MAJOR_LABEL_RULES: dict[str, tuple[str, ...]] = {
    "자기주식": ("자기주식", "자사주", "신탁", "소각"),
    "유상증자": ("유상증자", "증자", "발행 주식", "발행주식"),
}

CORRECTION_WORDS = ("정정", "정정공시", "기재정정")
# "최신 유효 계약조건"처럼 chain의 마지막 상태를 묻는 질문. 시간순 가산의 스위치다.
LATEST_WORDS = ("최신", "최종", "현재", "유효", "가장 최근")

# 조건이 아니라 질문 형식에서 오는 말 — 사건 식별어 후보에서 뺀다.
_ASK_WORDS = frozenset({
    "얼마인가", "얼마나", "무엇인가", "어디인가", "어떻게", "어떤", "각각", "비교",
    "정리해줘", "설명해줘", "알려줘", "기준", "기준으로", "대비", "이후", "이번",
    "직전", "최근", "당시", "실제로", "여전히", "구분해줘", "포함", "관련", "공시",
    "보고서", "질문", "경우", "내용", "사항", "상태", "변화", "결과", "때문",
})

# 조사·어미. 붙은 채로 두면 "영업이익은"처럼 흔한 말이 코퍼스에서는 희소해 보여
# 사건 식별어 자리를 뺏는다(실측에서 실제로 그랬다).
_PARTICLES: tuple[str, ...] = (
    "이라는", "라는", "으로써", "에서의", "으로서", "에게서", "까지의", "부터의",
    "이었다", "였다", "이며", "이고", "인지", "은지", "하는", "했던", "하던",
    "에서", "으로", "에게", "까지", "부터", "보다", "만큼", "처럼", "마다",
    "이다", "이나", "이란", "라도", "라면", "면서", "지만",
    "은", "는", "이", "을", "를", "의", "와", "만",
    "한", "된", "할", "했", "며", "에",
)
# 명사 끝 음절과 구분되지 않는 것은 뺐다:
#   서/고/여/야 (보고서·신고·참여·분야), 가/과/도/로 (판매허가·영업성과·사업연도·판매경로)


def strip_particles(term: str) -> str:
    """한글 어절에서 조사·어미를 **한 번만** 벗겨 낸다.

    반복해서 벗기면 "사업보고서를"이 "사업보"까지 깎인다(를 -> 서 -> 고).
    한 번만 벗기는 것으로 "영업이익은" -> "영업이익"은 충분히 잡힌다.
    """
    for suf in _PARTICLES:
        if len(term) - len(suf) >= 2 and term.endswith(suf):
            return term[: -len(suf)]
    return term


@dataclass(frozen=True)
class QueryConditions:
    """질문에서 뽑아낸 검색 조건. 어떤 것을 hard로 쓸지는 Retriever가 정한다."""

    corps: frozenset[str] = frozenset()
    years: frozenset[int] = frozenset()
    year_months: frozenset[tuple[int, int]] = frozenset()
    doc_groups: frozenset[str] = frozenset()
    periodic_subtypes: frozenset[str] = frozenset()
    exchange_subtypes: frozenset[str] = frozenset()
    major_labels: frozenset[str] = frozenset()
    correction: bool = False
    wants_latest: bool = False
    candidate_terms: tuple[str, ...] = field(default=())

    def as_dict(self) -> dict:
        return {
            "corps": sorted(self.corps),
            "years": sorted(self.years),
            "year_months": sorted(self.year_months),
            "doc_groups": sorted(self.doc_groups),
            "periodic_subtypes": sorted(self.periodic_subtypes),
            "exchange_subtypes": sorted(self.exchange_subtypes),
            "major_labels": sorted(self.major_labels),
            "correction": self.correction,
            "wants_latest": self.wants_latest,
            "candidate_terms": list(self.candidate_terms),
        }


def _match_rules(question: str, rules: dict[str, tuple[str, ...]]) -> frozenset[str]:
    return frozenset(k for k, kws in rules.items() if any(w in question for w in kws))


def _variants(run: str) -> list[str]:
    """한글 어절 하나에서 뽑을 후보 표기들 — 원형, 조사 제거형, 끝 한 글자 제거형."""
    out = [run, strip_particles(run)]
    if len(run) >= 3:
        out.append(run[:-1])
    seen: set[str] = set()
    return [t for t in out if len(t) >= 2 and not (t in seen or seen.add(t))]


def _candidate_terms(question: str, corps: frozenset[str],
                     corp_dict: CorpDictionary) -> tuple[str, ...]:
    """사건을 특정할 가능성이 있는 말만 남긴다.

    무엇이 '희소한 말'인지는 여기서 정하지 않는다 — 코퍼스 document frequency를
    아는 쪽(DocumentIndex)이 정한다. 여기서는 기업명과 질문투 어휘만 걷어낸다.
    """
    corp_surface = {a for a in corp_dict.alias_to_corp if corp_dict.alias_to_corp[a] in corps}
    out: list[str] = []
    seen: set[str] = set()
    for m in HANGUL_RUN_RE.finditer(question):
        raw = m.group()
        # 조사 사전은 완벽할 수 없다. "유보기한과"의 "과"를 벗기면 "영업성과"도 깎인다.
        # 그래서 변형을 여러 개 내보내고, 실제로 코퍼스에 존재하는지(document frequency)로
        # 거르는 일은 인덱스에 맡긴다 — 존재하지 않는 변형은 df=0으로 자동 탈락한다.
        for term in _variants(raw):
            key = term.lower()
            if len(term) < 2 or key in seen or term in _ASK_WORDS:
                continue
            if any(surface and surface in key for surface in corp_surface):
                continue
            seen.add(key)
            out.append(term)
    for m in LATIN_RUN_RE.finditer(question):
        term = m.group()
        key = term.lower()
        if key in seen or key in _ASK_WORDS:
            continue
        if any(surface and surface in key for surface in corp_surface):
            continue
        seen.add(key)
        out.append(term)
    return tuple(out)


def extract_conditions(question: str, corp_dict: CorpDictionary) -> QueryConditions:
    corps = frozenset(corp_dict.match(question))
    years = frozenset(int(y) for y in YEAR_RE.findall(question))
    year_months = frozenset((int(y), int(mm)) for y, mm in MONTH_RE.findall(question))
    return QueryConditions(
        corps=corps,
        years=years,
        year_months=year_months,
        doc_groups=_match_rules(question, GROUP_RULES),
        periodic_subtypes=_match_rules(question, PERIODIC_SUBTYPE_RULES),
        exchange_subtypes=_match_rules(question, EXCHANGE_SUBTYPE_RULES),
        major_labels=_match_rules(question, MAJOR_LABEL_RULES),
        correction=any(w in question for w in CORRECTION_WORDS),
        wants_latest=any(w in question for w in LATEST_WORDS),
        candidate_terms=_candidate_terms(question, corps, corp_dict),
    )
