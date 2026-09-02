"""B arm의 LOW 세그먼트 dense 재정렬 — KURE-v1(rev pin) cosine. v4 §8 "B만 LOW-confidence 시 KURE 재정렬".

무엇을 하나:
    BM25가 고른 후보 청크(dense_pool개)를 질문과의 KURE cosine 유사도로 다시 정렬한다.
    새 후보를 만들지 않는다(전량 dense 검색은 A arm의 몫). 원래 BM25 점수·순위는 metadata에 남긴다.

as-built 기록(vFINAL 7·15번): model·revision·device·dtype·dense_pool을 readiness().pins로 내보낸다.
CPU/MPS 어느 쪽이든 결과는 같아야 한다 — 정렬은 cosine 값의 순서만 쓴다(부동소수 차이로 동률이
갈릴 수 있어, 동률은 BM25 순위로 푼다).

이 파일은 검색 코어를 import하지 않는다. 입력·출력은 retriever_adapter.Chunk다.
"""
from __future__ import annotations

import os
from typing import Any, Sequence

import numpy as np

KURE_MODEL = "nlpai-lab/KURE-v1"
# v4 §1·§8: "KURE-v1 frozen rev 4ed4540…" — HF main 최신 커밋(2026-08-26). 가중치 자체는 0cb3681 업로드분.
KURE_REVISION = "4ed4540949c70b7da2c74004a915e1f2d5e46e4f"
DEFAULT_DENSE_POOL = 50        # BM25 후보 몇 개를 재정렬할지. Stage 1 k=50과 같다(as-built 기록 대상).
DEFAULT_BATCH = 16
DEFAULT_MAX_SEQ = 512          # BGE-M3 기본 8192는 청크(12줄 윈도)에 과하다. 실측: 20청크 18~28s → 제한 후 재측정.
SCORE_DECIMALS = 3             # MPS fp16 vs CPU fp32 차 ≤0.0003 → 소수 3자리에서 자르고 동률은 BM25 순위(기기 무관 재현).


def pick_device() -> str:
    env = os.environ.get("DART_QA_DEVICE")
    if env:
        return env
    try:
        import torch
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:  # noqa: BLE001 — torch 없으면 CPU 경로(테스트는 encoder 주입)
        pass
    return "cpu"


def chunk_embed_text(chunk: dict) -> str:
    header = (chunk.get("header") or "").strip()
    text = (chunk.get("text") or "").strip()
    return f"{header}\n{text}" if header else text


class KureReranker:
    """retriever_adapter.DenseReranker 구현. encoder를 주입하면 모델 없이 동작한다(테스트)."""

    def __init__(self, model_name: str = KURE_MODEL, revision: str | None = None, *,
                 device: str | None = None, batch_size: int = DEFAULT_BATCH,
                 dense_pool: int = DEFAULT_DENSE_POOL, max_seq_length: int = DEFAULT_MAX_SEQ,
                 encoder: Any | None = None):
        self.model_name = model_name
        self.max_seq_length = max_seq_length
        self.model_rev = revision or os.environ.get("DART_QA_KURE_REVISION") or KURE_REVISION
        self.device = device or ("injected" if encoder is not None else pick_device())
        self.batch_size = batch_size
        self.dense_pool = dense_pool
        self.dtype = "injected"
        self._encoder = encoder
        if encoder is None:
            self._encoder = self._load()

    def _load(self):
        import torch
        from sentence_transformers import SentenceTransformer
        # 8GB 기기 배려: MPS/CUDA에서는 fp16(약 1.1GB), CPU는 fp32.
        use_half = self.device in ("mps", "cuda")
        kwargs = {"torch_dtype": torch.float16} if use_half else {}
        model = SentenceTransformer(self.model_name, revision=self.model_rev, device=self.device,
                                    model_kwargs=kwargs)
        self.dtype = "float16" if use_half else "float32"
        model.max_seq_length = self.max_seq_length
        return model

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        vecs = self._encoder.encode(list(texts), batch_size=self.batch_size,
                                    normalize_embeddings=True, convert_to_numpy=True,
                                    show_progress_bar=False)
        arr = np.asarray(vecs, dtype=np.float32)
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return arr / norms

    def rerank(self, question: str, chunks: Sequence[dict]) -> list[dict]:
        chunks = list(chunks)
        if not chunks:
            return []
        q = self.embed([question])[0]
        c = self.embed([chunk_embed_text(ch) for ch in chunks])
        sims = c @ q
        # 동률은 BM25 순위(입력 순서)로 — 부동소수 차이에 흔들리지 않게 소수 6자리에서 자른다.
        order = sorted(range(len(chunks)), key=lambda i: (-round(float(sims[i]), SCORE_DECIMALS), i))
        out: list[dict] = []
        for i in order:
            ch = chunks[i]
            meta = dict(ch.get("metadata") or {})
            meta.update({"bm25_score": float(ch.get("score", 0.0)), "bm25_rank": i + 1,
                         "dense_score": float(sims[i]), "dense_model": self.model_name,
                         "dense_rev": self.model_rev})
            out.append({**ch, "score": float(sims[i]), "metadata": meta})
        return out

    def pins(self) -> dict[str, Any]:
        return {"dense_model": self.model_name, "dense_rev": self.model_rev,
                "dense_device": self.device, "dense_dtype": self.dtype,
                "dense_pool": self.dense_pool, "dense_batch": self.batch_size,
                "dense_max_seq_length": self.max_seq_length, "dense_score_decimals": SCORE_DECIMALS}


def build_kure_reranker(**kwargs: Any) -> KureReranker:
    """bind("B")가 부른다. 패키지·모델이 없으면 여기서 명확히 실패한다(조용한 D 대체 금지)."""
    try:
        import sentence_transformers  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(
            "arm B에는 sentence-transformers(+torch)와 KURE-v1 모델이 필요하다: "
            ".venv/bin/pip install torch sentence-transformers") from exc
    return KureReranker(**kwargs)
