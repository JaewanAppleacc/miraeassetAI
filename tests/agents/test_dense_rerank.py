"""B arm dense 재정렬 — 가짜 encoder로 순서·동률·metadata·pins 검증. 모델 다운로드 없음."""
from __future__ import annotations

import numpy as np
import pytest

from dart_detective import dense_rerank as dr


class FakeEncoder:
    """'매출액'이 있으면 [1,0], 없으면 [0,1]. 질문 '매출액'과 cosine 1 / 0."""

    def __init__(self):
        self.calls: list[list[str]] = []

    def encode(self, texts, batch_size=16, normalize_embeddings=True, convert_to_numpy=True,
               show_progress_bar=False):
        self.calls.append(list(texts))
        return np.array([[1.0, 0.0] if "매출액" in t else [0.0, 1.0] for t in texts])


def _chunk(i: int, text: str, score: float) -> dict:
    return {"chunk_id": f"c{i}", "doc_id": "d", "node_index": i, "locator": f"d/1.xml#node={i}",
            "text": text, "header": "", "section_path": [], "doc_group": "periodic",
            "score": score, "metadata": {"corp_name": "HMM"}}


def test_rerank_orders_by_cosine_and_breaks_ties_by_bm25_rank():
    enc = FakeEncoder()
    rr = dr.KureReranker(encoder=enc, revision="test-rev")
    chunks = [_chunk(0, "영업이익 | 10", 9.0), _chunk(1, "매출액 | 20", 8.0),
              _chunk(2, "부채 | 5", 7.0), _chunk(3, "매출액 | 30", 6.0)]
    out = rr.rerank("매출액은 얼마인가?", chunks)
    assert [c["chunk_id"] for c in out] == ["c1", "c3", "c0", "c2"]      # 유사도 1인 둘은 BM25 순
    assert out[0]["score"] == pytest.approx(1.0) and out[2]["score"] == pytest.approx(0.0)
    m = out[0]["metadata"]
    assert m["bm25_score"] == 8.0 and m["bm25_rank"] == 2 and m["dense_score"] == pytest.approx(1.0)
    assert m["dense_rev"] == "test-rev" and m["corp_name"] == "HMM"      # 기존 metadata 보존
    assert enc.calls[0] == ["매출액은 얼마인가?"]                          # 질문 1회, 청크 1회
    assert len(enc.calls) == 2 and len(enc.calls[1]) == 4


def test_rerank_empty_and_single():
    rr = dr.KureReranker(encoder=FakeEncoder(), revision="r")
    assert rr.rerank("q", []) == []
    one = rr.rerank("매출액", [_chunk(0, "매출액", 1.0)])
    assert len(one) == 1 and one[0]["chunk_id"] == "c0"


def test_embed_text_uses_header_when_present():
    assert dr.chunk_embed_text({"header": "요약 손익", "text": "매출액 | 1"}) == "요약 손익\n매출액 | 1"
    assert dr.chunk_embed_text({"header": "", "text": " 매출액 "}) == "매출액"


def test_pins_and_default_revision(monkeypatch):
    monkeypatch.delenv("DART_QA_KURE_REVISION", raising=False)
    rr = dr.KureReranker(encoder=FakeEncoder())
    p = rr.pins()
    assert p["dense_model"] == dr.KURE_MODEL and p["dense_rev"] == dr.KURE_REVISION
    assert p["dense_pool"] == dr.DEFAULT_DENSE_POOL and p["dense_device"] == "injected"
    monkeypatch.setenv("DART_QA_KURE_REVISION", "env-rev")
    assert dr.KureReranker(encoder=FakeEncoder()).model_rev == "env-rev"


def test_embed_normalizes_rows():
    class Raw:
        def encode(self, texts, **kw):
            return np.array([[3.0, 4.0]] * len(texts))
    rr = dr.KureReranker(encoder=Raw(), revision="r")
    v = rr.embed(["a"])
    assert np.allclose(np.linalg.norm(v, axis=1), 1.0)
