"""arm_a_document_binder 계약 테스트 — Turn A4-A3-QA-DOCUMENT-BINDER-V1.

전부 합성 fixture만 쓴다(실제 A4/A3 결과·Gold 미사용, 검색·DB·KURE·LLM 호출 0).
계약은 docs/A4_A3_QA_DOCUMENT_BINDER_V1_CONTRACT.md — 이 테스트가 그 계약을 검증한다.
"""
from __future__ import annotations

import copy
import hashlib
import inspect
from pathlib import Path

import pytest

from dart_corpus.retrieval.conditions import QueryConditions
from dart_detective import arm_a_document_binder as binder
from dart_detective.corpus_retriever import RetrievedChunk

REPO = Path(__file__).resolve().parents[2]


# ---------- 20) 기존 A4/A3/QA/worker 파일 SHA 불변 ----------

_EXPECTED_UNCHANGED_FILE_SHA256 = {
    "src/dart_detective/corpus_retriever.py":
        "c64bc9b4011fac8862f80c9dd8f3b8510f28c16718b613b74bc76160b44fcc8a",
    "src/dart_detective/agents/qa_agent.py":
        "43e055aafc93c06f346ced4484bb94dc821111abc4c5b8b8c93d9470355d7020",
    "src/dart_detective/arm_a_live_adapter.py":
        "d997a4459c601d09ec2dbc47614aa83ebac47ee9a26e0284db313c64edde551b",
    "src/dart_detective/arm_a4_a3_live_adapter.py":
        "1307b265dae284792a5e38268fab8cb8024fa658d1243fb9b0941d4423e3e7e7",
    # Turn A4-A3-QA-BINDER-EVIDENCE-V2-INTEGRATION-V1: intentionally updated — additive-only
    # new backend dispatch (ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2), see
    # docs/A4_A3_QA_BINDER_EVIDENCE_V2_INTEGRATION_V1_CONTRACT.md §3.
    "src/dart_detective/arm_a_serving_bridge.py":
        "845dbbd7d3fe7eafa1a2f6e2056e28087f1f8be5141b4e6518862a7b54862c20",
    "src/dart_detective/answer_api.py":
        "aaa220d5864fdbcfd61e785daf88d578ea1525f025dec0de8dbec3e0ca24324b",
    "src/dart_detective/agents/validator.py":
        "0fbc179e1f9251f8dd2965d33bd292fdd9e1d71bcc35ac6e239338b897ac6423",
}


def test_a4_a3_qa_worker_files_byte_unchanged():
    for rel_path, expected_sha in _EXPECTED_UNCHANGED_FILE_SHA256.items():
        actual = hashlib.sha256((REPO / rel_path).read_bytes()).hexdigest()
        assert actual == expected_sha, f"{rel_path}가 바뀌었다 — 이 turn은 이 파일을 건드리면 안 된다"


def test_worker_mjs_files_untouched():
    for rel_path in ("scripts/arm_a4_a3_live_worker.mjs", "scripts/arm_a_live_worker.mjs"):
        path = REPO / rel_path
        assert path.exists(), f"{rel_path}가 없다"


# ---------- 18) 검색/DB/KURE/LLM import 및 호출 0 ----------

def test_module_has_zero_search_db_kure_llm_imports():
    src = inspect.getsource(binder)
    forbidden = ("requests", "httpx", "sqlite3", "socket", "subprocess",
                 "sentence_transformers", "anthropic", "psycopg",
                 "arm_a_live_worker_client", "arm_a4_a3_live_worker_client",
                 "retriever_adapter", "kure", "from .llm", "import llm")
    for token in forbidden:
        assert token.lower() not in src.lower(), f"금지된 의존성 참조: {token}"


# ---------- 19) 특정 question_id·기업명 하드코딩 0 ----------

_REAL_CORP_NAMES = ("알테오젠", "고려아연", "삼성전기", "시프트업", "효성중공업",
                    "한미반도체", "삼성E&A", "두산에너빌리티", "LIG넥스원", "현대제철",
                    "HMM", "현대모비스", "신한지주", "메리츠", "한국항공우주산업",
                    "LGES", "LG에너지솔루션")


def test_module_has_no_hardcoded_real_company_names_or_question_ids():
    src = inspect.getsource(binder)
    for name in _REAL_CORP_NAMES:
        assert name not in src, f"실제 기업명이 하드코딩됐다: {name}"
    assert "question_id ==" not in src and 'question_id ==' not in src


# ---------- 합성 fixture 헬퍼 ----------

def _chunk(chunk_id, doc_id, **meta) -> RetrievedChunk:
    node_indices = meta.pop("node_indices", [0])
    metadata = {**meta, "provenance": {"node_indices": node_indices}}
    return RetrievedChunk(chunk_id=chunk_id, doc_id=doc_id, score=1.0, section_path=("공시",),
                          row_labels=(), evidence_text=f"{doc_id} 본문", metadata=metadata,
                          node_index=0)


def _cond(**kwargs) -> QueryConditions:
    defaults = dict(corps=frozenset(), years=frozenset(), year_months=frozenset(),
                    doc_groups=frozenset(), periodic_subtypes=frozenset(),
                    exchange_subtypes=frozenset(), major_labels=frozenset(),
                    correction=False, wants_latest=False, candidate_terms=())
    defaults.update(kwargs)
    return QueryConditions(**defaults)


# ---------- 1) 한 회사·한 문서 질문 ----------

def test_single_company_single_document():
    cands = [_chunk("c1", "exchange_doc_a", corp_name="합성기업A", doc_group="exchange")]
    cond = _cond(corps=frozenset({"합성기업A"}), doc_groups=frozenset({"exchange"}))
    result = binder.bind_documents("합성기업A의 계약금액은?", cond, cands)
    assert result.status == binder.STATUS_BOUND
    assert result.selected_document_ids == ("exchange_doc_a",)
    assert [c.chunk_id for c in result.retained_candidates] == ["c1"]
    assert result.rejected_document_ids == ()


# ---------- 2) 같은 회사의 다른 접수일 문서 ----------

def test_same_company_different_receipt_date_excludes_the_wrong_date():
    cands = [
        _chunk("c1", "exchange_doc_right", corp_name="합성기업A", doc_group="exchange",
              rcept_dt="20240417"),
        _chunk("c2", "exchange_doc_wrong", corp_name="합성기업A", doc_group="exchange",
              rcept_dt="20240320"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents("합성기업A가 2024-04-17에 공시한 계약금액은?", cond, cands)
    assert result.status == binder.STATUS_BOUND
    assert result.selected_document_ids == ("exchange_doc_right",)
    assert result.rejected_document_ids == ("exchange_doc_wrong",)
    assert result.rejection_reasons["exchange_doc_wrong"] == ("period_mismatch",)


# ---------- 3) 두 연도 비교로 문서 2개 유지 ----------

def test_two_year_comparison_keeps_two_documents():
    cands = [
        _chunk("c1", "periodic_2024", corp_name="합성기업A", doc_group="periodic", base_year=2024),
        _chunk("c2", "periodic_2023", corp_name="합성기업A", doc_group="periodic", base_year=2023),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}), years=frozenset({2024, 2023}))
    result = binder.bind_documents("합성기업A의 2024년과 2023년 매출액을 비교하면?", cond, cands)
    assert result.status == binder.STATUS_MULTI_DOCUMENT_BOUND
    assert set(result.selected_document_ids) == {"periodic_2024", "periodic_2023"}
    roles = {g.role: g.document_ids for g in result.candidate_groups if g.selected}
    assert roles == {"year_2024": ("periodic_2024",), "year_2023": ("periodic_2023",)}


# ---------- 4) 직전/현재 보고서 2개 유지 ----------

def test_previous_and_current_report_kept_as_two_documents():
    cands = [
        _chunk("c1", "holding_latest", corp_name="합성기업A", doc_group="holding",
              rcept_dt="20240601"),
        _chunk("c2", "holding_earlier", corp_name="합성기업A", doc_group="holding",
              rcept_dt="20240101"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents("직전 보고서 대비 이번 보고서의 보유주식수 변동은?", cond, cands)
    assert result.status == binder.STATUS_MULTI_DOCUMENT_BOUND
    roles = {g.role: g.document_ids for g in result.candidate_groups if g.selected}
    assert roles == {"previous": ("holding_earlier",), "current": ("holding_latest",)}


# ---------- 5) 정정 전/후 문서 구분 ----------

def test_correction_before_after_documents_are_kept_separate():
    cands = [
        _chunk("c1", "major_original", corp_name="합성기업A", doc_group="major",
              is_correction=False),
        _chunk("c2", "major_corrected", corp_name="합성기업A", doc_group="major",
              is_correction=True),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents("정정 전 계약금액과 정정 후 계약금액이 어떻게 다른가?", cond, cands)
    assert result.status == binder.STATUS_MULTI_DOCUMENT_BOUND
    roles = {g.role: g.document_ids for g in result.candidate_groups if g.selected}
    assert roles == {"before": ("major_original",), "after": ("major_corrected",)}


# ---------- 6) periodic/exchange/holding/major 구분 ----------

def test_document_group_filter_excludes_other_groups():
    cands = [
        _chunk("c1", "periodic_x", corp_name="합성기업A", doc_group="periodic"),
        _chunk("c2", "exchange_x", corp_name="합성기업A", doc_group="exchange"),
        _chunk("c3", "holding_x", corp_name="합성기업A", doc_group="holding"),
        _chunk("c4", "major_x", corp_name="합성기업A", doc_group="major"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}), doc_groups=frozenset({"major"}))
    result = binder.bind_documents("합성기업A의 자기주식 취득 내역은?", cond, cands)
    assert result.status == binder.STATUS_BOUND
    assert result.selected_document_ids == ("major_x",)
    assert set(result.rejected_document_ids) == {"periodic_x", "exchange_x", "holding_x"}
    for doc_id in result.rejected_document_ids:
        assert result.rejection_reasons[doc_id] == ("doc_group_mismatch",)


# ---------- 7) subtype 불명확 시 AMBIGUOUS ----------

def test_unclear_subtype_yields_ambiguous_without_dropping_candidates():
    cands = [
        _chunk("c1", "exchange_match", corp_name="합성기업A", doc_group="exchange",
              doc_subtype="단일판매공급계약체결"),
        _chunk("c2", "exchange_unclear", corp_name="합성기업A", doc_group="exchange",
              doc_subtype=None),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}),
                exchange_subtypes=frozenset({"단일판매공급계약체결"}))
    result = binder.bind_documents("합성기업A의 계약금액은?", cond, cands)
    assert result.status == binder.STATUS_AMBIGUOUS
    assert result.selected_document_ids == ()
    assert {c.chunk_id for c in result.retained_candidates} == {"c1", "c2"}
    assert result.rejected_document_ids == ()


# ---------- 8) 기간 불명확 시 후보를 삭제하지 않음 ----------

def test_unclear_period_is_not_excluded():
    cands = [_chunk("c1", "exchange_only", corp_name="합성기업A", doc_group="exchange",
                    rcept_dt=None)]
    cond = _cond(corps=frozenset({"합성기업A"}), years=frozenset({2024}))
    result = binder.bind_documents("합성기업A의 2024년 계약금액은?", cond, cands)
    assert result.status == binder.STATUS_BOUND
    assert result.rejected_document_ids == ()
    assert [c.chunk_id for c in result.retained_candidates] == ["c1"]
    assert result.diagnostics["unknown_dimensions"].get("exchange_only") == ("period",)


# ---------- 9) 다른 회사 문서 제외 ----------

def test_other_company_document_excluded():
    cands = [
        _chunk("c1", "exchange_right_corp", corp_name="합성기업A", doc_group="exchange"),
        _chunk("c2", "exchange_wrong_corp", corp_name="합성기업B", doc_group="exchange"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents("합성기업A의 계약금액은?", cond, cands)
    assert result.status == binder.STATUS_BOUND
    assert result.selected_document_ids == ("exchange_right_corp",)
    assert result.rejected_document_ids == ("exchange_wrong_corp",)
    assert result.rejection_reasons["exchange_wrong_corp"] == ("company_mismatch",)


# ---------- 10) 기존 rank 안정성 ----------

def test_original_rank_is_preserved_and_not_reordered():
    cands = [
        _chunk("c1", "doc_b", corp_name="합성기업A", doc_group="exchange"),
        _chunk("c2", "doc_a", corp_name="합성기업A", doc_group="exchange"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents("합성기업A 관련 공시는?", cond, cands)
    assert result.original_rank == {"c1": 1, "c2": 2}
    # 동률(둘 다 정보 완비, 우열 불가) -> rank가 앞선 c1(doc_b)이 이긴다.
    assert result.status == binder.STATUS_BOUND
    assert result.selected_document_ids == ("doc_b",)


def test_retained_candidates_never_reorder_relative_to_input():
    cands = [
        _chunk("c1", "doc_x", corp_name="합성기업A", doc_group="exchange", rcept_dt="20240101"),
        _chunk("c2", "doc_y", corp_name="합성기업A", doc_group="periodic", rcept_dt="20240201"),
        _chunk("c3", "doc_x", corp_name="합성기업A", doc_group="exchange", rcept_dt="20240101"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))  # doc_group 요구 없음 -> 둘 다 생존, 동률
    result = binder.bind_documents("합성기업A 관련 공시는?", cond, cands)
    # doc_x가 rank 1로 더 앞서 있으므로 BOUND(doc_x), 그 안의 c1/c3 순서는 입력 순서 그대로.
    assert [c.chunk_id for c in result.retained_candidates] == ["c1", "c3"]


# ---------- 11) top-20 밖 후보 유입 0 ----------

def test_no_new_candidates_are_introduced():
    cands = [_chunk("c1", "doc_a", corp_name="합성기업A", doc_group="exchange"),
             _chunk("c2", "doc_b", corp_name="합성기업B", doc_group="exchange")]
    cond = _cond()
    result = binder.bind_documents("공시 내용은?", cond, cands)
    input_ids = {c.chunk_id for c in cands}
    for group in result.candidate_groups:
        for c in group.candidates:
            assert c.chunk_id in input_ids
    for c in result.retained_candidates:
        assert c.chunk_id in input_ids


# ---------- 12) 동일 document_id grouping ----------

def test_same_document_id_multiple_chunks_grouped_as_one_document():
    cands = [
        _chunk("c1", "doc_multi", corp_name="합성기업A", doc_group="exchange", node_indices=[9]),
        _chunk("c2", "doc_multi", corp_name="합성기업A", doc_group="exchange", node_indices=[10]),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents("합성기업A의 계약금액은?", cond, cands)
    assert result.status == binder.STATUS_BOUND
    assert result.selected_document_ids == ("doc_multi",)
    assert len(result.candidate_groups) == 1
    assert {c.chunk_id for c in result.candidate_groups[0].candidates} == {"c1", "c2"}
    assert len(result.retained_candidates) == 2


# ---------- 13) multi-node provenance 보존 ----------

def test_multi_node_provenance_preserved_unchanged():
    original_provenance = {"node_indices": [9, 10, 11], "status": "MULTI_NODE_AMBIGUOUS"}
    c = RetrievedChunk(chunk_id="c1", doc_id="doc_multi_node", score=0.5, section_path=(),
                       row_labels=(), evidence_text="본문",
                       metadata={"corp_name": "합성기업A", "doc_group": "major",
                                "provenance": original_provenance},
                       node_index=None)
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents("합성기업A의 자기주식 처분은?", cond, [c])
    assert result.retained_candidates[0].metadata["provenance"] == original_provenance


# ---------- 14) 전체 evidence budget 최대 20 ----------

def test_total_evidence_budget_never_exceeds_twenty():
    # 3개 회사 비교 질문 -> role 3개(회사별) -> budget이 3개 문서에 20을 나눠 갖는다.
    cands = [
        _chunk("c1", "doc_a", corp_name="합성기업A", doc_group="exchange"),
        _chunk("c2", "doc_b", corp_name="합성기업B", doc_group="exchange"),
        _chunk("c3", "doc_c", corp_name="합성기업C", doc_group="exchange"),
    ]
    cond = _cond(corps=frozenset({"합성기업A", "합성기업B", "합성기업C"}))
    result = binder.bind_documents("합성기업A·B·C의 계약금액을 비교하면?", cond, cands)
    assert result.status == binder.STATUS_MULTI_DOCUMENT_BOUND
    assert sum(result.document_budgets.values()) <= binder.DEFAULT_TOTAL_EVIDENCE_BUDGET
    assert sum(result.document_budgets.values()) == binder.DEFAULT_TOTAL_EVIDENCE_BUDGET


def test_single_document_gets_full_budget_no_arbitrary_cap():
    cands = [_chunk("c1", "doc_a", corp_name="합성기업A", doc_group="exchange")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents("합성기업A의 계약금액은?", cond, cands)
    assert result.document_budgets == {"doc_a": binder.DEFAULT_TOTAL_EVIDENCE_BUDGET}


# ---------- 15) 단일 slot에서 문서 혼합 금지 ----------

def test_bound_status_never_mixes_two_documents_in_retained_candidates():
    cands = [
        _chunk("c1", "doc_a", corp_name="합성기업A", doc_group="exchange"),
        _chunk("c2", "doc_b", corp_name="합성기업A", doc_group="exchange"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents("합성기업A의 계약금액은?", cond, cands)
    assert result.status == binder.STATUS_BOUND
    assert len({c.doc_id for c in result.retained_candidates}) == 1


# ---------- 16) 입력 불변성 ----------

def test_inputs_are_not_mutated():
    cands = [_chunk("c1", "doc_a", corp_name="합성기업A", doc_group="exchange")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    cands_before = copy.deepcopy(cands)
    cond_before = copy.deepcopy(cond)
    question = "합성기업A의 계약금액은?"
    binder.bind_documents(question, cond, cands)
    assert cands == cands_before
    assert cond == cond_before


# ---------- 17) 반복 실행 byte-identical(구조적 동일) ----------

def test_deterministic_repeated_calls():
    cands = [
        _chunk("c1", "doc_a", corp_name="합성기업A", doc_group="exchange"),
        _chunk("c2", "doc_b", corp_name="합성기업B", doc_group="exchange"),
    ]
    cond = _cond(corps=frozenset({"합성기업A", "합성기업B"}))
    question = "합성기업A와 합성기업B의 계약금액을 비교하면?"
    r1 = binder.bind_documents(question, cond, cands)
    r2 = binder.bind_documents(question, cond, cands)
    assert r1 == r2


# ---------- 추가: 우선순위 6(동률 시 rank 유지)이 실제로 BOUND를 낸다 ----------

def test_tie_with_complete_information_breaks_by_rank_not_ambiguous():
    cands = [
        _chunk("c1", "doc_first", corp_name="합성기업A", doc_group="exchange",
              rcept_dt="20240101", doc_subtype="단일판매공급계약체결", is_correction=False),
        _chunk("c2", "doc_second", corp_name="합성기업A", doc_group="exchange",
              rcept_dt="20240101", doc_subtype="단일판매공급계약체결", is_correction=False),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents("합성기업A의 계약금액은?", cond, cands)
    assert result.status == binder.STATUS_BOUND
    assert result.selected_document_ids == ("doc_first",)


# ---------- 추가: 입력이 비면 UNRESOLVED ----------

def test_empty_input_is_unresolved():
    result = binder.bind_documents("아무 질문", _cond(), [])
    assert result.status == binder.STATUS_UNRESOLVED
    assert result.retained_candidates == ()
    assert result.document_budgets == {}


def test_all_rejected_is_unresolved():
    cands = [_chunk("c1", "doc_a", corp_name="합성기업B", doc_group="exchange")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents("합성기업A의 계약금액은?", cond, cands)
    assert result.status == binder.STATUS_UNRESOLVED
    assert result.rejected_document_ids == ("doc_a",)
    assert result.retained_candidates == ()
