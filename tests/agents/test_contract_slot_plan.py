"""계약·서식 항목 슬롯 계획 + 결정론 조립 (코덱스 재배포 검수 P0 반영).

배경 실측: "계약상대방, 계약금액, 계약기간과 최근 매출액 대비 비율" 문형 14문항이
infer_metrics의 '매출액'에 걸려 전부 '매출액_연도' 슬롯 하나로 변질 — gold 문서가
검색돼도 근거 선발에 오르지 못했다(retrieved_context 1/14). LG에너지솔루션
exchange_20250730800046 실물 서식 행으로 잠근다.
"""
from __future__ import annotations

from dart_corpus.retrieval import DocumentIndex, IndexedDocument
from dart_corpus.retrieval.conditions import QueryConditions
from dart_corpus.retrieval.corp_dictionary import CorpDictionary
from dart_detective.agents import qa_agent
from dart_detective.agents.qa_agent import EvidenceMatch
from dart_detective.corpus_retriever import CorpusRetriever

LGES_QUESTION = ("LG에너지솔루션의 2025-07-30 LFP 배터리 공급계약 공시에서 "
                 "계약상대방, 계약금액, 계약기간과 최근 매출액 대비 비율을 알려줘.")

# exchange_20250730800046 실물 행(계약상대는 실제로 '-')
LGES_FORM = ("1. 판매ㆍ공급계약 구분 | 1. 판매ㆍ공급계약 구분 | 기타 판매ㆍ공급계약\n"
             "2. 계약내역 | 계약금액(원) | 5,944,227,336,000\n"
             "2. 계약내역 | 최근매출액(원) | 25,619,585,140,102\n"
             "2. 계약내역 | 매출액대비(%) | 23.2\n"
             "3. 계약상대 | 3. 계약상대 | -\n"
             "5. 계약기간 | 시작일 | 2027-08-01\n"
             "5. 계약기간 | 종료일 | 2030-07-31\n"
             "8. 공시유보 관련내용 | 유보사유 | 경영상 비밀유지\n"
             "8. 공시유보 관련내용 | 유보기한 | 2030-07-31")


def conditions(years=(), corps=()) -> QueryConditions:
    return QueryConditions(corps=frozenset(corps), years=frozenset(years))


# ---------- 슬롯 계획: 항목이 지표 추론보다 우선 ----------

def test_contract_question_plans_item_slots_not_metric_year():
    slots = qa_agent.plan_slots(LGES_QUESTION, conditions(years=[2025]))
    assert "매출액_2025" not in slots                      # 종전 오동작(유일 슬롯)
    assert {"계약금액", "계약상대", "매출액대비", "시작일", "종료일"} <= set(slots)
    assert slots[-1] == qa_agent.ANSWER_SLOT


def test_contract_period_expands_to_start_end_only_when_not_named():
    assert {"시작일", "종료일"} <= set(qa_agent.planned_form_items("계약기간과 계약금액은?"))
    # 종료일을 콕 집은 질문에 시작일을 끼워 넣지 않는다(기존 테스트 동작 유지)
    assert qa_agent.planned_form_items("계약기간 종료일은 언제인가?") == ("종료일",)


def test_metric_like_item_alone_does_not_switch_to_item_path():
    """'자기자본'은 재무제표 지표와 이름이 겹친다 — 단독으로는 항목 경로로 넘기지 않는다."""
    assert qa_agent.planned_form_items("2023년과 2025년 사이 자기자본은 얼마나 변동했는가?") == ()
    assert "자기자본대비" in qa_agent.planned_form_items("투자금액과 자기자본 대비 비율은?")


def test_major_report_fields_become_slots():
    """주요사항보고서 반복 서식 필드(실물 라벨 대조) — 에이전트 층 사전으로만 확장한다."""
    q = ("신한지주가 2024년 4월 26일 결의한 자기주식 처분 결정의 목적과 "
         "처분예정주식수, 처분방법은 각각 무엇인가?")
    assert {"처분목적", "처분예정주식", "처분방법"} <= set(qa_agent.planned_form_items(q))


def test_agent_items_do_not_touch_retrieval_dictionary():
    """검색 코어 사전(DISCLOSURE_ITEMS)은 4-arm이 공유한다 — 에이전트 확장이 새면 안 된다."""
    assert "처분목적" not in qa_agent.DISCLOSURE_ITEMS
    assert "계약기간" not in qa_agent.DISCLOSURE_ITEMS


# ---------- 결정론 조립 ----------

def _m(slot, line, doc="exchange_1", value=None):
    return EvidenceMatch(slot=slot, chunk_id=f"{doc}::c0", doc_id=doc,
                         evidence_text=line, section_path=(), confidence=0.9,
                         reason="test", picked_value=value)


def test_assemble_when_all_item_slots_have_values():
    items = ("계약금액", "매출액대비", "시작일", "종료일")
    matches = [
        _m("계약금액", "2. 계약내역 | 계약금액(원) | 5,944,227,336,000", value="5,944,227,336,000"),
        _m("매출액대비", "2. 계약내역 | 매출액대비(%) | 23.2", value="23.2"),
        _m("시작일", "5. 계약기간 | 시작일 | 2027-08-01", value="2027-08-01"),
        _m("종료일", "5. 계약기간 | 종료일 | 2030-07-31", value="2030-07-31"),
    ]
    got = qa_agent.assemble_item_answer(items, matches)
    assert got is not None
    assert "계약금액: 5,944,227,336,000" in got and "종료일: 2030-07-31" in got


def test_assemble_reads_text_cell_when_no_numeric_value():
    got = qa_agent.assemble_item_answer(
        ("계약상대",), [_m("계약상대", "3. 계약상대 | 3. 계약상대 | 현대자동차(주)")])
    assert got is not None and "계약상대: 현대자동차(주)" in got


def test_assemble_fails_closed_on_dash_or_missing_slot():
    dash = [_m("계약상대", "3. 계약상대 | 3. 계약상대 | -"),
            _m("계약금액", "2. 계약내역 | 계약금액(원) | 100", value="100")]
    assert qa_agent.assemble_item_answer(("계약상대", "계약금액"), dash) is None
    assert qa_agent.assemble_item_answer(("계약금액", "시작일"), dash[1:]) is None


def test_assemble_fails_closed_on_mixed_documents():
    mixed = [_m("계약금액", "계약금액(원) | 100", doc="exchange_1", value="100"),
             _m("시작일", "시작일 | 2027-08-01", doc="exchange_2", value="2027-08-01")]
    assert qa_agent.assemble_item_answer(("계약금액", "시작일"), mixed) is None


# ---------- 자유 자리 앵커: 질문 날짜 공시의 행을 전역 점수 경쟁 전에 확보 ----------

def _chunk(cid, doc, text, rcept, score=1.0):
    from dart_detective.corpus_retriever import RetrievedChunk
    return RetrievedChunk(chunk_id=cid, doc_id=doc, score=score, section_path=(),
                          row_labels=(), evidence_text=text,
                          metadata={"rcept_no": rcept, "corp_name": "X"})


def test_free_slot_guarantees_line_from_question_date_document():
    """검색 20위 안에 있어도 전역 줄 점수에서 밀려 선발 탈락하던 접수일 일치 문서(코덱스 P1:
    raw에 있었지만 탈락 45 slot) — 날짜 앵커가 최소 1줄을 보장한다. 접수일이 이벤트일
    다음 날인 실물(±1일)도 같은 앵커다. 검색 코어는 무변경(선발 단계 전용)."""
    noise = [_chunk(f"n{i}", f"periodic_{i}", "매출액 실적 계약 공급 관련 요약 | 999", "20240101000001")
             for i in range(6)]
    target = _chunk("g1", "exchange_gold", "계약 체결 내용 | 세부", "20250318000009", score=0.1)
    matches = qa_agent.match_evidence(
        (qa_agent.ANSWER_SLOT,), noise + [target],
        question="삼성중공업의 2025-03-17 에탄운반선 공급계약 공시에서 내용을 알려줘")
    assert any(m.doc_id == "exchange_gold" for m in matches)
    anchored = next(m for m in matches if m.doc_id == "exchange_gold")
    assert "앵커" in anchored.reason


def test_free_slot_without_question_date_behaves_as_before():
    noise = [_chunk(f"n{i}", f"periodic_{i}", "매출액 | 999", "20240101000001") for i in range(3)]
    matches = qa_agent.match_evidence((qa_agent.ANSWER_SLOT,), noise,
                                      question="회사의 매출액 추이는?")
    assert all("앵커" not in m.reason for m in matches)


# ---------- judge27 오귀속 회귀 잠금: 날짜 결박·요구 잔여 시 조립 금지 ----------

def _form_chunk(doc, text, rcept_dt):
    from dart_detective.corpus_retriever import RetrievedChunk
    return RetrievedChunk(chunk_id=f"{doc}::c0", doc_id=doc, score=1.0, section_path=(),
                          row_labels=(), evidence_text=text,
                          metadata={"rcept_dt": rcept_dt, "corp_name": "현대자동차"})


def test_korean_dates_are_parsed_at_agent_layer():
    assert (2023, 10, 26) in qa_agent.question_dates_any("현대자동차가 2023년 10월 26일 결의한")
    assert (2025, 7, 30) in qa_agent.question_dates_any("2025-07-30 공시")


def test_item_slots_bind_to_question_date_document():
    """judge27 실측(현대차·SKT·아모레·메리츠 full→zero): 같은 회사의 **다른 회차** 처분
    공시 값이 항목 자리에 들어와 결정론 조립으로 확정됐다 — 질문 날짜(±1일) 접수 공시로 결박."""
    wrong = _form_chunk("major_wrong", "2. 처분예정금액(원) | 959,500,000", "20240702")
    right = _form_chunk("major_right", "2. 처분예정금액(원) | 175,380,660,000", "20231026")
    q = "현대자동차가 2023년 10월 26일 결의한 자기주식 처분 결정의 처분예정금액은?"
    matches = qa_agent.match_evidence(("처분예정금액", qa_agent.ANSWER_SLOT), [wrong, right],
                                      question=q, bind_days=qa_agent._question_day_window(q))
    filled = [m for m in matches if m.slot == "처분예정금액"]
    assert filled and filled[0].doc_id == "major_right"
    assert filled[0].picked_value == "175,380,660,000"


def test_residual_ask_words_disable_llm_skip():
    """항목이 못 덮는 요구가 남으면 조립으로 LLM을 끄지 않는다(아모레 '인원수'·메리츠
    '계약목적'·효성 '해지 후 상태' 손실 실측)."""
    assert qa_agent._residual_asks(
        "자기주식 처분 결정의 목적과 처분예정주식수, 지급 대상 인원수는?",
        ("처분목적", "처분예정주식"))
    assert qa_agent._residual_asks(
        "자기주식취득 신탁계약의 계약금액과 계약목적은 무엇인가?", ("계약금액",))
    assert qa_agent._residual_asks(
        "어떤 원계약을 해지했으며, 해지 사유와 해지 후 상태는 무엇인가?", ("해지 주요사유",))
    # 항목이 요구를 전부 덮으면(단일판매 문형) 잔여 없음 — 조립·LLM 생략 유지
    assert not qa_agent._residual_asks(
        "계약상대방, 계약금액, 계약기간과 최근 매출액 대비 비율을 알려줘.",
        ("계약금액", "매출액대비", "계약상대", "시작일", "종료일"))
    assert not qa_agent._residual_asks(
        "자기주식 처분 결정의 목적과 처분예정주식수, 처분예정금액은 각각 무엇인가?",
        ("처분목적", "처분예정주식", "처분예정금액"))


# ---------- 날짜+항목 원문 보충: 검색 후보에 없는 대상 문서를 node에서 읽는다 ----------

def test_date_item_supplement_pulls_stage1_doc_missing_from_chunks():
    """gold 문서가 Stage 1 1위인데 청크 후보에 없던 실물(단일판매 14문항) — 접수일이
    이벤트일 다음 날(±1일)이어도 보충한다. 검색 코어(retrieve)는 호출하지 않는다."""
    from types import SimpleNamespace
    q = "삼성중공업의 2025-03-17 에탄운반선 공급계약 공시에서 계약금액을 알려줘."
    hit = SimpleNamespace(doc_id="exchange_gold", corp_name="삼성중공업")
    retriever = SimpleNamespace(
        docs_by_id={"exchange_gold": {"nodes": [
            {"node_index": 0, "section_hierarchy": [],
             "text": "2. 계약내역 | 계약금액(원) | 466,100,000,000"}]}},
        document_index=SimpleNamespace(search=lambda question, k, conditions: [hit]),
        _rcept_dt=lambda doc_id: "20250318")           # 접수일 = 이벤트일 + 1일
    got = qa_agent.date_item_supplement(q, conditions(), retriever, chunks=[])
    assert len(got) == 1 and got[0].doc_id == "exchange_gold"
    assert "466,100,000,000" in got[0].evidence_text

    # 이미 후보에 있으면 보충하지 않는다(중복 금지)
    have = [got[0]]
    assert qa_agent.date_item_supplement(q, conditions(), retriever, have) == []
    # 날짜가 어긋나면(±1일 밖) 보충하지 않는다
    retriever._rcept_dt = lambda doc_id: "20250320"
    assert qa_agent.date_item_supplement(q, conditions(), retriever, []) == []
    # 서식 항목이 없는 질문은 보충하지 않는다
    assert qa_agent.date_item_supplement(
        "삼성중공업의 2025-03-17 공시 내용을 요약해줘", conditions(), retriever, []) == []


# ---------- 재검수 BLOCKER 1: 같은 날 복수 공시 값 혼합은 SUPPORTED로 못 나간다 ----------

import json as _json

from dart_detective.llm import LLMResult


DOC_A_FORM = ("2. 계약내역 | 계약금액(원) | 100\n"
              "3. 계약상대 | 3. 계약상대 | 에이회사")
DOC_B_FORM = ("2. 계약내역 | 계약금액(원) | 200\n"
              "3. 계약상대 | 3. 계약상대 | 비회사\n"
              "4. 판매ㆍ공급지역 | 4. 판매ㆍ공급지역 | 나이지리아 라고스")
MIX_QUESTION = "한화오션의 2024-04-17 공급계약 공시에서 계약금액과 계약상대방을 알려줘."


def two_doc_retriever() -> CorpusRetriever:
    corp_dict = CorpDictionary.from_rows(
        [{"corp_name": "한화오션", "listed_name": "한화오션", "stock_code": "042660"}])
    def doc(doc_id, text):
        return IndexedDocument(
            doc_id=doc_id, corp_name="한화오션", corp_code="한화오션", filer_name="한화오션",
            doc_group="exchange", doc_subtype="단일판매ㆍ공급계약체결",
            report_nm="단일판매ㆍ공급계약체결", rcept_dt="20240417",
            base_year=2024, base_month=4, is_correction=False, text=text)
    index = DocumentIndex([doc("exchange_a", DOC_A_FORM), doc("exchange_b", DOC_B_FORM)], corp_dict)
    docs_by_id = {d: {"doc_id": d, "doc_group": "exchange",
                      "nodes": [{"node_index": 0, "section_hierarchy": [], "text": t}]}
                  for d, t in (("exchange_a", DOC_A_FORM), ("exchange_b", DOC_B_FORM))}
    return CorpusRetriever(document_index=index, corp_dict=corp_dict, docs_by_id=docs_by_id)


class MixLLM:
    """문서 A의 값(100)과 문서 B의 상대방(비회사)을 한 답으로 섞는 나쁜 모델."""

    provider = "fake"

    def complete_json(self, system, user, schema):
        payload = {"answer": "계약금액은 100원이고 계약상대는 비회사입니다.",
                   "evidence": [{"document_id": "exchange_b",
                                 "quote_or_fact": "3. 계약상대 | 3. 계약상대 | 비회사"}],
                   "uncertainty": ""}
        return LLMResult(data=payload, provider=self.provider, model="fake-1",
                         latency_ms=1, raw_text=_json.dumps(payload, ensure_ascii=False))


def test_mixed_document_answer_is_rejected_not_supported():
    """재검수 3차 BLOCKER 1: 미해소 복수 후보에서는 LLM을 아예 부르지 않는다(숫자 게이트는
    텍스트 필드 혼합 — "A 금액 인용 + B 상대방 주장" — 을 못 잡는다). 문서별 분리 답으로
    종료하고, 섞인 문장이 최종본이 되면 안 된다."""
    state = qa_agent.answer_question(MIX_QUESTION, two_doc_retriever(), llm=MixLLM())
    assert (state.llm or {}).get("used") is False
    assert (state.llm or {}).get("skipped") == "items_ambiguous_docs"
    assert "100원이고 계약상대는 비회사" not in state.answer
    assert "특정할 수 없다" in state.answer
    assert "후보 공시 ①" in state.answer and "후보 공시 ②" in state.answer


class TextMixLLM:
    """검수 3차 재현: 인용은 문서 A의 금액 행만, 주장은 문서 B의 상대방(텍스트 혼합)."""

    provider = "fake"

    def __init__(self):
        self.called = 0

    def complete_json(self, system, user, schema):
        self.called += 1
        payload = {"answer": "계약금액은 100원이고 계약상대는 비회사입니다.",
                   "evidence": [{"document_id": "exchange_a",
                                 "quote_or_fact": "2. 계약내역 | 계약금액(원) | 100"}],
                   "uncertainty": ""}
        return LLMResult(data=payload, provider=self.provider, model="fake-1",
                         latency_ms=1, raw_text=_json.dumps(payload, ensure_ascii=False))


def test_text_field_mixing_path_is_closed_llm_never_called():
    """숫자는 인용 문서 것이고 텍스트만 라이벌 것인 혼합 — 미해소면 LLM 호출 자체가 없어
    이 경로가 성립하지 않는다."""
    llm = TextMixLLM()
    state = qa_agent.answer_question(MIX_QUESTION, two_doc_retriever(), llm=llm)
    assert llm.called == 0
    assert "비회사입니다" not in state.answer


def test_closed_multi_item_question_skips_llm_even_when_narrative_routed():
    """재검수 3차 BLOCKER 2: 값 슬롯 3개 이상이면 라우터가 NARRATIVE로 보내지만, 서식
    항목이 전부 결정론으로 채워진 폐쇄형 질문은 전략과 무관하게 LLM을 생략해야 한다."""
    corp_dict = CorpDictionary.from_rows(
        [{"corp_name": "한화오션", "listed_name": "한화오션", "stock_code": "042660"}])
    form = ("2. 계약내역 | 계약금액(원) | 100\n"
            "3. 계약상대 | 3. 계약상대 | 에이회사\n"
            "5. 계약기간 | 종료일 | 2030-07-31")
    doc = IndexedDocument(
        doc_id="exchange_only", corp_name="한화오션", corp_code="한화오션",
        filer_name="한화오션", doc_group="exchange", doc_subtype="단일판매ㆍ공급계약체결",
        report_nm="단일판매ㆍ공급계약체결", rcept_dt="20240417",
        base_year=2024, base_month=4, is_correction=False, text=form)
    r = CorpusRetriever(document_index=DocumentIndex([doc], corp_dict), corp_dict=corp_dict,
                        docs_by_id={"exchange_only": {
                            "doc_id": "exchange_only", "doc_group": "exchange",
                            "nodes": [{"node_index": 0, "section_hierarchy": [],
                                       "text": form}]}})
    q = "한화오션의 2024-04-17 공급계약 공시에서 계약금액, 계약상대방, 계약기간 종료일을 알려줘."
    state = qa_agent.answer_question(q, r, llm=BoomLLM())
    assert state.route.strategy == "NARRATIVE"               # 라우터 기본 분류 그대로
    assert (state.llm or {}).get("skipped") == "items_all_slots_filled"
    assert "계약금액: 100" in state.answer and "에이회사" in state.answer


def test_resolved_item_doc_bounds_context_and_sources():
    """후보가 하나로 해소되면 근거·발췌가 그 문서로 제한된다(재검수 BLOCKER 1 조건 3)."""
    r = two_doc_retriever()
    # 문서 B에만 있는 고유 토큰(바이그램 2개 이상 — '나이지리아')을 질문에 넣어 해소시킨다.
    q = "한화오션의 2024-04-17 나이지리아 공급계약 공시에서 계약금액을 알려줘."
    state = qa_agent.answer_question(q, r, llm=None)
    docs = {m.doc_id for m in state.evidence_matches}
    assert docs <= {"exchange_b"}
    assert all(cid.startswith("exchange_b") for cid in state.llm_context_chunk_ids)


# ---------- 재검수 HIGH 2: 서술 요구가 남으면 조립이 LLM을 끄지 않는다 ----------

class EchoLLM:
    provider = "fake"

    def __init__(self):
        self.called = 0

    def complete_json(self, system, user, schema):
        self.called += 1
        payload = {"answer": "이 계약은 매출 확대에 긍정적 영향을 줄 것으로 공시에 서술되어 있다.",
                   "evidence": [{"document_id": "exchange_a",
                                 "quote_or_fact": "2. 계약내역 | 계약금액(원) | 100"}],
                   "uncertainty": ""}
        return LLMResult(data=payload, provider=self.provider, model="fake-1",
                         latency_ms=1, raw_text=_json.dumps(payload, ensure_ascii=False))


def test_narrative_residual_keeps_llm_after_assembly():
    """"계약금액과 이 계약이 실적에 미칠 영향은?" — 값은 조립돼도 '영향' 요구가 남아
    LLM 서술 경로가 유지돼야 한다(재검수 HIGH 2: 조용한 요구 삭제 금지)."""
    corp_dict = CorpDictionary.from_rows(
        [{"corp_name": "한화오션", "listed_name": "한화오션", "stock_code": "042660"}])
    doc = IndexedDocument(
        doc_id="exchange_a", corp_name="한화오션", corp_code="한화오션", filer_name="한화오션",
        doc_group="exchange", doc_subtype="단일판매ㆍ공급계약체결",
        report_nm="단일판매ㆍ공급계약체결", rcept_dt="20240417",
        base_year=2024, base_month=4, is_correction=False, text=DOC_A_FORM)
    r = CorpusRetriever(document_index=DocumentIndex([doc], corp_dict), corp_dict=corp_dict,
                        docs_by_id={"exchange_a": {"doc_id": "exchange_a", "doc_group": "exchange",
                                                   "nodes": [{"node_index": 0,
                                                              "section_hierarchy": [],
                                                              "text": DOC_A_FORM}]}})
    llm = EchoLLM()
    state = qa_agent.answer_question(
        "한화오션의 2024-04-17 공급계약 공시에서 계약금액과 이 계약이 실적에 미칠 영향은?", r, llm=llm)
    assert llm.called == 1                                   # 조립이 LLM을 끄지 않았다
    assert (state.llm or {}).get("skipped") is None
    assert "계약금액: 100" in state.answer                    # 결정론 값 블록 유지
    assert "영향" in state.answer                            # 서술도 답에 남는다


# ---------- 통합: LGES 실물 서식 → 유보 + 확정값 보존, LLM 미호출 ----------

UNIVERSE_ROWS = [{"corp_name": "LG에너지솔루션", "listed_name": "LG에너지솔루션",
                  "stock_code": "373220"}]


def lges_retriever() -> CorpusRetriever:
    corp_dict = CorpDictionary.from_rows(UNIVERSE_ROWS)
    doc = IndexedDocument(
        doc_id="exchange_20250730800046", corp_name="LG에너지솔루션",
        corp_code="LG에너지솔루션", filer_name="LG에너지솔루션",
        doc_group="exchange", doc_subtype="단일판매ㆍ공급계약체결",
        report_nm="단일판매ㆍ공급계약체결", rcept_dt="20250730",
        base_year=2025, base_month=7, is_correction=False, text=LGES_FORM)
    index = DocumentIndex([doc], corp_dict)
    docs_by_id = {"exchange_20250730800046": {
        "doc_id": "exchange_20250730800046", "doc_group": "exchange",
        "nodes": [{"node_index": 0, "kind": "table",
                   "section_hierarchy": [], "text": LGES_FORM}]}}
    return CorpusRetriever(document_index=index, corp_dict=corp_dict,
                           docs_by_id=docs_by_id)


class BoomLLM:
    provider = "fake"

    def complete_json(self, system, user, schema):  # pragma: no cover - 호출되면 실패
        raise AssertionError("유보 확정 질문에서 LLM이 호출되면 안 된다")


def test_lges_contract_question_end_to_end_is_withheld_with_values():
    state = qa_agent.answer_question(LGES_QUESTION, lges_retriever(), llm=BoomLLM())
    assert state.answerability == "WITHHELD"               # 계약상대 '-' + 유보사유 존재
    assert (state.llm or {}).get("used") is False
    assert "5,944,227,336,000" in state.answer             # 유보되지 않은 확정 값 보존
    assert "23.2" in state.answer
    assert "매출액_2025" not in state.slots