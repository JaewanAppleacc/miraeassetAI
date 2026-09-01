"""POST /qa 배선 테스트.

라우터만 올려서 검증한다 — 앱 전체나 111MB 코퍼스
인덱스 없이도 "질문 -> Agent -> Retrieval -> evidence -> 답변"이 이어지는지 본다.
Retriever는 dependency_overrides로 합성본을 주입한다.
"""
from __future__ import annotations

import pytest

fastapi = pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from dart_detective import qa_service  # noqa: E402
from tests.agents.test_qa_agent import (  # noqa: E402
    QUESTION, FakeLLM, ir_doc, indexed, SUMMARY_TABLE, UNIVERSE_ROWS,
)
from dart_corpus.retrieval import DocumentIndex  # noqa: E402
from dart_corpus.retrieval.corp_dictionary import CorpDictionary  # noqa: E402
from dart_detective.corpus_retriever import CorpusRetriever  # noqa: E402


def build_retriever() -> CorpusRetriever:
    corp_dict = CorpDictionary.from_rows(UNIVERSE_ROWS)
    index = DocumentIndex(
        [indexed("periodic_hmm_2025", "HMM", text=SUMMARY_TABLE, base_year=2025)],
        corp_dict)
    docs = {"periodic_hmm_2025": ir_doc(
        "periodic_hmm_2025", text=SUMMARY_TABLE,
        section=["III. 재무에 관한 사항", "1. 요약재무정보"])}
    return CorpusRetriever(document_index=index, corp_dict=corp_dict, docs_by_id=docs)


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(qa_service.router)
    app.dependency_overrides[qa_service.get_retriever] = build_retriever
    return TestClient(app)


def test_qa_endpoint_returns_answer_and_evidence(client):
    res = client.post("/qa", json={"question": QUESTION})
    assert res.status_code == 200
    body = res.json()
    assert body["answer"]
    assert body["evidence"], "근거 없이 답이 나갔다"
    for ev in body["evidence"]:
        assert set(ev) == {"chunk_id", "text", "section_path", "doc_id"}
        assert ev["doc_id"] == "periodic_hmm_2025"
    assert body["slots"] == ["매출액_2025", "영업이익_2025"]
    assert body["validation"]["status"] != "UNSUPPORTED"
    assert body["n_retrieved"] > 0


def test_qa_endpoint_uses_injected_llm(client, monkeypatch):
    fake = FakeLLM()
    monkeypatch.setattr(qa_service, "get_llm", lambda: fake)
    body = client.post("/qa", json={"question": QUESTION}).json()
    assert fake.calls
    assert body["llm"]["used"] is True and body["llm"]["provider"] == "fake"


def test_qa_response_never_leaks_credentials(client, monkeypatch):
    monkeypatch.setenv("CLOVA_API_KEY", "secret-key-value")
    text = client.post("/qa", json={"question": QUESTION}).text
    assert "secret-key-value" not in text


def test_qa_rejects_empty_question(client):
    assert client.post("/qa", json={"question": ""}).status_code == 422


def test_qa_health_reports_provider_without_key(client, monkeypatch):
    monkeypatch.delenv("CLOVA_API_KEY", raising=False)
    body = client.get("/qa/health").json()
    assert body["llm_enabled"] is False and body["llm_provider"] is None
    assert set(body) == {"status", "index_ready", "missing", "loaded",
                         "llm_provider", "llm_enabled"}


def test_missing_index_returns_503(monkeypatch, tmp_path):
    monkeypatch.setenv("DART_QA_DOC_INDEX", str(tmp_path / "nope.jsonl"))
    monkeypatch.setenv("DART_QA_DOCUMENTS", str(tmp_path / "nope2.jsonl"))
    monkeypatch.setenv("DART_QA_UNIVERSE", str(tmp_path / "nope3.csv"))
    qa_service.reset_retriever()
    app = FastAPI()
    app.include_router(qa_service.router)
    res = TestClient(app).post("/qa", json={"question": QUESTION})
    assert res.status_code == 503
    assert "코퍼스 인덱스가 없다" in res.json()["detail"]
