"""arm_a_serving_bridge + answer_api retrieval_backend 배선 — Turn A-PLUS-QA-LIVE-WIRING-V1.

전부 합성 fixture(가짜 A.results.jsonl 1문항·가짜 Gold 질문 파일·가짜 base)로만 돈다.
실제 LLM·DEV_TUNE·judge·DEV_CHECK/HOLDOUT은 건드리지 않는다.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from dart_corpus.retrieval.conditions import QueryConditions
from dart_detective import answer_api, arm_a_serving_bridge as br
from dart_detective.corpus_retriever import RetrievedChunk

# ---------- 합성 fixture ----------

QUESTION = "합성기업의 2024년 계약금액은 얼마인가?"
QID = "synthetic_q_0001"
SINGLE_TEXT = "계약금액 | 1,234,000,000원"
MULTI_TEXT = "1. 계약상대 | 합성상대\n2. 계약기간 | 2024-01-01 ~ 2025-12-31"


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


ITEMS = [
    {"rank": 2, "doc_id": "major_20240913000790", "node_index": 9, "node_indices": [9, 10, 11, 12],
     "locator": "major_20240913000790::20240913000790.xml::n9", "row": 0, "col": 0,
     "chunk_id": "chunk_multi_0002", "chunk_text_sha256": _sha(MULTI_TEXT),
     "score": 0.021, "score_type": "RRF"},
    {"rank": 1, "doc_id": "exchange_20240403000410", "node_index": 5, "node_indices": [5],
     "locator": "exchange_20240403000410::20240403000410.xml::n5", "row": None, "col": None,
     "chunk_id": "chunk_single_0001", "chunk_text_sha256": _sha(SINGLE_TEXT),
     "score": 0.031, "score_type": "RRF"},
]
TEXTS = {"chunk_single_0001": SINGLE_TEXT, "chunk_multi_0002": MULTI_TEXT}


def good_resolver(*, doc_id, node_index, node_indices, chunk_id, chunk_text_sha256):
    return TEXTS[chunk_id]


def bad_resolver(*, doc_id, node_index, node_indices, chunk_id, chunk_text_sha256):
    return "다른 본문 — sha 불일치"


class _FakeBase:
    """CorpusRetriever 모양의 최소 가짜: conditions·docs_by_id·문서 메타·statement_scopes."""
    docs_by_id = {"exchange_20240403000410": {"doc_id": "exchange_20240403000410", "nodes": []}}
    strategy = "line_window"

    def conditions(self, q):
        return QueryConditions()

    def _metadata_of(self, doc_id):
        return {"corp_name": "합성기업", "doc_group": doc_id.split("_", 1)[0], "rcept_dt": "20240403"}

    def statement_scopes(self, doc_id):
        return {5: "연결"}

    def retrieve(self, q, c=None, *, k=None):
        raise AssertionError("A 경로에서 base.retrieve()가 불리면 안 된다")


class _FakeStore(dict):
    def readiness(self):
        return {"n_docs": 1, "pins": {"fake_store": True}}


def _fake_base_factory(**paths):
    return _FakeBase(), _FakeStore()


@pytest.fixture
def a_files(tmp_path: Path):
    results = tmp_path / "A.results.jsonl"
    results.write_text(json.dumps({
        "question_id": QID, "arm": "A", "segment": "HIGH",
        "config_sha256": "cfg" * 10, "code_sha256": "code" * 10, "latency_ms": 1,
        "results": ITEMS}, ensure_ascii=False) + "\n", encoding="utf-8")
    gold = tmp_path / "gold.jsonl"
    gold.write_text(json.dumps({"question_id": QID, "question": QUESTION}, ensure_ascii=False) + "\n",
                    encoding="utf-8")
    return results, gold


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("CLOVA_API_KEY", raising=False)          # LLM 없음 → 결정론 경로
    monkeypatch.delenv(br.RETRIEVAL_BACKEND_ENV, raising=False)
    monkeypatch.delenv("DART_QA_ARM", raising=False)
    answer_api.configure()
    yield
    answer_api.configure()


def _configure_a(a_files, resolver):
    results, gold = a_files
    answer_api.configure(retrieval_backend=br.RETRIEVAL_BACKEND_ARM_A, text_resolver=resolver,
                         results_path=results, gold_questions_path=gold,
                         base_factory=_fake_base_factory)


# ---------- 7. 기존 B/D 기본 경로 회귀 ----------

def test_default_backend_calls_build_serving_retriever_unchanged(monkeypatch):
    calls = []
    sentinel = object()

    def fake_build(arm):
        calls.append(arm)
        return sentinel, _FakeStore(), arm, {"strategy": "line_window"}

    monkeypatch.setattr(answer_api, "build_serving_retriever", fake_build)
    monkeypatch.setattr(br, "build_arm_a_serving_retriever",
                        lambda **kw: (_ for _ in ()).throw(AssertionError("기본 경로에서 A 브리지 호출")))
    assert answer_api._get_retriever() is sentinel
    assert calls == ["D"]                                   # env 없음 → DEFAULT_ARM 그대로
    answer_api.reset()
    monkeypatch.setenv("DART_QA_ARM", "B")
    answer_api._get_retriever()
    assert calls == ["D", "B"]                              # env 인자 전달도 그대로
    answer_api.reset()
    monkeypatch.setenv(br.RETRIEVAL_BACKEND_ENV, "DEFAULT")  # 명시적 DEFAULT도 같은 경로
    answer_api._get_retriever()
    assert calls == ["D", "B", "B"]


def test_default_backend_readiness_pins_unchanged(monkeypatch):
    """기본 경로의 pins에 브리지 키가 섞이지 않는다(캐시 키 불변)."""
    monkeypatch.setattr(answer_api, "build_serving_retriever",
                        lambda arm: (_FakeBase(), _FakeStore(), arm, {"strategy": "line_window"}))
    r = answer_api.readiness()
    assert r["ready"] is True and r["arm"] == "D" and r["retrieval_backend"] == "DEFAULT"
    assert not any(k.startswith("arm_a") or k in ("arm_ready", "retrieval_backend", "text_resolver_configured")
                   for k in r["pins"])


def test_unknown_backend_rejected(monkeypatch):
    monkeypatch.setenv(br.RETRIEVAL_BACKEND_ENV, "ARM_Z")
    with pytest.raises(ValueError):
        answer_api._get_retriever()
    assert answer_api.readiness()["ready"] is False


# ---------- 2/4/6. 브리지 변환·resolver 전달·provenance 보존 ----------

def test_bridge_returns_corpus_retriever_shape_and_preserves_provenance(a_files):
    _configure_a(a_files, good_resolver)
    r = answer_api._get_retriever()
    assert isinstance(r, br.ArmAServingRetriever)
    assert isinstance(r.conditions(QUESTION), QueryConditions)
    assert r.docs_by_id and r.statement_scopes("exchange_20240403000410") == {5: "연결"}
    hits = r.retrieve(QUESTION, r.conditions(QUESTION), k=20)
    assert [type(h) for h in hits] == [RetrievedChunk, RetrievedChunk]
    assert [h.chunk_id for h in hits] == ["chunk_single_0001", "chunk_multi_0002"]   # A rank 순
    single, multi = hits
    assert single.evidence_text == SINGLE_TEXT and multi.evidence_text == MULTI_TEXT
    assert single.node_index == 5 and multi.node_index == 9
    assert multi.metadata["provenance"]["node_indices"] == [9, 10, 11, 12]        # 축소 금지
    assert multi.metadata["provenance"]["chunk_text_sha256"] == _sha(MULTI_TEXT)
    assert multi.metadata["provenance"]["row"] == 0 and multi.metadata["provenance"]["col"] == 0
    assert single.metadata["arm"] == "A" and single.metadata["corp_name"] == "합성기업"   # base 문서 메타
    assert single.metadata["doc_group"] == "exchange"
    assert single.score == 0.031 and multi.score == 0.021                            # A 점수 그대로
    # to_dict(think_trace.retrieval)에도 provenance가 실린다.
    assert multi.to_dict()["metadata"]["provenance"]["node_indices"] == [9, 10, 11, 12]


def test_readiness_reports_arm_a_and_backend_pins(a_files):
    _configure_a(a_files, good_resolver)
    r = answer_api.readiness()
    assert r["ready"] is True and r["arm"] == "A" and r["retrieval_backend"] == br.RETRIEVAL_BACKEND_ARM_A
    pins = r["pins"]
    assert pins["retrieval_backend"] == br.RETRIEVAL_BACKEND_ARM_A
    assert pins["strategy"] == br.ARM_A_STRATEGY and pins["dense"] == "present"
    assert pins["arm_a_results_sha256"] == hashlib.sha256(a_files[0].read_bytes()).hexdigest()
    assert pins["text_resolver_configured"] is True and pins["arm_ready"] is True


# ---------- 5. fail-closed ----------

def test_missing_resolver_fails_closed(a_files):
    _configure_a(a_files, None)
    r = answer_api._get_retriever()
    with pytest.raises(br.TextResolutionRequired) as ei:
        r.retrieve(QUESTION)
    assert ei.value.code == "TEXT_RESOLUTION_REQUIRED"
    ready = answer_api.readiness()
    assert ready["ready"] is False and "TEXT_RESOLUTION_REQUIRED" in ready["error"]
    wire, meta = answer_api.answer_ex("Q-A1", QUESTION)
    assert set(wire) == {"question_id", "question", "retrieved_context", "think_trace", "answer"}
    assert all(isinstance(v, str) for v in wire.values())
    trace = json.loads(wire["think_trace"])
    assert trace["operations"][0] == {"step": "internal_error", "type": "TextResolutionRequired",
                                      "code": "TEXT_RESOLUTION_REQUIRED"}
    assert wire["retrieved_context"] == "" and meta["cacheable"] is False
    assert meta["error_code"] == "TEXT_RESOLUTION_REQUIRED"


def test_sha_mismatch_fails_closed(a_files):
    _configure_a(a_files, bad_resolver)
    with pytest.raises(br.TextResolutionRequired) as ei:
        answer_api._get_retriever().retrieve(QUESTION)
    assert ei.value.code == "TEXT_RESOLUTION_REQUIRED"


def test_empty_resolver_text_never_passes(a_files):
    _configure_a(a_files, lambda **kw: "")
    with pytest.raises(br.TextResolutionRequired):
        answer_api._get_retriever().retrieve(QUESTION)


def test_unknown_question_fails_closed(a_files):
    _configure_a(a_files, good_resolver)
    with pytest.raises(br.UnknownQuestionForFrozenArmA) as ei:
        answer_api._get_retriever().retrieve("frozen 집합에 없는 질문")
    assert ei.value.code == "UNKNOWN_QUESTION_FOR_FROZEN_ARM_A"


def test_missing_results_path_is_explicit(monkeypatch):
    monkeypatch.delenv("ARM_A_RESULTS_PATH", raising=False)
    answer_api.configure(retrieval_backend=br.RETRIEVAL_BACKEND_ARM_A, text_resolver=good_resolver,
                         base_factory=_fake_base_factory)
    with pytest.raises(br.ServingBridgeError):
        answer_api._get_retriever()


# ---------- 8. smoke: 합성 A 결과 1건 → answer_api ----------

def test_smoke_synthetic_a_result_reaches_answer_api(a_files):
    from dart_detective.agents import qa_agent

    _configure_a(a_files, good_resolver)
    retriever = answer_api._get_retriever()
    assert isinstance(retriever, br.ArmAServingRetriever)
    # (1) answer_api 직전 — qa_agent 파이프라인이 브리지에서 받은 A 결과를 그대로 들고 있다.
    state = qa_agent.answer_question(QUESTION, retriever, llm=None)
    got = state.retrieval_results
    assert [c.chunk_id for c in got] == ["chunk_single_0001", "chunk_multi_0002"]
    assert got[1].metadata["provenance"]["node_indices"] == [9, 10, 11, 12]
    assert got[1].metadata["arm"] == "A" and got[1].node_index == 9
    assert state.to_dict()["retrieval"][1]["metadata"]["provenance"]["node_indices"] == [9, 10, 11, 12]
    # (2) answer_api 경계 — 같은 질문이 5-string wire로 나오고 오류 경로가 아니다.
    wire, meta = answer_api.answer_ex("Q-A-smoke", QUESTION)
    assert set(wire) == {"question_id", "question", "retrieved_context", "think_trace", "answer"}
    assert all(isinstance(v, str) for v in wire.values())
    assert wire["question_id"] == "Q-A-smoke" and wire["question"] == QUESTION
    trace = json.loads(wire["think_trace"])
    assert trace["validation"]["status"] != "ERROR" and meta.get("error_code", "") == ""
    retrieval_op = next(op for op in trace["operations"] if op["step"] == "retrieval")
    assert retrieval_op["n_chunks"] == 2
    # base.retrieve()는 한 번도 불리지 않았다(_FakeBase.retrieve가 AssertionError를 낸다).
