"""⓪ 정책 게이트 — v4 §6 ⓪: 지시문 무력화 · 투자의견 거절 템플릿 · 상대 시점은 컷오프 기준 해석·명시.

LLM 없이 규칙만으로 판정한다(안전성은 채점 축이고, 게이트가 LLM이면 게이트 자체가 공격면이 된다).

세 가지 판정:
  1. 투자의견·추천·예측 요구  → REFUSE. 대회 규정(주가 예측·종목 추천·투자의견 생성 금지) 거절 템플릿.
     단, 공시에 적힌 내용(회사가 스스로 밝힌 계획·전망)을 묻는 질문은 사실 조회이므로 거절하지 않는다.
  2. 프롬프트 인젝션           → PROCEED + 무력화. 질문은 데이터다 — 지시문은 따르지 않고, 남은 사실 질의만
     평소 파이프라인으로 처리하며 답변에 고지 한 줄을 붙인다. (사실 질의가 없으면 검색이 빈손이 되고
     기존 "근거 없음" 경로가 안전하게 답한다.)
  3. 상대 시점("현재"·"최근"·"지금") → PROCEED + 고지. 코퍼스 컷오프(2026-03-31, v4 §6 ⓪) 기준으로
     해석함을 명시한다.

출력 Decision은 answer_api가 소비한다. 검색·답변 로직에는 관여하지 않는다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

CORPUS_CUTOFF = "2026-03-31"        # v4 §6 ⓪ "상대 시점은 컷오프 2026-03-31 기준 해석·명시"

REFUSAL_ANSWER = (
    "요청하신 내용은 투자 판단·추천·전망에 해당하여 답변할 수 없다. "
    "이 서비스는 제공된 공시 코퍼스에 기록된 사실만 근거로 답한다 — 주가 예측, 종목 추천, "
    "매수·매도 의견, 투자 적정성 판단은 생성하지 않는다. "
    "공시에 기재된 사실(재무 수치, 계약, 지분 변동, 회사가 스스로 공시한 계획 등)을 물으면 근거와 함께 답한다."
)
REFUSAL_UNCERTAINTY = "대회 규정 및 서비스 정책: 미래 예측·투자의견·종목 추천 생성 금지."
INJECTION_NOTICE = "※ 질문에 포함된 지시문은 공시 질의가 아니므로 따르지 않았다. 공시 사실 질의에만 답한다."
TIME_NOTICE_TEMPLATE = "※ '{word}'은(는) 제공 코퍼스 기준일({cutoff}) 시점으로 해석했다."

# ---------- 어휘 (구현 세부 — v4는 범주만 정한다) ----------

# 무조건 거절 — 사실 조회 신호가 있어도 투자 판단 요구 자체는 사라지지 않는다.
# ("공시를 보고 매수 추천해줘"는 공시 조회가 아니라 추천 요구다 — 검수 재현으로 확인된 우회.)
# "매수" 단독은 여기 없다: 전환사채매수선택권·주식매수청구권 같은 공시 용어와 겹친다(실측 1건).
_ADVICE_HARD_RES = tuple(re.compile(p) for p in (
    r"(매수|매도|손절|익절)\s*(추천|의견|타이밍)",
    r"(종목|주식|회사|기업)[^\n]{0,10}추천",
    r"(뭘|뭐를|무엇을)\s*(사|매수|투자)",
    r"(어느|어떤)\s*(종목|주식|회사|기업)[^\n]{0,8}(사|매수|투자)",
    r"(사는\s*게|사는게|파는\s*게|파는게|살\s*만|살만|팔\s*만|팔만)\s*(좋|나|낫|맞)",
    r"(사도|팔아도|사야|팔아야)\s*(될까|되나|할까|하나|좋)",
    r"(매수|매도)\s*(해야|할까|할\s*만|하는\s*게)",
    r"투자\s*(해도\s*될까|할까|할\s*만|하기\s*좋|하면\s*좋)",
    r"목표\s*주가",
    r"(오를까|떨어질까|상승할까|하락할까)",
    r"수익률?\s*(예상|예측|전망|보장)",
))
# 투자의견·예측 요구(약한 신호). "전망"·"계획" 단독은 아님 — 회사가 공시한 전망을 묻는 건 사실 조회다.
_ADVICE_RES = tuple(re.compile(p) for p in (
    r"(매수|매도|손절|익절)\s*(해야|할까|하는\s*게)",
    r"투자(해도|할까|할\s*만|하기\s*좋|해야|하면\s*좋)",
    r"(주가|주식\s*가격|시세)[^\n]{0,12}(오를|내릴|떨어질|상승할|하락할|어떻게\s*될|예측|전망)",
    r"유망(한|해\s*보이는)?\s*(종목|주식|기업)",
    r"(오를|떨어질|망할|망하)\s*것\s*같",
    r"어디에?\s*투자",
))
# 공시 사실 조회 신호 — 이게 있으면 "전망" 류 표현이 있어도 거절하지 않는다(회사가 공시한 내용 조회).
_FACT_RES = tuple(re.compile(p) for p in (
    r"공시(에|된|서|를|와|기준)", r"보고서(에|의|를)", r"기재(된|되어)", r"밝힌", r"명시(된|한)",
    r"사업보고서|분기보고서|반기보고서|주요사항보고서|대량보유",
))

# 프롬프트 인젝션 신호. 발췌 안 지시문은 SYSTEM_PROMPT가 이미 무시한다 — 여기는 질문 자체.
_INJECTION_RES = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"(이전|위|앞|기존|모든)\s*(지시|명령|규칙|프롬프트|instructions?)[^\n]{0,10}(무시|잊|취소|무효)",
    r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions?",
    r"(시스템|system)\s*(프롬프트|prompt|메시지)[^\n]{0,14}(출력|공개|알려|보여|말해)",
    r"(너의|너에게\s*주어진|내부)\s*(지시|규칙|프롬프트)[^\n]{0,14}(출력|공개|알려|보여)",
    r"너는\s*이제(부터)?\s*[^\n]{0,20}(이다|야|역할|모드)",
    r"(역할|규칙|제한|정책)[^\n]{0,8}(바꿔|해제|무시|풀어)",
    r"(개발자|관리자|admin|developer)\s*(모드|mode)",
    r"jailbreak|DAN\b",
    r"(지금부터|이제부터)\s*너는",
    r"(api\s*키|환경\s*변수|환경변수|비밀번호|자격\s*증명|secret|credential)[^\n]{0,12}(알려|보여|출력|공개|말해)",
    r"(값|숫자|수치|근거)[^\n]{0,14}(만들어|지어내|지어|생성해)[^\n]{0,8}(알려|답|줘)",
    r"검증[^\n]{0,6}(끄|없이|빼)",
))

_RELATIVE_TIME_RE = re.compile(r"(현재|지금|요즘|오늘날|최근)")

# 코퍼스 기간 밖의 미래 연도(v4 §6: 기간 밖이면 OUT_OF_SCOPE로 LLM 0회 종료).
# 컷오프가 2026-03-31이므로 2027년 이후를 명시한 질문은 검색 자체가 무의미하다.
# 2026년은 1분기까지 걸쳐 있으므로 여기서 자르지 않는다(일반 경로가 근거 유무로 답한다).
# "FY2027"·"2027 회계연도"·"2027년도"도 잡는다(검수 3차 재현 — 년 접미사만으로는 우회).
_FUTURE_YEAR_RE = re.compile(
    r"FY\s*(202[7-9]|20[3-9][0-9])|(202[7-9]|20[3-9][0-9])\s*(?:년도|년|회계연도|사업연도)",
    re.IGNORECASE)

OUT_OF_SCOPE_ANSWER_TEMPLATE = (
    "{year}년은 제공된 공시 코퍼스의 범위(기준일 {cutoff}) 밖이라 답할 근거가 없다. "
    "이 서비스는 코퍼스에 수록된 공시 사실만 근거로 답하며, 미래 시점의 값은 예측하지 않는다. "
    "혹시 {cutoff} 이전의 특정 연도·분기 값을 찾는 것이라면, 그 기간을 명시해 다시 질문해 주면 "
    "해당 공시를 근거로 확인하겠다."
)


@dataclass(frozen=True)
class Decision:
    action: str                      # "proceed" | "refuse" | "out_of_scope"
    reasons: tuple[str, ...] = ()
    injection_detected: bool = False
    notices: tuple[str, ...] = ()    # 답변 끝에 붙일 고지(무력화·시점 해석)
    # 인젝션 탐지 시 지시문 스팬을 제거한 질문(빈 문자열 = 원문 그대로 사용).
    # 파이프라인·LLM에는 이것을 넘기고, 응답 wire의 question 에코는 원문을 유지한다.
    sanitized_question: str = ""

    def to_dict(self) -> dict:
        return {"action": self.action, "reasons": list(self.reasons),
                "injection_detected": self.injection_detected, "notices": list(self.notices)}


def _first_match(question: str, patterns) -> str | None:
    for p in patterns:
        m = p.search(question)
        if m:
            return m.group(0)
    return None


def screen(question: str) -> Decision:
    q = question or ""
    reasons: list[str] = []
    notices: list[str] = []

    # 강한 투자 판단 요구는 사실 조회 신호와 무관하게 거절한다 — "공시를 보고 추천해줘"의
    # '공시'는 근거 요구일 뿐, 요구 자체는 추천 생성이다(일반 사용자가 가장 흔히 묻는 형태).
    hard = _first_match(q, _ADVICE_HARD_RES)
    if hard:
        return Decision(action="refuse", reasons=(f"investment_advice:{hard}",))

    future = _FUTURE_YEAR_RE.search(q)
    if future:
        # 코퍼스 기간 밖 — 검색·LLM 없이 조기 종료(v4 §6). 연도는 answer_api가 답문에 쓴다.
        return Decision(action="out_of_scope",
                        reasons=(f"future_period:{future.group(0)}",))

    advice = _first_match(q, _ADVICE_RES)
    fact_signal = _first_match(q, _FACT_RES)
    if advice and not fact_signal:
        return Decision(action="refuse", reasons=(f"investment_advice:{advice}",))
    if advice and fact_signal:
        # 공시 사실 조회로 본다 — 다만 판단 근거를 trace에 남긴다.
        reasons.append(f"advice_like_but_fact_query:{advice}|{fact_signal}")

    injection = _first_match(q, _INJECTION_RES)
    sanitized = ""
    if injection:
        reasons.append(f"injection:{injection}")
        notices.append(INJECTION_NOTICE)
        # 지시문 스팬을 지운 질문을 만든다 — 탐지만 하고 원문을 그대로 LLM에 넘기면
        # 프롬프트 노출 등 비수치 탈선 여지가 남는다(검수 발견 7). 사실 질의가 안 남으면
        # 빈 검색 → 기존 "근거 없음" 경로가 안전하게 답한다.
        sanitized = q
        for p in _INJECTION_RES:
            sanitized = p.sub(" ", sanitized)
        sanitized = re.sub(r"\s{2,}", " ", sanitized).strip()
        if sanitized == q.strip():
            sanitized = ""

    rel = _RELATIVE_TIME_RE.search(q)
    if rel:
        reasons.append(f"relative_time:{rel.group(0)}")
        notices.append(TIME_NOTICE_TEMPLATE.format(word=rel.group(0), cutoff=CORPUS_CUTOFF))

    return Decision(action="proceed", reasons=tuple(reasons),
                    injection_detected=bool(injection), notices=tuple(notices),
                    sanitized_question=sanitized)
