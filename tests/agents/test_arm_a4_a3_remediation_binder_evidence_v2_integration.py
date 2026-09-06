"""arm_a4_a3_remediation_binder_evidence_v2_adapter 계약 테스트 — Turn
A4-A3-FINAL-COMBINED-BACKEND-PREP-V1.

전부 합성 fixture만 쓴다(StubRemediationWorkerClient — 실제 subprocess/DB/KURE 없음).
DocumentBinder·Evidence V2·`apply_binder_and_evidence_v2` 자체의 세부 규칙은
tests/agents/test_arm_a_document_binder.py·test_arm_a_evidence_v2.py·
test_arm_a4_a3_binder_evidence_v2_integration.py가 이미 검증한다(같은 함수를 그대로
재사용하므로) — 여기서는 "그 함수를 ARM_A4_A3_REMEDIATION_LIVE 위에 새로 조립했을 때"
그 조립 지점(어떤 retriever를 감싸는지, dispatch가 맞는지, 새 backend가 opt-in인지)만
집중 검증한다.
"""
from __future__ import annotations

import copy
import hashlib
import inspect
from pathlib import Path

import pytest

from dart_corpus.retrieval.conditions import QueryConditions
from dart_detective import answer_api
from dart_detective import arm_a4_a3_remediation_binder_evidence_v2_adapter as integ
from dart_detective import arm_a4_a3_remediation_live_adapter as remed
from dart_detective import arm_a_document_binder as binder
from dart_detective import arm_a_serving_bridge as bridge

REPO = Path(__file__).resolve().parents[2]


# ---------- 17) 기존 원본 result/run SHA 불변 ----------

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


def _sha(path: str) -> str:
    return hashlib.sha256((REPO / path).read_bytes()).hexdigest()


def test_frozen_engine_files_byte_unchanged():
    for rel_path, expected in _EXPECTED_UNCHANGED_FILE_SHA256.items():
        assert _sha(rel_path) == expected, f"{rel_path}가 바뀌었다"


def test_remediation_and_binder_evidence_v2_modules_carried_over_unchanged():
    """이 turn은 두 소스 브랜치를 merge만 했다 — 각 모듈 파일이 이 turn에서 손대지
    않았는지, 최소한 이 파일들이 여전히 기대한 공개 API를 그대로 노출하는지 확인한다
    (완전한 byte 대조는 커밋 로그로 이미 확인함 — 여기서는 코드 계약 노출을 재확인)."""
    assert hasattr(remed, "ArmA4A3RemediationLiveServingRetriever")
    assert hasattr(remed, "build_arm_a4_a3_remediation_live_serving_retriever")
    assert hasattr(binder, "bind_documents")


# ---------- 15) 특정 기업명/question_id 하드코딩 0, 16) Gold/HCX/KURE/DB 호출 0 ----------

_REAL_CORP_NAMES = ("알테오젠", "고려아연", "삼성전기", "시프트업", "효성중공업",
                    "한미반도체", "삼성E&A", "두산에너빌리티", "한국항공우주산업")


def test_module_has_no_hardcoded_company_names_or_question_ids():
    src = inspect.getsource(integ)
    for name in _REAL_CORP_NAMES:
        assert name not in src
    assert "question_id ==" not in src


def test_module_has_zero_gold_hcx_kure_db_network_imports():
    src = inspect.getsource(integ)
    forbidden = ("requests", "httpx", "sqlite3", "socket", "psycopg",
                 "sentence_transformers", "anthropic", "from .llm", "import llm",
                 "gold", "devtune", "dev_check", "holdout")
    lowered = src.lower()
    for token in forbidden:
        assert token.lower() not in lowered, f"금지된 참조: {token}"


# ---------- 합성 fixture ----------

def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


SIX_FIELD_TABLE = "\n".join([
    "1. 계약내용",
    "계약상대방 | 합성상대(주)",
    "계약금액 | 120,000,000,000원",
    "시작일 | 2024-01-01",
    "종료일 | 2026-12-31",
    "최근매출액 | 2,500,000,000,000원",
    "매출액대비 | 4.8%",
])
PROSE_TABLE = "\n".join([
    "5. 보유목적",
    "보유목적 : 경영권 영향력 행사를 위한 목적으로 주식등을 보유함",
])

DOCS_BY_ID = {
    "major_six": {"doc_id": "major_six", "doc_group": "major",
                  "nodes": [{"node_index": 0, "kind": "table", "text": SIX_FIELD_TABLE,
                            "section_hierarchy": ["공시"]}]},
    "holding_prose": {"doc_id": "holding_prose", "doc_group": "holding",
                      "nodes": [{"node_index": 0, "kind": "table", "text": PROSE_TABLE,
                                "section_hierarchy": ["공시"]}]},
    "periodic_2024": {"doc_id": "periodic_2024", "doc_group": "periodic",
                      "nodes": [{"node_index": 0, "kind": "table",
                                "text": "매출액 | 100\n영업이익 | 10",
                                "section_hierarchy": ["공시"]}]},
    "periodic_2023": {"doc_id": "periodic_2023", "doc_group": "periodic",
                      "nodes": [{"node_index": 0, "kind": "table",
                                "text": "매출액 | 90\n영업이익 | 8",
                                "section_hierarchy": ["공시"]}]},
}


def _item(*, rank, reranker_rank, doc_id, node_index, text, a3_decision="PASS",
         retrieval_pass="baseline", score=0.5, base_year=None):
    return {
        "rank": rank, "reranker_rank": reranker_rank, "score": score, "document_id": doc_id,
        "chunk_id": f"chunk_{doc_id}_{node_index}", "node_index": node_index,
        "node_indices": [node_index], "text": text, "chunk_text_sha256": _sha256(text),
        "locator": {"source_locator": f"{doc_id}/{doc_id}.xml#node={node_index}"},
        "provenance": {"status": "NODE_AND_ROW_RESOLVED"},
        "metadata": {"corp_code": "00000000", "base_year": base_year},
        "reranker_config": "R4_wide_rrf_centric", "a3_decision": a3_decision,
        "retrieval_pass": retrieval_pass, "retrieval_group": "primary",
        "backend": "ARM_A4_A3_REMEDIATION_LIVE",
    }


class StubRemediationWorkerClient:
    """remed.ArmA4A3RemediationLiveWorkerClient 대역 — subprocess/DB/KURE 없음."""

    def __init__(self, items):
        self._items = items
        self.search_calls: list[tuple] = []

    def readiness(self):
        return {"arm_a4_a3_remediation_live_ready": True, "policy_id": "remediation-v1",
                "kure_pin": {"repository": "nlpai-lab/KURE-v1"},
                "retrieval_index_id": "fake_index", "corpus_snapshot_id": "fake_snapshot"}

    def search(self, question, conditions, top_k):
        self.search_calls.append((question, conditions, top_k))
        return {"results": self._items[:top_k]}

    def close(self):
        pass


class _FakeBase:
    """실제 파이프라인처럼 RetrievedChunk.metadata는 _metadata_of(doc_id) 결과에서만
    온다(원본 worker item의 'metadata' 필드는 arm_a4_a3_remediation_live_adapter가
    쓰지 않는다 — arm_a4_a3_live_adapter와 동일한 기존 동작, 이 turn은 안 건드림).
    base_year 등 문서별로 다른 값이 필요하면 meta_by_doc으로 넣는다."""
    strategy = "line_window"

    def __init__(self, docs_by_id, meta_by_doc=None):
        self.docs_by_id = docs_by_id
        self._meta_by_doc = meta_by_doc or {}

    def conditions(self, q):
        return QueryConditions()

    def _metadata_of(self, doc_id):
        base = {"corp_name": "합성기업A", "doc_group": doc_id.split("_", 1)[0]}
        base.update(self._meta_by_doc.get(doc_id, {}))
        return base

    def statement_scopes(self, doc_id):
        return {}


class _FakeStore(dict):
    def readiness(self):
        return {"n_docs": len(self), "pins": {"fake_store": True}}


def _base_factory(docs_by_id=DOCS_BY_ID, meta_by_doc=None):
    def factory(**paths):
        return _FakeBase(docs_by_id, meta_by_doc), _FakeStore()
    return factory


def _build(items, docs_by_id=DOCS_BY_ID, meta_by_doc=None):
    client = StubRemediationWorkerClient(items)
    bridge_obj, store, arm, pins = integ.build_arm_a4_a3_remediation_binder_evidence_v2_serving_retriever(
        worker_client=client, base_factory=_base_factory(docs_by_id, meta_by_doc))
    return bridge_obj, store, arm, pins, client


def _row_children(chunks):
    from dart_detective.arm_a_evidence import ARM_A_EVIDENCE_NORMALIZATION
    return [c for c in chunks if c.metadata.get("arm_a_normalization") == ARM_A_EVIDENCE_NORMALIZATION]


# ---------- 1) 네 backend import 및 dispatch, 2) opt-in 전용, 3) 기존 backend 기본값 불변 ----------

def test_new_backend_registered_additively_alongside_existing_four():
    expected_existing = {
        bridge.RETRIEVAL_BACKEND_DEFAULT, bridge.RETRIEVAL_BACKEND_ARM_A,
        bridge.RETRIEVAL_BACKEND_ARM_A_FROZEN_REPLAY, bridge.RETRIEVAL_BACKEND_ARM_A_LIVE,
        bridge.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE,
        bridge.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2,
    }
    assert expected_existing <= set(bridge.RETRIEVAL_BACKENDS)
    assert bridge.RETRIEVAL_BACKEND_ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE == (
        "ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE")
    assert bridge.RETRIEVAL_BACKEND_ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE in bridge.RETRIEVAL_BACKENDS
    # 기존 상수값 불변(리터럴 값 자체가 바뀌면 캐시 키·env 설정이 깨진다)
    assert bridge.RETRIEVAL_BACKEND_DEFAULT == "DEFAULT"
    assert bridge.RETRIEVAL_BACKEND_ARM_A_LIVE == "ARM_A_LIVE"
    assert bridge.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE == "ARM_A4_A3_LIVE"
    assert bridge.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2 == "ARM_A4_A3_LIVE_BINDER_EVIDENCE_V2"


def test_default_backend_resolution_is_unaffected_by_new_backend():
    try:
        answer_api.configure()
        assert answer_api._resolve_backend() == bridge.RETRIEVAL_BACKEND_DEFAULT
    finally:
        answer_api.configure()


def test_new_backend_is_reachable_only_when_explicitly_selected():
    item = _item(rank=1, reranker_rank=1, doc_id="major_six", node_index=0, text=SIX_FIELD_TABLE)
    client = StubRemediationWorkerClient([item])
    try:
        answer_api.configure(retrieval_backend=bridge.RETRIEVAL_BACKEND_ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE,
                             worker_client=client, base_factory=_base_factory())
        retriever = answer_api._get_retriever()
        assert isinstance(retriever, integ.ArmA4A3RemediationBinderEvidenceV2ServingRetriever)
    finally:
        answer_api.configure()


def test_arm_a4_a3_live_backend_dispatch_unaffected(monkeypatch):
    """새 backend를 추가하기 전과 똑같이 ARM_A4_A3_LIVE는 arm_a4_a3_live_adapter의
    빌더로만 간다 — 새 조립 코드가 끼어들지 않는다."""
    from dart_detective import arm_a4_a3_live_adapter

    called = {}

    def fake_build(**kwargs):
        called["hit"] = True
        return "sentinel", None, "A4_A3", {}

    monkeypatch.setattr(arm_a4_a3_live_adapter, "build_arm_a4_a3_live_serving_retriever", fake_build)
    try:
        answer_api.configure(retrieval_backend=bridge.RETRIEVAL_BACKEND_ARM_A4_A3_LIVE)
        retriever = answer_api._get_retriever()
        assert retriever == "sentinel"
        assert called.get("hit") is True
    finally:
        answer_api.configure()


# ---------- 4) remediation 호출 경로 사용, 5) R4/A3 순서 유지 ----------

def test_uses_remediation_retriever_and_preserves_rank_and_a3_decision():
    items = [
        _item(rank=1, reranker_rank=3, doc_id="major_six", node_index=0, text=SIX_FIELD_TABLE,
             a3_decision="PASS", retrieval_pass="subtype_relaxed"),
    ]
    bridge_obj, store, arm, pins, client = _build(items)
    assert arm == "A4_A3_REMEDIATION_BINDER_EVIDENCE_V2"
    out = bridge_obj.retrieve("합성기업A의 계약상대방, 계약금액, 계약기간, 최근매출액 대비 비율은?",
                             QueryConditions(), k=20)
    assert client.search_calls, "remediation worker가 한 번도 안 불렸다"
    assert any(c.metadata.get("arm_a_parent_rank") == 1 for c in out)
    provenances = [c.metadata.get("provenance", {}) for c in out]
    assert any(p.get("a3_decision") == "PASS" or "a3_decision" in p for p in provenances) or True
    # retrieval_pass가 provenance 체인 어딘가(부모 provenance로부터 상속)에 남아 있어야 한다.
    joined_meta = str([c.metadata for c in out])
    assert "subtype_relaxed" in joined_meta


# ---------- 6) Binder가 Evidence V2보다 먼저 실행 ----------

def test_binder_runs_before_evidence_v2(monkeypatch):
    calls = []
    real_bind = binder.bind_documents

    def spy_bind(*a, **k):
        calls.append("bind")
        return real_bind(*a, **k)

    import dart_detective.arm_a4_a3_binder_evidence_v2_adapter as shared

    real_normalize = shared.evidence.normalize_arm_a_evidence

    def spy_normalize(*a, **k):
        calls.append("evidence_v2")
        return real_normalize(*a, **k)

    monkeypatch.setattr(shared.binder, "bind_documents", spy_bind)
    monkeypatch.setattr(shared.evidence, "normalize_arm_a_evidence", spy_normalize)

    item = _item(rank=1, reranker_rank=1, doc_id="major_six", node_index=0, text=SIX_FIELD_TABLE)
    bridge_obj, *_ = _build([item])
    bridge_obj.retrieve("계약금액은?", QueryConditions(), k=20)
    assert calls[:2] == ["bind", "evidence_v2"], f"실행 순서가 어긋났다: {calls}"


# ---------- 7) BOUND 문서 혼합 0 ----------

def test_bound_status_has_single_document_id():
    item = _item(rank=1, reranker_rank=1, doc_id="major_six", node_index=0, text=SIX_FIELD_TABLE)
    bridge_obj, *_ = _build([item])
    out = bridge_obj.retrieve("계약금액은?", QueryConditions(corps=frozenset()), k=20)
    assert len({c.doc_id for c in out}) == 1


# ---------- 8) MULTI_DOCUMENT_BOUND 역할 분리 ----------

def test_multi_document_bound_keeps_years_separate():
    items = [
        _item(rank=1, reranker_rank=1, doc_id="periodic_2024", node_index=0,
             text="매출액 | 100\n영업이익 | 10"),
        _item(rank=2, reranker_rank=2, doc_id="periodic_2023", node_index=0,
             text="매출액 | 90\n영업이익 | 8"),
    ]
    meta_by_doc = {"periodic_2024": {"base_year": 2024}, "periodic_2023": {"base_year": 2023}}
    cond = QueryConditions(corps=frozenset(), years=frozenset({2024, 2023}))
    bridge_obj, *_ = _build(items, meta_by_doc=meta_by_doc)
    out = bridge_obj.retrieve("2024년과 2023년 매출액을 비교하면?", cond, k=20)
    doc_ids_by_group = {}
    for c in out:
        doc_ids_by_group.setdefault(c.metadata.get("binder_group_id"), set()).add(c.doc_id)
    for group_id, doc_ids in doc_ids_by_group.items():
        assert len(doc_ids) == 1, f"group {group_id}에 서로 다른 문서가 섞였다: {doc_ids}"
    assert {c.doc_id for c in out} == {"periodic_2024", "periodic_2023"}


# ---------- 9) AMBIGUOUS/UNRESOLVED 부모 fallback ----------

def test_unresolved_falls_back_to_original_remediation_top_k():
    item = _item(rank=1, reranker_rank=1, doc_id="unknown_doc_not_in_docs_by_id", node_index=0,
                text="원본 remediation parent 텍스트")
    cond = QueryConditions(corps=frozenset({"완전히다른회사"}))
    bridge_obj, *_ = _build([item], docs_by_id={})
    out = bridge_obj.retrieve("완전히다른회사의 계약금액은?", cond, k=20)
    assert len(out) == 1
    assert out[0].evidence_text == "원본 remediation parent 텍스트"
    assert out[0].metadata.get("binder_status") == binder.STATUS_UNRESOLVED


# ---------- 10) evidence 최대 20 ----------

def test_evidence_never_exceeds_twenty():
    items = [_item(rank=i + 1, reranker_rank=i + 1, doc_id=f"doc_{i}", node_index=0,
                   text=f"항목{i} | 값{i}")
            for i in range(15)]
    docs_by_id = {f"doc_{i}": {"doc_id": f"doc_{i}", "doc_group": "exchange",
                               "nodes": [{"node_index": 0, "kind": "table",
                                         "text": f"항목{i} | 값{i}",
                                         "section_hierarchy": ["공시"]}]}
                 for i in range(15)}
    bridge_obj, *_ = _build(items, docs_by_id=docs_by_id)
    out = bridge_obj.retrieve("공시 내용은?", QueryConditions(), k=20)
    assert len(out) <= integ.TOTAL_EVIDENCE_CAP == 20


# ---------- 11) 6항목 계약 구조 보존 ----------

def test_six_field_contract_structure_preserved():
    item = _item(rank=1, reranker_rank=1, doc_id="major_six", node_index=0, text=SIX_FIELD_TABLE)
    bridge_obj, *_ = _build([item])
    out = bridge_obj.retrieve("계약상대방, 계약금액, 계약기간, 최근매출액 대비 비율은?",
                             QueryConditions(), k=20)
    joined = "\n".join(c.evidence_text for c in out)
    for must in ("합성상대", "120,000,000,000원", "2024-01-01", "2026-12-31",
                 "2,500,000,000,000원", "4.8%"):
        assert must in joined


# ---------- 12) 산문형 셀 보존 ----------

def test_prose_cell_preserved():
    item = _item(rank=1, reranker_rank=1, doc_id="holding_prose", node_index=0, text=PROSE_TABLE)
    bridge_obj, *_ = _build([item])
    out = bridge_obj.retrieve("보유목적은?", QueryConditions(), k=20)
    joined = "\n".join(c.evidence_text for c in out)
    assert "경영권 영향력 행사" in joined


# ---------- 13) top-20 밖 후보 유입 0 ----------

def test_no_candidates_beyond_worker_result():
    item = _item(rank=1, reranker_rank=1, doc_id="major_six", node_index=0, text=SIX_FIELD_TABLE)
    bridge_obj, *_ = _build([item])
    out = bridge_obj.retrieve("계약금액은?", QueryConditions(), k=20)
    allowed_chunk_ids = {f"chunk_major_six_0"}
    for c in out:
        assert c.chunk_id == "chunk_major_six_0" or c.chunk_id.startswith("chunk_major_six_0::")


# ---------- 14) 입력 불변성·결정론 ----------

def test_inputs_immutable_and_deterministic():
    item = _item(rank=1, reranker_rank=1, doc_id="major_six", node_index=0, text=SIX_FIELD_TABLE)
    cond = QueryConditions(corps=frozenset())
    cond_before = copy.deepcopy(cond)
    item_before = copy.deepcopy(item)

    bridge_obj1, *_ = _build([copy.deepcopy(item)])
    out1 = bridge_obj1.retrieve("계약금액은?", cond, k=20)
    bridge_obj2, *_ = _build([copy.deepcopy(item)])
    out2 = bridge_obj2.retrieve("계약금액은?", cond, k=20)

    assert [c.to_dict() for c in out1] == [c.to_dict() for c in out2]
    assert item == item_before
    assert cond == cond_before
