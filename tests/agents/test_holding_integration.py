"""대량보유 파서 통합 — 서빙 경로(answer_question→wire)에서의 승격·부분 답변·불변조건.

판 §3-2(감사 가능성)·§3-5(소비한 행만 숨김·보유목적 보존)·§4 필수 테스트의 통합분.
LLM 없음 — 결정론 경로만 본다.
"""
from __future__ import annotations

import json

import json as _json

from test_holding_parser import BASIS_DATE_LINE, HISTORY, QUESTION, SUMMARY, TRAP

from dart_corpus.retrieval import DocumentIndex, IndexedDocument
from dart_corpus.retrieval.corp_dictionary import CorpDictionary
from dart_detective import answer_wire
from dart_detective.agents import qa_agent
from dart_detective.corpus_retriever import CorpusRetriever
from dart_detective.llm import LLMResult

DOC_ID = "holding_20240403000410"
NPS_DOC = "holding_20240820000123"
PURPOSE_LINE = "5. 보유목적 | 경영권에 영향을 주기 위한 목적이 아님(단순투자)"
PREV_ROW = ("직전보고서 | 2023년 06월 02일 | MassachusettsFinancialServicesCompany | 1 | "
            "2,925,317 | 5.00 | 2,925,317 | 5.00 | 58,492,759")


def holding_retriever(*, with_prev: bool = True, with_trap: bool = False) -> CorpusRetriever:
    history = HISTORY if with_prev else "\n".join(
        l for l in HISTORY.split("\n") if not l.startswith("직전보고서"))
    nodes = [
        {"node_index": 0, "kind": "table", "section_hierarchy": ["표지"],
         "text": BASIS_DATE_LINE},
        {"node_index": 5, "kind": "table", "section_hierarchy": ["3. 보유목적"],
         "text": PURPOSE_LINE},
        {"node_index": 28, "kind": "table", "section_hierarchy": ["대량보유자에 관한 사항"],
         "text": history},
    ]
    if with_prev:
        nodes.insert(1, {"node_index": 1, "kind": "table",
                         "section_hierarchy": ["보유주식등의 수 및 보유비율"],
                         "text": SUMMARY})
    corp_dict = CorpDictionary.from_rows(
        [{"corp_name": "아모레퍼시픽", "listed_name": "아모레퍼시픽", "stock_code": "090430"}])
    docs = [IndexedDocument(
        doc_id=DOC_ID, corp_name="아모레퍼시픽", corp_code="090430",
        filer_name="Massachusetts Financial Services Company",
        doc_group="holding", doc_subtype="일반",
        report_nm="주식등의대량보유상황보고서(일반)", rcept_dt="20240403",
        base_year=2024, base_month=3, is_correction=False,
        text="\n".join(n["text"] for n in nodes))]
    docs_by_id = {DOC_ID: {"doc_id": DOC_ID, "doc_group": "holding", "nodes": nodes}}
    if with_trap:
        trap_nodes = [{"node_index": 28, "kind": "table",
                       "section_hierarchy": ["대량보유자에 관한 사항"], "text": TRAP}]
        docs.append(IndexedDocument(
            doc_id=NPS_DOC, corp_name="아모레퍼시픽", corp_code="090430",
            filer_name="국민연금공단", doc_group="holding", doc_subtype="일반",
            report_nm="주식등의대량보유상황보고서(일반)", rcept_dt="20240820",
            base_year=2024, base_month=8, is_correction=False, text=TRAP))
        docs_by_id[NPS_DOC] = {"doc_id": NPS_DOC, "doc_group": "holding",
                               "nodes": trap_nodes}
    return CorpusRetriever(
        document_index=DocumentIndex(docs, corp_dict), corp_dict=corp_dict,
        docs_by_id=docs_by_id)


class FakeLLM:
    """지정한 payload를 그대로 돌려주는 JSON 경로 모델(FC 미지원 → complete_json만)."""

    provider = "fake"

    def __init__(self, payload):
        self.payload = payload
        self.calls = 0

    def complete_json(self, system, user, schema):
        self.calls += 1
        return LLMResult(data=self.payload, provider="fake", model="fake-1",
                         latency_ms=1, raw_text=_json.dumps(self.payload, ensure_ascii=False))


# ---------- 완전 쌍: 값·증감·근거 승격 ----------

def test_answer_carries_pair_values_and_change():
    state = qa_agent.answer_question(QUESTION, holding_retriever())
    assert [d.kind for d in state.derived].count("holding_change") == 2
    for value in ("2,925,317", "5.00", "2,263,085", "3.87", "662,232", "-1.13"):
        assert value in state.answer
    # 소비한 원문 행은 덤프로 다시 나가지 않는다 — 값은 위 문장이 이미 담았다.
    assert PREV_ROW not in state.answer
    assert state.validation["status"] != "UNSUPPORTED"
    assert state.fallback_stage == ""


def test_wire_retrieved_context_contains_promoted_rows():
    """§3-2 잠금: 승격된 행(원문 byte 그대로)과 선택 값이 wire 근거에 실린다."""
    state = qa_agent.answer_question(QUESTION, holding_retriever())
    wire = answer_wire.to_answer_wire("qid", QUESTION, state.to_dict())
    quoted = [e.get("quoted_text") for e in json.loads(wire["retrieved_context"])]
    assert PREV_ROW in quoted                       # 행 원문 그대로
    assert "2,925,317" in quoted                    # 값 항목(picked_value)
    slots = {e.get("slot_name") for e in json.loads(wire["retrieved_context"])}
    assert "직전 보고서 보유주식등의 수" in slots


def test_non_consumed_selected_rows_survive_exclusion_in_pipeline():
    """§3-5 통합 잠금: 서빙 경로에서 제외는 파서가 소비한 행만 숨긴다.

    보유목적 줄이 기본 선발 예산(MAX_EVIDENCE·문서당 4줄)에서 표 행에 밀리는 것은
    파서 이전부터의 선발 동작이라 이 판의 범위 밖(§6) — 여기서는 소비 안 된 선발 근거
    (기준일 행)가 답변에 그대로 남는 것을 잠근다. 보유목적 자체는 아래 메커니즘 테스트."""
    state = qa_agent.answer_question(QUESTION, holding_retriever())
    assert BASIS_DATE_LINE in state.answer          # 소비 안 된 근거는 유지
    assert PREV_ROW not in state.answer             # 소비한 행만 숨김
    assert "662,232" in state.answer


def test_exclusion_hides_only_consumed_rows_mechanism():
    """§3-5 메커니즘 단위 잠금: exclude_texts에 없는 행은 절대 숨기지 않는다."""
    consumed_row = "보유주식등의 수 및 보유비율 | 직전 보고서 | 2,925,317 | 5.00"
    matches = [
        qa_agent.EvidenceMatch(slot="answer", chunk_id="c1", doc_id=DOC_ID,
                               evidence_text=consumed_row, section_path=(),
                               confidence=1.0, reason="t"),
        qa_agent.EvidenceMatch(slot="answer", chunk_id="c2", doc_id=DOC_ID,
                               evidence_text=PURPOSE_LINE, section_path=(),
                               confidence=0.9, reason="t"),
    ]
    answer, _ = qa_agent.fallback_answer(
        matches, exclude_texts=frozenset({"".join(consumed_row.split())}))
    assert PURPOSE_LINE in answer
    assert consumed_row not in answer


# ---------- 부분 쌍: 직전 없음 → 부분 답변 ----------

def test_partial_pair_states_missing_slots_without_fabrication():
    state = qa_agent.answer_question(QUESTION, holding_retriever(with_prev=False))
    assert "2,263,085" in state.answer and "3.87" in state.answer
    assert "확인하지 못했다" in state.answer
    assert "직전 보고서 보유주식등의 수" in state.answer
    assert not any(d.kind == "holding_change" for d in state.derived)
    assert "2,925,317" not in state.answer          # 없는 직전 값을 만들어내지 않는다


# ---------- 최종 검수 1·5: 문서 결박 — 다른 보고서 값 혼합·노출 금지 ----------

def test_other_reporter_rows_never_reach_the_answer_body():
    """트랩 문서(국민연금·다른 기준일)가 검색에 섞여도 answer 본문은 대상 문서로 제한."""
    state = qa_agent.answer_question(QUESTION, holding_retriever(with_trap=True))
    assert "662,232" in state.answer                # 대상 문서 계산은 그대로
    assert "국민연금" not in state.answer
    assert "4,329,578" not in state.answer and "3,744,240" not in state.answer


def test_llm_answer_citing_other_holding_doc_is_discarded():
    """삼성전기 회귀(최종 검수 1): LLM이 다른 대량보유 보고서의 값을 답하면 통째로 폐기 —
    파서 값과 한 답변에 합쳐지는 경로 차단. 결정론 답(파서 값)이 최종본이다."""
    q = QUESTION.replace("각각 어떻게 변동되었는가?",
                         "각각 어떻게 변동되었고, 보유목적은 무엇인가?")
    trap_row = "직전보고서 | 2023년 09월 22일 | 국민연금공단 | 1 | 4,329,578 | 7.40 | 4,329,578 | 7.40 | 58,492,759"
    llm = FakeLLM({"answer": "직전 보고서의 보유주식등의 수는 4,329,578주입니다.",
                   "evidence": [{"document_id": NPS_DOC, "quote_or_fact": trap_row}],
                   "uncertainty": ""})
    state = qa_agent.answer_question(q, holding_retriever(with_trap=True), llm=llm)
    assert llm.calls == 1                           # 잔여 항목(보유목적) 때문에 LLM은 호출됨
    assert state.llm.get("degraded_reason") == "holding_doc_unbound"
    assert "4,329,578" not in state.answer          # 다른 보고서 값 미혼입
    assert "2,925,317" in state.answer and "662,232" in state.answer


# ---------- 최종 검수 3: 계산이 있어도 잔여 항목(보유목적)은 LLM으로 보완 ----------

def test_remaining_topic_keeps_llm_and_calculation_together():
    q = QUESTION.replace("각각 어떻게 변동되었는가?",
                         "각각 어떻게 변동되었고, 보유목적은 무엇인가?")
    llm = FakeLLM({"answer": "보유목적은 단순투자다.",
                   "evidence": [{"document_id": DOC_ID, "quote_or_fact": PURPOSE_LINE}],
                   "uncertainty": ""})
    state = qa_agent.answer_question(q, holding_retriever(), llm=llm)
    assert llm.calls == 1 and state.llm.get("used")
    assert not state.llm.get("degraded")
    assert "보유목적은 단순투자다." in state.answer
    assert "662,232주 감소" in state.answer         # 채택 후에도 계산 문장 유지
    assert "2,925,317" in state.answer              # 확정값 보존


def test_value_only_holding_question_still_skips_llm():
    llm = FakeLLM({"answer": "무관", "evidence": [], "uncertainty": ""})
    state = qa_agent.answer_question(QUESTION, holding_retriever(), llm=llm)
    assert llm.calls == 0
    assert state.llm.get("skipped") == "deterministic_calculation"


# ---------- 최종 검수 6: 신청/승인 이분 질문 결정론 판정 ----------

APPROVAL_FIELD_ROW = ("2. 주요내용 | 2. 주요내용 | 1) 품목명: 테르가제주(베라히알루로니다제알파)"
                      "3) 품목허가 신청(허가)일 및 허가기관:- 신청일: 2023년 2월 7일"
                      "- 허가일: 2024년 7월 5일- 품목허가기관: 식품의약품안전처 (MFDS)")
OTHER_PRODUCT_ROW = ("2. 주요내용 | 2. 주요내용 | 1) 품목명 :EYZANFY주 3) 품목허가 신청일 및 "
                     "허가기관 :- 신청일 : 2024년 09월 12일- 품목허가기관 : 식품의약품안전처(MFDS)")
BINARY_Q = ("알테오젠의 테르가제주(ALT-BB4) 관련 2024년 7월 5일 공시는 품목허가 신청 사실을 "
            "알리는 것인가, 품목허가 승인 사실을 알리는 것인가?")


def _c(text, chunk_id="c1"):
    from dart_detective.corpus_retriever import RetrievedChunk
    return RetrievedChunk(chunk_id=chunk_id, doc_id="major_1", score=1.0,
                          section_path=(), row_labels=(), evidence_text=text,
                          metadata={}, node_index=3)


def test_binary_question_answers_approval_directly():
    got = qa_agent.approval_or_application(
        BINARY_Q, [], [_c(APPROVAL_FIELD_ROW), _c(OTHER_PRODUCT_ROW, "c2")])
    assert got is not None
    head, line = got
    assert "승인(허가) 사실을 알리는 공시다" in head
    assert "신청일은 2023년 2월 7일" in head and "허가일은 2024년 7월 5일" in head
    assert line == APPROVAL_FIELD_ROW               # 다른 품목 필드는 결박에서 제외


def test_binary_question_application_only_field():
    q = "알테오젠의 2024년 09월 12일 공시는 품목허가 신청 사실인가, 승인 사실인가?"
    got = qa_agent.approval_or_application(q, [], [_c(OTHER_PRODUCT_ROW)])
    assert got is not None and "신청 사실을 알리는 공시다" in got[0]


def test_binary_question_fails_closed_on_ambiguity():
    q = "알테오젠 공시는 품목허가 신청 사실인가, 승인 사실인가?"   # 날짜 앵커 없음
    got = qa_agent.approval_or_application(
        q, [], [_c(APPROVAL_FIELD_ROW), _c(OTHER_PRODUCT_ROW, "c2")])
    assert got is None                               # 서로 다른 필드 2개 — 판정 불가


# ---------- 최종 검수 4: retrieved_context 중복 제거·사용 근거 우선 ----------

def test_retrieved_context_dedupes_same_row_across_slots():
    m = dict(chunk_id="c1", doc_id=DOC_ID, evidence_text=PREV_ROW, section_path=[],
             confidence=1.0, reason="t", node_index=28, rcept_no="20240403000410")
    state = {"evidence_matches": [
        {**m, "slot": "직전 보고서 보유주식등의 수", "picked_value": "2,925,317"},
        {**m, "slot": "직전 보고서 보유비율", "picked_value": "5.00"},
        {**m, "slot": "answer", "picked_value": None},
    ]}
    ctx = answer_wire.retrieved_context_of(state)
    rows = [e for e in ctx if e["quoted_text"] == PREV_ROW]
    assert len(rows) == 1                            # 같은 행은 한 번만
    assert rows[0]["slot_name"] != "answer"          # 사용 근거(slot 매치)가 우선
    assert {e["quoted_text"] for e in ctx} >= {"2,925,317", "5.00"}
