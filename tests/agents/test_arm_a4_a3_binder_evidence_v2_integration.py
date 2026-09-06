"""arm_a4_a3_binder_evidence_v2_adapter 계약 테스트 — Turn
A4-A3-QA-BINDER-EVIDENCE-V2-INTEGRATION-V1.

전부 합성 fixture만 쓴다(실제 A4/A3 결과·Gold 미사용, 검색·DB·KURE·LLM 호출 0). 계약은
docs/A4_A3_QA_BINDER_EVIDENCE_V2_INTEGRATION_V1_CONTRACT.md — 이 테스트가 그 계약을
검증한다. DocumentBinder·Evidence V2 자체의 세부 규칙(요구 항목 커버리지, children 상한 등)은
tests/agents/test_arm_a_document_binder.py·test_arm_a_evidence_v2.py가 이미 검증한다 — 여기서는
"두 모듈을 새 opt-in backend로 조립했을 때" 그 조립 지점의 계약만 검증한다.
"""
from __future__ import annotations

import copy
import hashlib
import inspect
from pathlib import Path

import pytest

from dart_corpus.retrieval.conditions import QueryConditions
from dart_detective import arm_a4_a3_binder_evidence_v2_adapter as integ
from dart_detective import arm_a_document_binder as binder
from dart_detective import arm_a_evidence as ev
from dart_detective import arm_a_serving_bridge as bridge
from dart_detective.corpus_retriever import RetrievedChunk

REPO = Path(__file__).resolve().parents[2]


# ---------- 합성 fixture 헬퍼(기존 두 테스트 파일과 동일한 패턴) ----------

def _chunk(chunk_id, doc_id, node_index=0, **meta) -> RetrievedChunk:
    node_indices = meta.pop("node_indices", [node_index])
    metadata = {**meta, "provenance": {"node_indices": node_indices}}
    return RetrievedChunk(chunk_id=chunk_id, doc_id=doc_id, score=1.0, section_path=("공시",),
                          row_labels=(), evidence_text=f"{doc_id} 원본 parent evidence",
                          metadata=metadata, node_index=node_index)


def _cond(**kwargs) -> QueryConditions:
    defaults = dict(corps=frozenset(), years=frozenset(), year_months=frozenset(),
                    doc_groups=frozenset(), periodic_subtypes=frozenset(),
                    exchange_subtypes=frozenset(), major_labels=frozenset(),
                    correction=False, wants_latest=False, candidate_terms=())
    defaults.update(kwargs)
    return QueryConditions(**defaults)


def _doc(doc_id: str, nodes: list[dict]) -> dict:
    return {"doc_id": doc_id, "doc_group": "major", "nodes": nodes}


def _table_node(index: int, text: str, section=("공시",)) -> dict:
    return {"node_index": index, "kind": "table", "text": text, "section_hierarchy": list(section)}


def _row_children(out: list[RetrievedChunk]) -> list[RetrievedChunk]:
    return [c for c in out if c.metadata.get("arm_a_normalization") == ev.ARM_A_EVIDENCE_NORMALIZATION]


def _locators(children: list[RetrievedChunk]) -> list[tuple]:
    return [(c.doc_id, (c.metadata.get("provenance") or {}).get("normalized_node_index"),
             (c.metadata.get("provenance") or {}).get("normalized_row_index"))
            for c in children]


_CONTRACT_TABLE = "\n".join([
    "계약상대방 | 한국항공우주산업(주)",
    "계약금액 | 120,000,000,000원",
    "시작일 | 2024-01-01",
    "종료일 | 2026-12-31",
    "최근매출액 | 2,500,000,000,000원",
    "매출액대비 | 4.8%",
])
_CONTRACT_QUESTION = "이 계약의 계약상대방, 계약금액, 계약기간, 최근매출액 대비 비율은?"


# ================== 1) BOUND 문서 하나에서만 행 복원 ==================

def test_bound_restores_rows_from_the_single_bound_document_only():
    doc = _doc("major_a", [_table_node(0, _CONTRACT_TABLE)])
    cands = [_chunk("p1", "major_a", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}), doc_groups=frozenset({"major"}))
    out = integ.apply_binder_and_evidence_v2(_CONTRACT_QUESTION, cond, cands, {"major_a": doc})
    rows = _row_children(out)
    assert rows, "행이 하나도 복원되지 않았다"
    assert {c.doc_id for c in out} == {"major_a"}
    assert all(c.metadata.get("binder_status") == binder.STATUS_BOUND for c in out)


# ================== 2) 다른 document_id 행 유입 0 ==================

def test_bound_never_leaks_rows_from_the_rejected_document():
    doc_a = _doc("major_a", [_table_node(0, _CONTRACT_TABLE)])
    doc_b = _doc("major_b", [_table_node(0, "계약금액 | 999,999,999원")])
    cands = [
        _chunk("p1", "major_a", corp_name="합성기업A", doc_group="major"),
        _chunk("p2", "major_b", corp_name="합성기업B", doc_group="major"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(
        _CONTRACT_QUESTION, cond, cands, {"major_a": doc_a, "major_b": doc_b})
    assert {c.doc_id for c in out} == {"major_a"}
    joined = "\n".join(c.evidence_text for c in out)
    assert "999,999,999원" not in joined


# ================== 3/4) MULTI_DOCUMENT_BOUND 역할별 분리 — 두 연도 혼합 방지 ==================

def test_multi_document_bound_keeps_two_year_documents_separate():
    doc_2024 = _doc("periodic_2024", [_table_node(0, "매출액 | 2024년값 100억원")])
    doc_2023 = _doc("periodic_2023", [_table_node(0, "매출액 | 2023년값 90억원")])
    cands = [
        _chunk("p1", "periodic_2024", corp_name="합성기업A", doc_group="periodic", base_year=2024),
        _chunk("p2", "periodic_2023", corp_name="합성기업A", doc_group="periodic", base_year=2023),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}), years=frozenset({2024, 2023}))
    out = integ.apply_binder_and_evidence_v2(
        "합성기업A의 2024년과 2023년 매출액을 비교하면?", cond, cands,
        {"periodic_2024": doc_2024, "periodic_2023": doc_2023})
    by_role: dict[str, set[str]] = {}
    for c in out:
        by_role.setdefault(c.metadata.get("binder_role"), set()).add(c.doc_id)
    assert by_role == {"year_2024": {"periodic_2024"}, "year_2023": {"periodic_2023"}}
    text_2024 = "\n".join(c.evidence_text for c in out if c.metadata.get("binder_role") == "year_2024")
    text_2023 = "\n".join(c.evidence_text for c in out if c.metadata.get("binder_role") == "year_2023")
    assert "90억원" not in text_2024
    assert "100억원" not in text_2023


# ================== 5) 현재/직전 문서 혼합 방지 ==================

def test_previous_current_documents_are_never_mixed():
    doc_prev = _doc("holding_earlier", [_table_node(0, "보유주식수 | 직전 10,000주")])
    doc_cur = _doc("holding_latest", [_table_node(0, "보유주식수 | 현재 12,000주")])
    cands = [
        _chunk("p1", "holding_latest", corp_name="합성기업A", doc_group="holding", rcept_dt="20240601"),
        _chunk("p2", "holding_earlier", corp_name="합성기업A", doc_group="holding", rcept_dt="20240101"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(
        "직전 보고서 대비 이번 보고서의 보유주식수 변동은?", cond, cands,
        {"holding_latest": doc_cur, "holding_earlier": doc_prev})
    current_docs = {c.doc_id for c in out if c.metadata.get("binder_role") == "current"}
    previous_docs = {c.doc_id for c in out if c.metadata.get("binder_role") == "previous"}
    assert current_docs == {"holding_latest"}
    assert previous_docs == {"holding_earlier"}
    assert current_docs.isdisjoint(previous_docs)


# ================== 6) 정정 전/후 문서 구분 ==================

def test_correction_before_after_documents_are_kept_distinct():
    doc_before = _doc("major_original", [_table_node(0, "계약금액 | 정정전 100원")])
    doc_after = _doc("major_corrected", [_table_node(0, "계약금액 | 정정후 200원")])
    cands = [
        _chunk("p1", "major_original", corp_name="합성기업A", doc_group="major", is_correction=False),
        _chunk("p2", "major_corrected", corp_name="합성기업A", doc_group="major", is_correction=True),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(
        "정정 전 계약금액과 정정 후 계약금액이 어떻게 다른가?", cond, cands,
        {"major_original": doc_before, "major_corrected": doc_after})
    before_docs = {c.doc_id for c in out if c.metadata.get("binder_role") == "before"}
    after_docs = {c.doc_id for c in out if c.metadata.get("binder_role") == "after"}
    assert before_docs == {"major_original"}
    assert after_docs == {"major_corrected"}


# ================== 7) AMBIGUOUS에서 부모 top-20 유지 ==================

def test_ambiguous_keeps_original_top_k_unexpanded():
    cands = [
        _chunk("p1", "exchange_match", corp_name="합성기업A", doc_group="exchange",
              doc_subtype="단일판매공급계약체결"),
        _chunk("p2", "exchange_unclear", corp_name="합성기업A", doc_group="exchange",
              doc_subtype=None),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}), exchange_subtypes=frozenset({"단일판매공급계약체결"}))
    # bind_documents 자체가 AMBIGUOUS를 내는지 먼저 확인(전제 조건).
    assert binder.bind_documents("합성기업A의 계약금액은?", cond, cands).status == binder.STATUS_AMBIGUOUS
    out = integ.apply_binder_and_evidence_v2("합성기업A의 계약금액은?", cond, cands, {})
    assert [c.chunk_id for c in out] == ["p1", "p2"]
    assert all(c.evidence_text.endswith("원본 parent evidence") for c in out)
    assert not _row_children(out), "AMBIGUOUS에서는 행 확장을 하면 안 된다"
    assert all(c.metadata.get("binder_status") == binder.STATUS_AMBIGUOUS for c in out)


# ================== 8) UNRESOLVED에서 부모 top-20 유지 ==================

def test_unresolved_keeps_original_top_k_unexpanded():
    cands = [_chunk("p1", "doc_a", corp_name="합성기업B", doc_group="exchange")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    assert binder.bind_documents("합성기업A의 계약금액은?", cond, cands).status == binder.STATUS_UNRESOLVED
    out = integ.apply_binder_and_evidence_v2("합성기업A의 계약금액은?", cond, cands, {})
    assert [c.chunk_id for c in out] == ["p1"]
    assert out[0].evidence_text == "doc_a 원본 parent evidence"
    assert out[0].metadata.get("binder_status") == binder.STATUS_UNRESOLVED


# ================== 9) Evidence V2가 빈 결과일 때 부모 fallback ==================

def test_missing_document_falls_back_to_parent_evidence():
    # docs_by_id에 문서가 아예 없다 — arm_a_evidence 내부가 _unresolved(parent 그대로)로
    # fallback해야 한다(§D-7).
    cands = [_chunk("p1", "major_a", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(_CONTRACT_QUESTION, cond, cands, {})
    assert len(out) == 1
    assert out[0].evidence_text == "major_a 원본 parent evidence"
    assert out[0].doc_id == "major_a"


# ================== 10) 요구 항목 coverage 부족 시 부모 fallback ==================

def test_incomplete_coverage_keeps_parent_evidence_alongside_rows():
    doc = _doc("major_c", [_table_node(0, "계약상대방 | 한화오션")])
    cands = [_chunk("p1", "major_c", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    # 표에 없는 항목(계약금액)까지 요구 — 불완전 조립.
    out = integ.apply_binder_and_evidence_v2(
        "계약상대방과 계약금액은?", cond, cands, {"major_c": doc})
    assert any(c.evidence_text == "major_c 원본 parent evidence" for c in out), (
        "불완전 조립인데 원본 parent evidence가 사라졌다")


# ================== 11) 6항목 계약서 보존 ==================

def test_six_field_contract_survives_the_full_pipeline():
    doc = _doc("major_d", [_table_node(0, _CONTRACT_TABLE)])
    cands = [_chunk("p1", "major_d", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(_CONTRACT_QUESTION, cond, cands, {"major_d": doc})
    joined = "\n".join(c.evidence_text for c in out)
    for must in ("한국항공우주산업", "120,000,000,000원", "2024-01-01", "2026-12-31",
                 "2,500,000,000,000원", "4.8%"):
        assert must in joined


# ================== 12) 산문형 단일 셀 보존 ==================

def test_prose_single_cell_row_is_preserved():
    text = "\n".join(["구분 | 값", "보유목적 : 경영권 영향력 행사 목적"])
    doc = _doc("major_e", [_table_node(0, text)])
    cands = [_chunk("p1", "major_e", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2("보유목적은 무엇인가?", cond, cands, {"major_e": doc})
    joined = "\n".join(c.evidence_text for c in out)
    assert "경영권 영향력 행사 목적" in joined


# ================== 13) source row/line locator 충돌 없음 ==================

def test_source_row_locators_do_not_collide():
    text = "\n".join([
        "구분 | 값",
        "계약상대방 | 한화오션",
        "보유목적 : 경영권 영향력 행사",
        "계약금액 | 500,000,000원",
        "처분목적 : 운영자금 조달",
    ])
    doc = _doc("major_f", [_table_node(0, text)])
    cands = [_chunk("p1", "major_f", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(
        "계약상대방, 계약금액, 보유목적, 처분목적은?", cond, cands, {"major_f": doc})
    rows = _row_children(out)
    locs = _locators(rows)
    assert len(locs) == len(set(locs))


# ================== 14/15) 최종 evidence 최대 20 · document budget 합계 최대 20 ==================

def _wide_table(n_rows: int) -> str:
    return "\n".join(f"항목{i} | 값{i}" for i in range(n_rows))


def test_final_evidence_never_exceeds_twenty_for_bound():
    doc = _doc("major_g", [_table_node(0, _wide_table(30))])
    wanted_question = " ".join(f"항목{i}" for i in range(30)) + "은 무엇인가?"
    cands = [_chunk("p1", "major_g", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(wanted_question, cond, cands, {"major_g": doc})
    assert len(out) <= integ.TOTAL_EVIDENCE_CAP


def test_document_budgets_sum_to_cap_and_each_group_respects_its_budget():
    docs = {}
    cands = []
    n_docs = 5
    for i in range(n_docs):
        doc_id = f"periodic_{2020 + i}"
        docs[doc_id] = _doc(doc_id, [_table_node(0, _wide_table(30))])
        cands.append(_chunk(f"p{i}", doc_id, corp_name="합성기업A", doc_group="periodic",
                            base_year=2020 + i))
    cond = _cond(corps=frozenset({"합성기업A"}), years=frozenset(range(2020, 2020 + n_docs)))
    question = "합성기업A의 " + ", ".join(str(y) for y in range(2020, 2020 + n_docs)) + "년 매출액을 비교하면?"
    result = binder.bind_documents(question, cond, cands)
    assert result.status == binder.STATUS_MULTI_DOCUMENT_BOUND
    assert sum(result.document_budgets.values()) == integ.TOTAL_EVIDENCE_CAP
    out = integ.apply_binder_and_evidence_v2(question, cond, cands, docs)
    assert len(out) <= integ.TOTAL_EVIDENCE_CAP
    for doc_id, budget in result.document_budgets.items():
        n_for_doc = sum(1 for c in out if c.doc_id == doc_id)
        assert n_for_doc <= budget, f"{doc_id}가 자기 budget({budget})을 넘었다: {n_for_doc}"


# ================== 16) 동일 행만 dedup ==================

def test_only_identical_rows_deduplicate_across_overlapping_parents():
    text = "\n".join(["계약상대방 | 한화오션", "계약금액 | 500,000,000원"])
    doc = _doc("major_h", [_table_node(0, text)])
    cands = [
        _chunk("pA", "major_h", corp_name="합성기업A", doc_group="major"),
        _chunk("pB", "major_h", corp_name="합성기업A", doc_group="major"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2("계약상대방과 계약금액은?", cond, cands, {"major_h": doc})
    rows = _row_children(out)
    locs = _locators(rows)
    assert len(locs) == len(set(locs))
    assert len(rows) == 2, "겹치는 두 parent가 뽑아낸 서로 다른 두 행은 살아남아야 한다"


# ================== 17) 기존 parent rank 보존 ==================

def test_existing_parent_rank_is_preserved_in_output_metadata():
    doc = _doc("major_i", [_table_node(0, _CONTRACT_TABLE)])
    cands = [_chunk("p1", "major_i", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(_CONTRACT_QUESTION, cond, cands, {"major_i": doc})
    rows = _row_children(out)
    assert rows and all(c.metadata.get("arm_a_parent_rank") == 1 for c in rows)


# ================== 18) A4/A3 순위 변경 없음 ==================

def test_binder_does_not_reorder_the_a4_a3_candidate_list():
    doc_a = _doc("major_j1", [_table_node(0, "계약금액 | 1원")])
    doc_b = _doc("major_j2", [_table_node(0, "계약금액 | 2원")])
    cands = [
        _chunk("rank1", "major_j1", corp_name="합성기업A", doc_group="major"),
        _chunk("rank2", "major_j2", corp_name="합성기업A", doc_group="major"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    result = binder.bind_documents(_CONTRACT_QUESTION, cond, cands, )
    # 동률(둘 다 정보가 있고 rank로 결정) -> rank가 가장 앞선 rank1 문서가 BOUND.
    assert result.status == binder.STATUS_BOUND
    assert result.selected_document_ids == ("major_j1",)
    assert [c.chunk_id for c in result.retained_candidates] == ["rank1"]


# ================== 19) top-20 밖 후보 유입 0 ==================

def test_no_candidate_outside_the_original_top_k_leaks_in():
    doc = _doc("major_k", [_table_node(0, _CONTRACT_TABLE)])
    cands = [_chunk("p1", "major_k", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(_CONTRACT_QUESTION, cond, cands, {"major_k": doc})
    input_doc_ids = {c.doc_id for c in cands}
    assert {c.doc_id for c in out} <= input_doc_ids
    for c in out:
        assert c.chunk_id == "p1" or c.chunk_id.startswith("p1::"), (
            f"top-20 밖에서 온 것으로 보이는 chunk_id: {c.chunk_id}")


# ================== 20) 입력 불변성 ==================

def test_inputs_are_not_mutated():
    doc = _doc("major_l", [_table_node(0, _CONTRACT_TABLE)])
    docs_by_id = {"major_l": doc}
    cands = [_chunk("p1", "major_l", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    docs_before = copy.deepcopy(docs_by_id)
    cands_before = list(cands)
    metadata_before = dict(cands[0].metadata)

    integ.apply_binder_and_evidence_v2(_CONTRACT_QUESTION, cond, cands, docs_by_id)

    assert docs_by_id == docs_before
    assert cands == cands_before
    assert cands[0].metadata == metadata_before


# ================== 21) 반복 실행 byte-identical ==================

def test_repeated_execution_is_byte_identical():
    doc = _doc("major_m", [_table_node(0, _CONTRACT_TABLE)])
    cands = [_chunk("p1", "major_m", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out1 = integ.apply_binder_and_evidence_v2(_CONTRACT_QUESTION, cond, cands, {"major_m": doc})
    out2 = integ.apply_binder_and_evidence_v2(_CONTRACT_QUESTION, cond, cands, {"major_m": doc})
    assert [c.to_dict() for c in out1] == [c.to_dict() for c in out2]


# ================== 22) 특정 기업명·question_id 하드코딩 없음 ==================

_REAL_CORP_NAMES = ("알테오젠", "고려아연", "삼성전기", "시프트업", "효성중공업",
                    "한미반도체", "삼성E&A", "두산에너빌리티", "LIG넥스원", "현대제철",
                    "HMM", "현대모비스", "신한지주", "메리츠", "한국항공우주산업",
                    "LGES", "LG에너지솔루션")


def test_adapter_module_has_no_hardcoded_real_company_names_or_question_ids():
    src = inspect.getsource(integ)
    for name in _REAL_CORP_NAMES:
        assert name not in src, f"실제 기업명이 하드코딩됐다: {name}"
    assert "question_id ==" not in src


# ================== 23) Gold/DB-write/KURE/LLM/network 호출 추가 0 ==================

def test_adapter_module_has_zero_search_db_kure_llm_network_imports():
    src = inspect.getsource(integ)
    forbidden = ("requests", "httpx", "sqlite3", "socket", "subprocess",
                 "sentence_transformers", "anthropic", "psycopg",
                 "arm_a_live_worker_client", "from .llm", "import llm",
                 "DEV_CHECK", "HOLDOUT", "gold", "Gold", "GOLD")
    # kure_pin은 arm_a4_a3_live_adapter.py의 기존 readiness dict 필드를 그대로 옮기는
    # pass-through일 뿐 실제 KURE 클라이언트 호출이 아니다(arm_a4_a3_live_adapter.py
    # 자체도 이 값을 만들 뿐 KURE를 직접 호출하지 않는다) — 별도로 확인한다.
    assert "KUREClient" not in src and "kure_server" not in src.lower()
    for token in forbidden:
        assert token not in src, f"금지된 참조: {token}"


# ================== 24) 기존 backend 기본값 및 동작 회귀 없음 ==================

_EXPECTED_UNCHANGED_FILE_SHA256 = {
    "src/dart_detective/corpus_retriever.py":
        "c64bc9b4011fac8862f80c9dd8f3b8510f28c16718b613b74bc76160b44fcc8a",
    "src/dart_detective/agents/qa_agent.py":
        "43e055aafc93c06f346ced4484bb94dc821111abc4c5b8b8c93d9470355d7020",
    "src/dart_detective/arm_a_live_adapter.py":
        "d997a4459c601d09ec2dbc47614aa83ebac47ee9a26e0284db313c64edde551b",
    "src/dart_detective/arm_a4_a3_live_adapter.py":
        "1307b265dae284792a5e38268fab8cb8024fa658d1243fb9b0941d4423e3e7e7",
    "src/dart_detective/agents/validator.py":
        "0fbc179e1f9251f8dd2965d33bd292fdd9e1d71bcc35ac6e239338b897ac6423",
}


def test_existing_qa_a4_a3_files_byte_unchanged():
    for rel_path, expected_sha in _EXPECTED_UNCHANGED_FILE_SHA256.items():
        actual = hashlib.sha256((REPO / rel_path).read_bytes()).hexdigest()
        assert actual == expected_sha, f"{rel_path}가 바뀌었다 — 이 turn은 이 파일을 건드리면 안 된다"


def test_existing_backend_constants_and_defaults_are_unchanged():
    assert bridge.RETRIEVAL_BACKEND_DEFAULT == "DEFAULT"
    assert bridge.RETRIEVAL_BACKEND_ARM_A_LIVE == "ARM_A_LIVE"
    assert bridge.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE == "ARM_A4_A3_LIVE"
    for old in (bridge.RETRIEVAL_BACKEND_DEFAULT, bridge.RETRIEVAL_BACKEND_ARM_A,
                bridge.RETRIEVAL_BACKEND_ARM_A_FROZEN_REPLAY, bridge.RETRIEVAL_BACKEND_ARM_A_LIVE,
                bridge.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE):
        assert old in bridge.RETRIEVAL_BACKENDS


def test_new_backend_is_additive_and_opt_in_only():
    assert bridge.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2 == (
        "ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2")
    assert bridge.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2 in bridge.RETRIEVAL_BACKENDS
    # Turn A4-A3-FINAL-COMBINED-BACKEND-PREP-V1이 7번째 opt-in backend
    # (ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE)를 additive하게 추가했다—
    # tests/agents/test_arm_a4_a3_remediation_binder_evidence_v2_integration.py가 그 배선을 검증한다.
    assert len(bridge.RETRIEVAL_BACKENDS) == 7


# ================== 25) 조건 mapper 101/101 성공 유지 ==================

def test_condition_mapper_101_report_still_reports_101_of_101(tmp_path):
    import json
    import subprocess

    proc = subprocess.run(
        ["node", "scripts/qa_condition_mapping_101_report.mjs"],
        cwd=REPO, capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    for arm in ("ARM_A_LIVE", "ARM_A4_A3_LIVE"):
        assert report[arm]["new"]["success"] == 101
        assert report[arm]["total"] == 101


# ==================== §H: e59330c 회귀 방지 ====================

def test_h_evidence_does_not_balloon_from_twenty_to_eighty_plus():
    doc = _doc("major_n", [_table_node(0, _wide_table(50))])
    wanted_question = " ".join(f"항목{i}" for i in range(50)) + "은 무엇인가?"
    cands = [_chunk("p1", "major_n", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(wanted_question, cond, cands, {"major_n": doc})
    assert len(out) <= 20


def test_h_rows_from_different_documents_never_share_one_answer_without_role_separation():
    doc_a = _doc("major_o1", [_table_node(0, "계약금액 | A문서값")])
    doc_b = _doc("major_o2", [_table_node(0, "계약금액 | B문서값")])
    cands = [
        _chunk("p1", "major_o1", corp_name="합성기업A", doc_group="major"),
        _chunk("p2", "major_o2", corp_name="합성기업B", doc_group="major"),
    ]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(_CONTRACT_QUESTION, cond, cands,
                                             {"major_o1": doc_a, "major_o2": doc_b})
    assert {c.doc_id for c in out} == {"major_o1"}


def test_h_sibling_rows_are_not_dropped_because_of_one_exact_label_hit():
    text = "\n".join(["계약상대방 | 한화오션", "계약금액 | 500,000,000원", "시작일 | 2024-01-01"])
    doc = _doc("major_p", [_table_node(0, text)])
    cands = [_chunk("p1", "major_p", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(
        "계약상대방, 계약금액, 시작일은?", cond, cands, {"major_p": doc})
    joined = "\n".join(c.evidence_text for c in out)
    assert "한화오션" in joined and "500,000,000원" in joined and "2024-01-01" in joined


def test_h_five_to_six_requested_items_are_not_lost_to_a_fixed_children_cap():
    text = "\n".join([
        "계약상대방 | X", "계약금액 | Y", "시작일 | Z1", "종료일 | Z2",
        "최근매출액 | W", "매출액대비 | V",
    ])
    doc = _doc("major_q", [_table_node(0, text)])
    cands = [_chunk("p1", "major_q", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(_CONTRACT_QUESTION, cond, cands, {"major_q": doc})
    rows = _row_children(out)
    assert len(rows) >= 6


def test_h_pipe_less_prose_row_is_not_dropped():
    text = "\n".join(["구분 | 값", "보유목적 : 경영권 영향력 행사 목적"])
    doc = _doc("major_r", [_table_node(0, text)])
    cands = [_chunk("p1", "major_r", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2("보유목적은?", cond, cands, {"major_r": doc})
    joined = "\n".join(c.evidence_text for c in out)
    assert "경영권 영향력 행사 목적" in joined


def test_h_source_row_line_locator_conflicts_never_happen():
    text = "\n".join([
        "구분 | 값", "계약상대방 | 한화오션", "보유목적 : 경영권 영향력 행사",
        "계약금액 | 500,000,000원", "처분목적 : 운영자금 조달",
    ])
    doc = _doc("major_s", [_table_node(0, text)])
    cands = [_chunk("p1", "major_s", corp_name="합성기업A", doc_group="major")]
    cond = _cond(corps=frozenset({"합성기업A"}))
    out = integ.apply_binder_and_evidence_v2(
        "계약상대방, 계약금액, 보유목적, 처분목적은?", cond, cands, {"major_s": doc})
    rows = _row_children(out)
    locs = _locators(rows)
    assert len(locs) == len(set(locs))


# ================== ArmA4A3BinderEvidenceV2ServingRetriever wiring smoke ==================

class _FakeInner:
    arm = "A4_A3"

    def __init__(self, results: list[RetrievedChunk], docs_by_id: dict):
        self._results = results
        self.docs_by_id = docs_by_id

    def conditions(self, question: str) -> QueryConditions:
        return _cond(corps=frozenset({"합성기업A"}))

    def statement_scopes(self, doc_id: str):
        return {}

    def retrieve(self, question: str, conditions=None, *, k=None):
        return list(self._results)


def test_serving_retriever_wraps_inner_retrieve_with_binder_and_evidence_v2():
    doc = _doc("major_t", [_table_node(0, _CONTRACT_TABLE)])
    inner = _FakeInner(
        [_chunk("p1", "major_t", corp_name="합성기업A", doc_group="major")], {"major_t": doc})
    outer = integ.ArmA4A3BinderEvidenceV2ServingRetriever(inner)  # type: ignore[arg-type]
    out = outer.retrieve(_CONTRACT_QUESTION, k=20)
    assert out
    assert all(c.doc_id == "major_t" for c in out)
    assert outer.last["n_base"] == 1
    assert outer.arm == "A4_A3_BINDER_EVIDENCE_V2"


def test_answer_api_dispatches_the_new_backend_additively():
    from dart_detective import answer_api

    assert hasattr(answer_api, "arm_a4_a3_binder_evidence_v2_adapter")
    src = inspect.getsource(answer_api._build_retriever)
    assert "RETRIEVAL_BACKEND_ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2" in src
    # 기존 분기(ARM_A4_A3_LIVE)가 여전히 남아 있다 — additive, 대체 아님.
    assert "RETRIEVAL_BACKEND_ARM_A4_A3_LIVE" in src
