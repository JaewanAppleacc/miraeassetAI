"""arm_a_evidence(node-row-v2) 계약 테스트 — Turn A-PLUS-QA-EVIDENCE-V2.

전부 손으로 만든 합성 fixture만 쓴다(실제 A.results.jsonl·실제 Gold 파일 미사용,
검색·DB·KURE·LLM 호출 0) — DEV_TUNE 실행·DEV_CHECK/HOLDOUT 접근을 하지 않는다는
원칙을 지킨다. 검색 파사드(corpus_retriever.py)·A4/A3·qa_agent.py·현재 동결 브랜치는
건드리지 않는다 — 아래 byte-lock 테스트가 이를 잠근다.
"""
from __future__ import annotations

import hashlib
import inspect
from pathlib import Path

import pytest

from dart_detective import arm_a_evidence as ev
from dart_detective.corpus_retriever import RetrievedChunk

REPO = Path(__file__).resolve().parents[2]

# ---------- 기존 파일 byte-invariance (검색·A4·A3·기본 QA 경로 회귀 없음) ----------

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
        "03898eda36ec920dd2f9a5bc9605a6d68d6137b53829b86de14e03cff3d50796",
    "src/dart_detective/answer_api.py":
        "226055241c3453438a99271723002710b55fd1648b85dab30f10a4bbeb2814f8",
    "src/dart_detective/agents/validator.py":
        "0fbc179e1f9251f8dd2965d33bd292fdd9e1d71bcc35ac6e239338b897ac6423",
}


def test_existing_qa_files_byte_unchanged():
    for rel_path, expected_sha in _EXPECTED_UNCHANGED_FILE_SHA256.items():
        actual = hashlib.sha256((REPO / rel_path).read_bytes()).hexdigest()
        assert actual == expected_sha, f"{rel_path}가 base commit과 달라졌다(검색/A4/A3/기본 경로 불변 위반)"


def test_module_makes_zero_search_db_kure_llm_calls():
    """import 자체가 정적 증거다 — 검색/DB/KURE/LLM 클라이언트를 전혀 참조하지 않는다."""
    src = inspect.getsource(ev)
    forbidden = ("requests", "httpx", "sqlite3", "subprocess", "socket",
                 "sentence_transformers", "anthropic", "arm_a_live_worker_client",
                 "retriever_adapter", "llm.py", "from .llm", "import llm")
    for token in forbidden:
        assert token not in src, f"arm_a_evidence.py가 금지된 의존성을 참조한다: {token}"


# ---------- 합성 fixture 헬퍼 ----------

def _doc(doc_id: str, nodes: list[dict]) -> dict:
    return {"doc_id": doc_id, "doc_group": "major", "nodes": nodes}


def _table_node(index: int, text: str, section=("공시",)) -> dict:
    return {"node_index": index, "kind": "table", "text": text,
            "section_hierarchy": list(section)}


def _para_node(index: int, text: str, section=("공시",)) -> dict:
    return {"node_index": index, "kind": "paragraph", "text": text,
            "section_hierarchy": list(section)}


def _parent(doc_id: str, chunk_id: str, node_indices: list[int], text: str = "parent window",
           score: float = 1.0) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id, doc_id=doc_id, score=score, section_path=("공시",),
        row_labels=(), evidence_text=text,
        metadata={"provenance": {"node_indices": node_indices}},
        node_index=node_indices[0] if node_indices else None,
    )


def _row_locators(children: list[RetrievedChunk]) -> list[tuple]:
    return [(c.doc_id,
             (c.metadata.get("provenance") or {}).get("normalized_node_index"),
             (c.metadata.get("provenance") or {}).get("normalized_row_index"))
            for c in children
            if c.metadata.get("arm_a_normalization") == ev.ARM_A_EVIDENCE_NORMALIZATION]


# ---------- 1) 6개 필드 계약서 — 동적 children, 고정 4 제거 ----------

def test_six_field_contract_keeps_all_six_requested_rows():
    text = "\n".join([
        "1. 계약내용",
        "계약상대방 | 한국항공우주산업(주)",
        "계약금액 | 120,000,000,000원",
        "시작일 | 2024-01-01",
        "종료일 | 2026-12-31",
        "최근매출액 | 2,500,000,000,000원",
        "매출액대비 | 4.8%",
        "계약체결기관 | 이사회",
        "비고 | 해당사항 없음",
    ])
    doc = _doc("major_1", [_table_node(0, text)])
    parent = _parent("major_1", "p1", [0])
    question = "이 계약의 계약상대방, 계약금액, 계약기간, 최근매출액 대비 비율은?"
    out = ev.normalize_arm_a_evidence(question, [parent], {"major_1": doc})
    joined = "\n".join(c.evidence_text for c in out)
    for must in ("한국항공우주산업", "120,000,000,000원", "2024-01-01", "2026-12-31",
                 "2,500,000,000,000원", "4.8%"):
        assert must in joined, f"고정 4 상한이면 여기서 누락됐을 값: {must}"
    # 옛 고정 상한(4)이었다면 여기서 실패했을 것 — 6개 요구 항목이 전부 살아있어야 한다.
    row_children = [c for c in out
                    if c.metadata.get("arm_a_normalization") == ev.ARM_A_EVIDENCE_NORMALIZATION]
    assert len(row_children) >= 6


def test_global_safety_cap_is_twelve():
    question = ("계약금액 해지금액 투자금액 자기자본대비 매출액대비 최근매출액 종료일 "
                "시작일 해지일자 해지사유 계약상대 공급지역 투자목적 투자대상 이사회결의일")
    wanted = ev._requested_labels(question)
    assert len(wanted) > ev.GLOBAL_MAX_CHILDREN_PER_PARENT, "fixture가 상한을 실제로 넘겨야 의미 있는 테스트다"
    rows = [f"{label} | 값{i}" for i, label in enumerate(wanted)]
    text = "\n".join(rows)
    doc = _doc("major_2", [_table_node(0, text)])
    parent = _parent("major_2", "p2", [0])
    out = ev.normalize_arm_a_evidence(question, [parent], {"major_2": doc})
    row_children = [c for c in out
                    if c.metadata.get("arm_a_normalization") == ev.ARM_A_EVIDENCE_NORMALIZATION]
    assert len(row_children) > 4, "고정 4 상한이 아니라 동적으로 늘어야 한다"
    assert len(row_children) <= ev.GLOBAL_MAX_CHILDREN_PER_PARENT, "전체 안전 상한(12)을 넘었다"


# ---------- 2) exact label 1개 + sibling 5개 — 필터가 아니라 가산점 ----------

def test_exact_label_is_a_bonus_not_a_filter():
    text = "\n".join([
        "처분예정주식의 종류와 수",
        "보통주식 | 10,000주",
        "기타주식 | 0주",
        "처분예정주식 | 10,000주",
        "우선주식 | 0주",
        "전환우선주 | 0주",
        "신주인수권부사채 | 0주",
    ])
    doc = _doc("major_3", [_table_node(0, text)])
    parent = _parent("major_3", "p3", [0])
    question = "처분예정주식의 수는 몇 주인가?"
    out = ev.normalize_arm_a_evidence(question, [parent], {"major_3": doc})
    row_children = [c for c in out
                    if c.metadata.get("arm_a_normalization") == ev.ARM_A_EVIDENCE_NORMALIZATION]
    labels = [c.row_labels[0] for c in row_children]
    assert "처분예정주식" in labels
    # 옛 버그: exact 필터가 발동하면 sibling 행이 전부 사라져 1개만 남는다.
    assert len(row_children) > 1, "exact label이 필터로 동작해 sibling 행을 지운 것으로 보인다"


# ---------- 3) 산문형 보유목적 셀(파이프 없는 병합 셀) ----------

def test_prose_holding_purpose_cell_is_a_candidate():
    text = "\n".join([
        "5. 보유목적",
        "보유목적 : 경영권 영향력 행사를 위한 목적으로 주식등을 보유함",
    ])
    doc = _doc("holding_1", [_table_node(0, text)])
    parent = _parent("holding_1", "p4", [0])
    question = "보유목적은 무엇인가?"
    out = ev.normalize_arm_a_evidence(question, [parent], {"holding_1": doc})
    joined = "\n".join(c.evidence_text for c in out)
    assert "경영권 영향력 행사" in joined


# ---------- 4) 빈 셀이 섞인 표 ----------

def test_table_with_empty_cells_does_not_crash_and_keeps_row():
    text = "\n".join([
        "구분 | 금액 | 비고",
        "계약금액 |  | ",
        "계약상대방 | 한화오션 | ",
        " | 500,000,000원 | 확정",
    ])
    doc = _doc("major_4", [_table_node(0, text)])
    parent = _parent("major_4", "p5", [0])
    question = "계약금액과 계약상대방은?"
    out = ev.normalize_arm_a_evidence(question, [parent], {"major_4": doc})
    joined = "\n".join(c.evidence_text for c in out)
    assert "한화오션" in joined


# ---------- 5) 반복 라벨 ----------

def test_repeated_labels_do_not_crowd_out_other_requested_items():
    text = "\n".join([
        "구분 | 내용",
        "비고 | 첫 번째 비고",
        "계약상대방 | 유일기업",
        "비고 | 두 번째 비고",
        "비고 | 세 번째 비고",
    ])
    doc = _doc("major_5", [_table_node(0, text)])
    parent = _parent("major_5", "p6", [0])
    question = "계약상대방과 비고는?"
    out = ev.normalize_arm_a_evidence(question, [parent], {"major_5": doc})
    joined = "\n".join(c.evidence_text for c in out)
    assert "유일기업" in joined, "반복 라벨(비고)이 예산을 독점해 계약상대방을 밀어냈다"


# ---------- 6) 연결/별도 문맥 보존 ----------

def test_consolidated_scope_is_preserved_in_evidence_text():
    nodes = [
        _para_node(0, "가. 요약연결재무정보"),
        _table_node(1, "매출액 | 100 | 90\n영업이익 | 10 | 8"),
    ]
    doc = _doc("periodic_1", nodes)
    parent = _parent("periodic_1", "p7", [1])
    question = "연결 기준 매출액은?"
    out = ev.normalize_arm_a_evidence(question, [parent], {"periodic_1": doc})
    joined = "\n".join(c.evidence_text for c in out)
    assert "연결" in joined


def test_separate_scope_is_preserved_in_evidence_text():
    nodes = [
        _para_node(0, "나. 요약재무정보"),
        _table_node(1, "매출액 | 100 | 90\n영업이익 | 10 | 8"),
    ]
    doc = _doc("periodic_2", nodes)
    parent = _parent("periodic_2", "p8", [1])
    question = "별도 기준 매출액은?"
    out = ev.normalize_arm_a_evidence(question, [parent], {"periodic_2": doc})
    joined = "\n".join(c.evidence_text for c in out)
    assert "별도" in joined


# ---------- 7) 단위·기간 header 보존 ----------

def test_unit_and_period_header_context_preserved():
    text = "\n".join([
        "(단위 : 백만원)",
        "구분 | 2024년 | 2023년",
        "매출액 | 1,000 | 900",
    ])
    doc = _doc("periodic_3", [_table_node(0, text)])
    parent = _parent("periodic_3", "p9", [0])
    question = "2024년 매출액은?"
    out = ev.normalize_arm_a_evidence(question, [parent], {"periodic_3": doc})
    joined = "\n".join(c.evidence_text for c in out)
    assert "단위 : 백만원" in joined
    assert "2024년" in joined and "2023년" in joined


# ---------- 8) 자식 근거 부족 시 부모 fallback ----------

def test_incomplete_children_keep_parent_evidence():
    text = "\n".join([
        "계약상대방 | 한화오션",
    ])
    doc = _doc("major_6", [_table_node(0, text)])
    parent = _parent("major_6", "p10", [0], text="원본 parent 전체 evidence 텍스트")
    # 표에 없는 항목(계약금액)까지 요구 — 불완전 조립이 되어야 한다.
    question = "계약상대방과 계약금액은?"
    out = ev.normalize_arm_a_evidence(question, [parent], {"major_6": doc})
    assert any(c.evidence_text == "원본 parent 전체 evidence 텍스트" for c in out), (
        "불완전 조립인데 원본 부모 evidence가 사라졌다")


def test_no_matching_row_at_all_falls_back_to_parent_context():
    text = "\n".join(["구분 | 값", "무관한항목 | 무관한값"])
    doc = _doc("major_7", [_table_node(0, text)])
    parent = _parent("major_7", "p11", [0], text="원본 parent")
    question = "계약금액은 얼마인가?"
    out = ev.normalize_arm_a_evidence(question, [parent], {"major_7": doc})
    assert len(out) == 1
    assert out[0].evidence_text == "원본 parent"
    assert out[0].metadata.get("arm_a_normalization") == "parent-context"


def test_missing_document_falls_back_to_unresolved_parent():
    parent = _parent("unknown_doc", "p12", [0], text="원본 parent")
    out = ev.normalize_arm_a_evidence("아무 질문", [parent], {})
    assert len(out) == 1
    assert out[0].evidence_text == "원본 parent"
    assert out[0].metadata.get("arm_a_normalization") == "unresolved"


# ---------- 9) 결정론 및 입력 불변성 ----------

def test_deterministic_and_does_not_mutate_inputs():
    text = "\n".join([
        "계약상대방 | 한화오션",
        "계약금액 | 500,000,000원",
    ])
    doc = _doc("major_8", [_table_node(0, text)])
    docs_by_id = {"major_8": doc}
    parent = _parent("major_8", "p13", [0])
    chunks = [parent]
    question = "계약상대방과 계약금액은?"

    import copy
    docs_before = copy.deepcopy(docs_by_id)
    chunks_before = list(chunks)

    out1 = ev.normalize_arm_a_evidence(question, chunks, docs_by_id)
    out2 = ev.normalize_arm_a_evidence(question, chunks, docs_by_id)

    assert [c.to_dict() for c in out1] == [c.to_dict() for c in out2]
    assert docs_by_id == docs_before, "docs_by_id가 호출 중 변형됐다"
    assert chunks == chunks_before, "입력 chunks 리스트가 변형됐다"
    assert parent.metadata == {"provenance": {"node_indices": [0]}}, "parent.metadata가 제자리에서 바뀌었다"


# ---------- 7 재확인) source_row_index — 파이프 없는 행도 실제 행 기준으로 카운트 ----------

def test_source_row_index_counts_every_actual_row_not_just_pipe_rows():
    """옛 버그: `|` 있는 줄만 세면 서로 다른 두 산문(단일 셀) 행이 같은
    normalized_row_index로 계산돼 dedup 단계에서 하나가 삭제된다. 두 산문 행이
    같은 노드 안에서 서로 다른 인덱스를 받고 **둘 다 살아남아야** 한다."""
    text = "\n".join([
        "구분 | 값",
        "계약상대방 | 한화오션",
        "보유목적 : 경영권 영향력 행사",   # 파이프 없는 행 (행 2)
        "계약금액 | 500,000,000원",
        "처분목적 : 운영자금 조달",         # 파이프 없는 행 (행 4)
    ])
    doc = _doc("major_9", [_table_node(0, text)])
    parent = _parent("major_9", "p14", [0])
    question = "계약상대방, 계약금액, 보유목적, 처분목적은?"
    out = ev.normalize_arm_a_evidence(question, [parent], {"major_9": doc})
    row_children = [c for c in out
                    if c.metadata.get("arm_a_normalization") == ev.ARM_A_EVIDENCE_NORMALIZATION]
    locators = _row_locators(row_children)
    assert len(locators) == len(set(locators)), "서로 다른 행이 같은 locator로 충돌해 dedup됐다"
    joined = "\n".join(c.evidence_text for c in row_children)
    assert "경영권 영향력 행사" in joined
    assert "운영자금 조달" in joined


# ---------- 동일 행만 중복 제거(요구 9) ----------

def test_only_identical_rows_are_deduplicated_across_overlapping_parents():
    text = "\n".join([
        "계약상대방 | 한화오션",
        "계약금액 | 500,000,000원",
    ])
    doc = _doc("major_10", [_table_node(0, text)])
    # 두 parent가 같은 노드를 가리킨다(겹치는 Fixed512 윈도) — 동일 행은 한 번만.
    p1 = _parent("major_10", "pA", [0], text="window A")
    p2 = _parent("major_10", "pB", [0], text="window B")
    question = "계약상대방과 계약금액은?"
    out = ev.normalize_arm_a_evidence(question, [p1, p2], {"major_10": doc})
    row_children = [c for c in out
                    if c.metadata.get("arm_a_normalization") == ev.ARM_A_EVIDENCE_NORMALIZATION]
    locators = _row_locators(row_children)
    assert len(locators) == len(set(locators))
    # 겹치는 두 parent가 뽑아낸 두 개의 서로 다른 행(계약상대방/계약금액)은 살아남아야 한다.
    assert len(row_children) == 2


# ---------- 기존 QA 기본 경로 회귀 없음: 전체 스위트 ----------

def test_full_agent_suite_has_no_collected_errors():
    """이 모듈 추가가 기존 컬렉션에 오류를 만들지 않는지만 빠르게 확인한다
    (전체 실행은 CI가 하고, 여기서는 import 그래프 손상만 조기에 잡는다)."""
    import importlib

    import dart_detective.agents.qa_agent  # noqa: F401
    import dart_detective.corpus_retriever  # noqa: F401
    importlib.reload(ev)
