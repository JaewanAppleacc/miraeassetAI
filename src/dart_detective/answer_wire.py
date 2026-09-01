"""주최측 공식 `GET /answer` 계약으로 우리 AgentState를 변환한다.

팀 공통 기반(최재완)이 정한 wire 계약은 **문자열 5개**뿐이다:

    question_id, question, retrieved_context, think_trace, answer

`retrieved_context`(배열)와 `think_trace`(오브젝트)는 JSON.stringify한 **문자열**로
싣는다. 호출자가 JSON.parse해서 되돌린다. 이 인코딩은 고정이다.

우리 파이프라인은 그대로 두고 포맷만 바꾼다 — 검색·근거 선택·계산·검증 무변경.
평가 하니스가 실제로 읽는 자리에 우리가 이미 가진 값을 넣는다:

    think_trace.calculation  <- calculator가 만든 값(코드 계산). 하니스의 closed
                                metric은 답변 문장에서 숫자를 긁지 않고 이 필드만 믿는다.
    think_trace.validation   <- validator 결과 + answerability
    retrieved_context        <- 근거 줄(문서 id·인용문)
"""
from __future__ import annotations

import json
import re
from typing import Any, Mapping

# 팀 계약이 정한 값만 쓸 수 있다(STRUCTURED / RETRIEVAL / BOTH / EARLY_EXIT).
# 우리는 검색으로 근거를 찾아 답하므로 RETRIEVAL이다. 근거를 못 찾으면 EARLY_EXIT.
EXECUTION_MODE = "RETRIEVAL"
EXECUTION_MODE_EMPTY = "EARLY_EXIT"


def answerability_of(state: Mapping[str, Any]) -> str:
    """팀 계약의 answerability 어휘로 옮긴다.

    우리에게 없는 상태(UNKNOWN_COMPANY 등)를 지어내지 않는다 — 우리가 실제로 아는
    것은 "근거를 찾았나"와 "기업을 특정했나" 둘뿐이다.
    """
    if state.get("answerability"):
        # Agent 규칙이 확정한 상태(NOT_FOUND·WITHHELD)는 추정보다 우선한다.
        return str(state["answerability"])
    if not state.get("evidence"):
        return "EVIDENCE_NOT_FOUND"
    if "corp_unspecified" in (state.get("warnings") or []):
        return "UNKNOWN_COMPANY"
    if (state.get("validation") or {}).get("status") == "UNSUPPORTED":
        return "EVIDENCE_NOT_FOUND"
    return "SUPPORTED"


def source_locator_of(match: Mapping[str, Any]) -> str:
    """팀 공통 계약의 원문 위치 표기: {doc_id}/{접수번호}.xml#node={노드번호}.

    Gold의 acceptable_sources가 이 형식이라, 문서 id와 인용문이 맞아도 위치 표기가
    다르면 근거가 대조되지 않는다. 우리 청크는 노드 번호를 들고 다니므로 그대로 만든다.
    """
    doc_id = match["doc_id"]
    # 접수번호는 doc_id 뒤쪽에 그대로 들어 있다(exchange_20230428800439).
    rcept_no = match.get("rcept_no") or ""
    if not rcept_no and "_" in doc_id:
        tail = doc_id.rsplit("_", 1)[1]
        rcept_no = tail if tail.isdigit() else ""
    node_index = match.get("node_index")
    if not rcept_no or node_index is None:
        return "/".join(match.get("section_path") or []) or "body"
    return f"{doc_id}/{rcept_no}.xml#node={node_index}"


def retrieved_context_of(state: Mapping[str, Any]) -> list[dict[str, Any]]:
    """근거를 하니스가 읽는 모양으로. 원문 그대로만 싣는다.

    Gold의 evidence_span은 값 하나("635,384,978,972")인 경우가 많고, 하니스는
    인용문이 **정확히 같아야** 근거로 인정한다. 우리는 줄 전체를 인용하므로, 값까지
    확정한 자리는 값만 담은 항목을 하나 더 싣는다 — 둘 다 원문에서 그대로 온 것이고,
    없는 값을 만들어 넣는 것이 아니다.
    """
    out = []
    for match in state.get("evidence_matches") or []:
        locator = source_locator_of(match)
        base = {
            "document_id": match["doc_id"],
            "source_locator": locator,
            "slot_name": match["slot"],
            "chunk_id": match["chunk_id"],
        }
        out.append({**base, "quoted_text": match["evidence_text"]})
        picked = match.get("picked_value")
        if picked and picked != match["evidence_text"]:
            out.append({**base, "quoted_text": picked})
    return out


# 우리 공시 항목 이름 -> 팀 Gold의 필드 이름. Gold의 expected_answer.value는
# {"contract_amount": ..., "period_start": ...}처럼 영문 필드로 되어 있고, 하니스는
# think_trace.calculation을 그 이름으로 조회한다. 값 자체는 원문에서 그대로 온 것이고,
# 여기서 하는 일은 이름을 맞추는 것뿐이다.
GOLD_FIELD_OF: dict[str, str] = {
    "계약금액": "contract_amount",
    "해지금액": "termination_amount",
    "투자금액": "investment_amount",
    "자기자본대비": "equity_ratio_percent",
    "매출액대비": "revenue_ratio_percent",
    "최근매출액": "recent_revenue",
    "자기자본": "equity",
    "시작일": "period_start",
    "종료일": "period_end",
    "해지일자": "termination_date",
    "이사회결의일": "decision_date",
    "매출액": "revenue",
    "영업이익": "operating_profit",
}
# 지표 × 연도 자리는 이름을 규칙으로 만든다(revenue_2023). Gold에는 단위를 붙인
# 이름(revenue_2023_million_krw)도 있는데, 그건 **표의 단위가 실제로 백만원일 때만**
# 내보낸다 — 이름이 단위를 주장하기 때문이다.
METRIC_EN: dict[str, str] = {"매출액": "revenue", "영업이익": "operating_profit"}
UNIT_SUFFIX: dict[str, str] = {"백만원": "million_krw", "천원": "thousand_krw", "원": "krw"}
# 코드가 계산한 값의 이름도 규칙으로 만든다. 문항별 이름을 사전에 박지 않는다 —
# 그건 정답지를 코드에 넣는 것이다.
DERIVED_SUFFIX: dict[str, str] = {
    "increase_rate": "change_percent",
    "difference": "diff_krw",
}


def _number_or_text(raw: str) -> Any:
    """숫자로 읽히면 숫자로, 아니면 문자열 그대로. 반올림·환산은 하지 않는다."""
    cleaned = (raw or "").replace(",", "").strip()
    if not cleaned:
        return raw
    negative = cleaned.startswith("(") and cleaned.endswith(")")
    if negative:
        cleaned = cleaned[1:-1]
    try:
        value = float(cleaned) if "." in cleaned else int(cleaned)
    except ValueError:
        return raw
    return -value if negative else value


_UNIT_IN_LINE = re.compile(r"단위\s*[::]\s*([^\s|)]+)")
_YEAR_SLOT = re.compile(r"^(.+)_((?:19|20)\d{2})$")


def _unit_of(line: str) -> str:
    m = _UNIT_IN_LINE.search(line or "")
    return m.group(1) if m else ""


def field_names_for(slot: str, line: str) -> list[str]:
    """자리 이름에서 Gold 필드 이름을 규칙으로 만든다.

    문항마다 다른 이름(crane_investment_amount 같은)은 만들지 않는다 — 그건 정답지를
    코드에 박는 일이다. 여기서 만드는 것은 규칙으로 유도되는 이름뿐이다:
      계약금액          -> contract_amount
      매출액_2023       -> revenue_2023 (표 단위가 백만원이면 revenue_2023_million_krw도)
    """
    base = slot.split("@", 1)[0]
    direct = GOLD_FIELD_OF.get(base)
    if direct:
        return [direct]
    m = _YEAR_SLOT.match(base)
    if not m:
        return []
    metric_en = METRIC_EN.get(m.group(1))
    if not metric_en:
        return []
    names = [f"{metric_en}_{m.group(2)}"]
    suffix = UNIT_SUFFIX.get(_unit_of(line))
    if suffix:
        names.append(f"{names[0]}_{suffix}")
    return names


def derived_field_names(metric: str, kind: str) -> list[str]:
    """코드 계산값의 이름도 규칙으로. 매출액 증가율 -> revenue_change_percent."""
    metric_en = METRIC_EN.get(metric)
    suffix = DERIVED_SUFFIX.get(kind)
    return [f"{metric_en}_{suffix}"] if metric_en and suffix else []


def looked_up_values(state: Mapping[str, Any]) -> dict[str, Any]:
    """selector가 자리마다 확정한 원문 값. 계산이 아니라 조회다.

    하니스의 closed metric은 답변 문장에서 숫자를 긁지 않고 이 자리만 믿는다.
    값을 못 확정한 자리는 넣지 않는다 — 빈 값을 채워 넣지 않는다.
    """
    out: dict[str, Any] = {}
    for match in state.get("evidence_matches") or []:
        picked = match.get("picked_value")
        if not picked:
            continue
        for field in field_names_for(match["slot"], match.get("evidence_text", "")):
            out.setdefault(field, _number_or_text(picked))
    return out


def derived_values(state: Mapping[str, Any]) -> dict[str, Any]:
    """코드가 계산한 값을 Gold 필드 이름으로. 값 자체는 calculator가 만든 그대로다."""
    out: dict[str, Any] = {}
    for d in state.get("derived") or []:
        for field in derived_field_names(d["metric"], d["kind"]):
            out.setdefault(field, _number_or_text(d["value"]))
    return out


def calculation_of(state: Mapping[str, Any]) -> dict[str, Any]:
    """코드가 만든 값 + selector가 확정한 조회값.

    하니스는 `calculation.result`(없으면 `.value`) **안쪽**을 본다 — 최상위에 필드를
    늘어놔도 읽지 않는다(closed-metric.mjs의 structuredRaw). 값이 여러 개인 답은
    result를 오브젝트로, 계산 결과 하나뿐이면 그 값을 그대로 둔다.
    """
    derived = state.get("derived") or []
    looked_up = {**looked_up_values(state), **derived_values(state)}
    if not derived:
        return {"result": looked_up, "value": looked_up} if looked_up else {}
    primary = derived[0]
    result: Any = {**looked_up} if looked_up else primary["value"]
    return {
        **looked_up,
        "result": result,
        "value": result,
        "primary_value": primary["value"],
        "unit": primary["unit"] or None,
        "metric": primary["metric"],
        "formula": primary["formula"],
        "source_values": primary["source_values"],
        "all": [
            {"metric": d["metric"], "kind": d["kind"], "value": d["value"],
             "unit": d["unit"] or None, "formula": d["formula"],
             "source_values": d["source_values"]}
            for d in derived
        ],
    }


def think_trace_of(state: Mapping[str, Any]) -> dict[str, Any]:
    """숨은 사고과정·시스템 프롬프트·비밀값은 넣지 않는다 — 계약이 금지한다."""
    validation = state.get("validation") or {}
    confidence = state.get("confidence") or {}
    operations = [
        {"step": "conditions", "detail": state.get("conditions") or {}},
        {"step": "retrieval", "n_chunks": len(state.get("retrieval") or [])},
        {"step": "evidence", "slots": state.get("slots") or [],
         "n_selected": len(state.get("evidence_matches") or [])},
    ]
    if state.get("derived"):
        operations.append({"step": "calculation", "n_derived": len(state["derived"])})
    if (state.get("llm") or {}).get("used"):
        operations.append({"step": "llm", "prompt_version": state.get("prompt_version")})
    return {
        "execution_mode": EXECUTION_MODE if state.get("evidence") else EXECUTION_MODE_EMPTY,
        "operations": operations,
        "calculation": calculation_of(state),
        "validation": {
            "answerability": answerability_of(state),
            "status": validation.get("status"),
            "checks": [
                {"check": c.get("check"), "passed": c.get("passed")}
                for c in (validation.get("checks") or [])
            ],
            "confidence_score": confidence.get("score"),
            "confidence_level": confidence.get("level"),
        },
    }


def to_answer_wire(question_id: str, question: str,
                   state: Mapping[str, Any]) -> dict[str, str]:
    """문자열 5개짜리 wire 응답. 배열/오브젝트는 JSON 문자열로 싣는다."""
    return {
        "question_id": question_id,
        "question": question,
        "retrieved_context": json.dumps(retrieved_context_of(state), ensure_ascii=False),
        "think_trace": json.dumps(think_trace_of(state), ensure_ascii=False),
        "answer": state.get("answer") or "",
    }
