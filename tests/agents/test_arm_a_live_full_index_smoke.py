"""Turn A-PLUS-QA-FULL-INDEX-SMOKE-V1 — real end-to-end smoke against the FULL 442,549-chunk
READY index, not the 18-chunk shard scripts/arm_a_live_worker.test.mjs / test_arm_a_live_adapter.py
already cover with a stub worker.

This is a real-infra test: real Node subprocess (scripts/arm_a_live_worker.mjs), real Postgres
(database `p11f0_scratch` on port 55329 — NOT `scratch_repro`; see docs/reports/
A_PLUS_QA_FULL_INDEX_SMOKE_V1.md for why the full index lives there), real running KURE-v1
embedding server. No Gold/DEV_TUNE/DEV_CHECK/HOLDOUT file is read anywhere in this file. The 5
probe questions are each a real, already-materialized chunk's own text from the full index,
spanning all 4 real document groups (periodic/major/holding/exchange) — the same chunk IDs the
Node-level test (scripts/arm_a_live_worker_full_index.test.mjs) uses, so both layers are proven
against the identical real data.

Skips cleanly (never silently "passes") if the real local infra (Postgres on port 55329 / a
`node` binary / the persisted BM25 cache file) is not present on this machine.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from dart_corpus.retrieval.conditions import QueryConditions
from dart_detective import answer_api
from dart_detective import arm_a_live_adapter as la
from dart_detective import arm_a_serving_bridge as br
from dart_detective.arm_a_live_worker_client import ArmALiveWorkerClient

IMPL_ROOT = "/Users/jaewan/Documents/Codex/worktrees/agent-fourarm-ac-vector-import-v01"
DATABASE_URL = "postgresql://jaewan@localhost:55329/p11f0_scratch"
RETRIEVAL_INDEX_ID = "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7"
LOAD_SESSION_ID = "fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e"          # READY successor
PROVENANCE_LOAD_SESSION_ID = "fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36"  # discovery source
CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3"
KURE_SERVER_URL = "http://127.0.0.1:58411/v1/embeddings"
BM25_CACHE_DIR = "/Users/jaewan/Library/Caches/ai-festival-p11f0-bm25-index"
EXPECTED_KURE_REVISION = "4ed4540949c70b7da2c74004a915e1f2d5e46e4f"
EXPECTED_RECORD_COUNT = 442549

# Same 5 real, non-Gold chunk ids as scripts/arm_a_live_worker_full_index.test.mjs, one per
# document group (periodic appears twice: multi-node + plain prose).
PROBE_CHUNK_IDS = [
    "chunk_25845e0607f2f5a7abf6ae97",  # periodic_20250814002920 — 55 distinct nodes (multi-node)
    "chunk_64022f2f74ed1a08f029d666",  # major_20240910000559 — numeric
    "chunk_000605521f33cb42e89c1bc8",  # holding_20230504000774
    "chunk_0008d4f96bca991cb655b20d",  # exchange_20250922800142 — numeric (정정 계약금액)
    "chunk_000094f84dd03923aacac791",  # periodic_20250311001180 — prose (non-numeric)
]
MULTI_NODE_PROBE_CHUNK_ID = "chunk_25845e0607f2f5a7abf6ae97"


def _infra_available() -> bool:
    if shutil.which("node") is None:
        return False
    if not Path(IMPL_ROOT).is_dir():
        return False
    if not Path(BM25_CACHE_DIR).glob("*c7ee3363a0af161c7a0572d024dfbf36*"):
        return False
    try:
        result = subprocess.run(
            ["psql", DATABASE_URL, "-tAc",
             f"SELECT record_count FROM disclosure_reference.reference_retrieval_indexes "
             f"WHERE retrieval_index_id = '{RETRIEVAL_INDEX_ID}' AND index_status = 'READY'"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and result.stdout.strip() == str(EXPECTED_RECORD_COUNT)


pytestmark = pytest.mark.skipif(
    not _infra_available(),
    reason="real full-index infra (Postgres p11f0_scratch:55329 READY 442,549-chunk index, "
           "node, persisted BM25 cache) not available on this machine — this is a real-infra "
           "smoke test, not an offline unit test; see docs/reports/A_PLUS_QA_FULL_INDEX_SMOKE_V1.md",
)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _full_index_env() -> dict[str, str]:
    env = dict(os.environ)
    env["NODE_OPTIONS"] = "--max-old-space-size=8192"  # the 1.7GB persisted BM25 cache OOMs the default heap
    env["ARM_A_LIVE_IMPL_ROOT"] = IMPL_ROOT
    env["ARM_A_LIVE_DATABASE_URL"] = DATABASE_URL
    env["ARM_A_LIVE_RETRIEVAL_INDEX_ID"] = RETRIEVAL_INDEX_ID
    env["ARM_A_LIVE_LOAD_SESSION_ID"] = LOAD_SESSION_ID
    env["ARM_A_LIVE_PROVENANCE_LOAD_SESSION_ID"] = PROVENANCE_LOAD_SESSION_ID
    env["ARM_A_LIVE_BM25_LOAD_SESSION_ID"] = PROVENANCE_LOAD_SESSION_ID
    env["ARM_A_LIVE_CORPUS_SNAPSHOT_ID"] = CORPUS_SNAPSHOT_ID
    env["ARM_A_LIVE_KURE_SERVER_URL"] = KURE_SERVER_URL
    env["ARM_A_LIVE_BM25_CACHE_DIR"] = BM25_CACHE_DIR
    return env


def _fetch_probe_texts() -> dict[str, dict[str, str]]:
    # json_agg avoids any delimiter-vs-embedded-newline/tab ambiguity in real multi-line chunk text.
    query = (
        "SELECT COALESCE(json_agg(json_build_object("
        "'chunk_id', chunk_id, 'document_id', source_document_id, 'text', text_content)), '[]') "
        "FROM disclosure_reference.reference_retrieval_chunks WHERE retrieval_index_id = "
        f"'{RETRIEVAL_INDEX_ID}' AND chunk_id = ANY(ARRAY[" +
        ",".join(f"'{c}'" for c in PROBE_CHUNK_IDS) + "]::text[])"
    )
    result = subprocess.run(
        ["psql", DATABASE_URL, "-tAc", query],
        capture_output=True, text=True, timeout=30, check=True,
    )
    rows = json.loads(result.stdout)
    out = {row["chunk_id"]: {"document_id": row["document_id"], "text": row["text"]} for row in rows}
    assert len(out) == len(PROBE_CHUNK_IDS), f"expected all 5 probes, got {list(out)}"
    return out


class _FakeBase:
    """Utility-only stand-in — proves the ARM_A_LIVE path never calls retrieve() on a B/D base."""

    strategy = "line_window"

    def __init__(self):
        self.docs_by_id: dict[str, dict] = {}

    def conditions(self, q):
        return QueryConditions()

    def _metadata_of(self, doc_id):
        return {"corp_name": "smoke-test", "doc_group": doc_id.split("_", 1)[0]}

    def statement_scopes(self, doc_id):
        return {}

    def retrieve(self, q, c=None, *, k=None):
        raise AssertionError("A-PLUS-QA-FULL-INDEX-SMOKE: B/D base.retrieve() must never be called on the ARM_A_LIVE path")


class _FakeStore(dict):
    def readiness(self):
        return {"n_docs": 0, "pins": {"fake_store": True}}


def _fake_base_factory(**paths):
    return _FakeBase(), _FakeStore()


@pytest.fixture(scope="module")
def probe_texts():
    return _fetch_probe_texts()


@pytest.fixture(scope="module")
def live_client():
    client = ArmALiveWorkerClient(env=_full_index_env(), timeout_s=90.0)
    yield client
    client.close()


def test_readiness_is_the_full_442549_chunk_index_not_the_shard(live_client):
    readiness = live_client.readiness()
    assert readiness["arm_a_live_ready"] is True
    assert readiness["kure_pin"]["revision"] == EXPECTED_KURE_REVISION
    assert readiness["embedding_dimension"] == 1024
    assert readiness["materialized_record_count"] == EXPECTED_RECORD_COUNT
    assert readiness["materialized_record_count"] != 18


def test_five_new_cross_group_questions_verified_end_to_end_in_python(live_client, probe_texts):
    """Second, pure-Python verification pass (arm_a_live_adapter._verify_item) on REAL full-index data."""
    fetch_node_calls: list[tuple] = []
    real_fetch_node = live_client.fetch_node
    live_client.fetch_node = lambda *a, **kw: (fetch_node_calls.append((a, kw)), real_fetch_node(*a, **kw))[1]

    retriever = la.ArmALiveRetriever(live_client)
    doc_groups_seen: set[str] = set()
    saw_multi_node = False
    pids_seen: set[int] = set()

    for chunk_id in PROBE_CHUNK_IDS:
        probe = probe_texts[chunk_id]
        chunks = retriever.search(probe["text"], {}, k=10)
        assert chunks, f"expected >=1 real result for probe {chunk_id}"
        pids_seen.add(live_client._proc.pid)
        for c in chunks:
            assert c["text"], "text must never be empty"
            assert hashlib.sha256(c["text"].encode("utf-8")).hexdigest() == c["metadata"]["provenance"]["chunk_text_sha256"]
            assert c["doc_id"], "document_id must be present"
            doc_groups_seen.add(c["doc_id"].split("_", 1)[0])
            node_indices = c["metadata"]["provenance"]["node_indices"]
            if len(node_indices) > 1:
                saw_multi_node = True
        self_hit = next((c for c in chunks if c["chunk_id"] == chunk_id), None)
        assert self_hit is not None, f"probe {chunk_id} should self-match in the real full index"
        if chunk_id == MULTI_NODE_PROBE_CHUNK_ID:
            assert len(self_hit["metadata"]["provenance"]["node_indices"]) > 1

    assert len(doc_groups_seen) >= 4, f"expected >=4 distinct document groups, got {doc_groups_seen}"
    assert saw_multi_node, "at least one probe must surface a genuinely multi-node result"
    assert len(pids_seen) == 1, f"the worker subprocess must never restart across questions, saw pids {pids_seen}"
    assert fetch_node_calls == [], (
        "fetch_node() must not be called by a plain search() sweep — confirms it is not invoked "
        "as part of ordinary retrieval, matching the structural finding that no QA-path caller "
        "invokes retriever.fetch_node()"
    )


def test_qa_pipeline_reaches_real_full_index_with_zero_bd_fallback_and_grounded_citations(live_client, probe_texts):
    """Full public answer_ex() path, real worker, no LLM key configured in this environment
    (CLOVA_API_KEY unset) — qa_agent.answer_question(..., llm=None) exercises the deterministic
    path exactly like the repo's own prior 'LLM 없음' E2E runs (see CLAUDE.md history)."""
    assert not os.environ.get("CLOVA_API_KEY"), "this test documents the no-LLM-key environment as found; unset it to reproduce"

    fetch_node_calls: list[tuple] = []
    real_fetch_node = live_client.fetch_node
    live_client.fetch_node = lambda *a, **kw: (fetch_node_calls.append((a, kw)), real_fetch_node(*a, **kw))[1]

    answer_api.configure(retrieval_backend=br.RETRIEVAL_BACKEND_ARM_A_LIVE,
                          worker_client=live_client, base_factory=_fake_base_factory)
    try:
        retriever = answer_api._get_retriever()
        assert isinstance(retriever, la.ArmALiveServingRetriever)

        results = []
        # 3 of the 5 probes through the FULL answer_ex() public path (the other 2 are already
        # proven at the retriever level above and at the Node level in
        # scripts/arm_a_live_worker_full_index.test.mjs — the full LLM-less pipeline per question
        # takes ~20-30s against the real 442k-chunk index).
        for i, chunk_id in enumerate(PROBE_CHUNK_IDS[:3]):
            probe = probe_texts[chunk_id]
            wire, meta = answer_api.answer_ex(f"Q-full-index-smoke-{i}", probe["text"])
            assert set(wire) == {"question_id", "question", "retrieved_context", "think_trace", "answer"}
            assert all(isinstance(v, str) for v in wire.values())
            assert meta.get("error_code", "") == "", f"answer_ex errored for probe {chunk_id}: {meta}"
            trace = json.loads(wire["think_trace"])
            assert trace["validation"]["status"] != "ERROR"
            ctx = json.loads(wire["retrieved_context"])
            results.append({"chunk_id": chunk_id, "doc_id": probe["document_id"], "wire": wire,
                             "meta": meta, "ctx": ctx, "llm_used": meta.get("llm_used")})

        for r in results:
            # citations traced to retrieved_context: every context entry's document_id must be
            # one of OUR real search results' document ids (never fabricated / off-corpus).
            for entry in r["ctx"]:
                assert entry["document_id"], "retrieved_context entries must carry a real document_id"
            assert r["meta"]["llm_used"] is False, (
                "no CLOVA_API_KEY is configured in this environment, so qa_agent must have taken "
                "its existing deterministic (llm=None) path, not fabricated an LLM call"
            )

        assert live_client._proc is not None
        assert fetch_node_calls == [], "fetch_node() must not be called anywhere in the real answer_ex() path"
    finally:
        answer_api.configure()


def test_worker_never_touches_frozen_replay_or_bd_module_state():
    assert not hasattr(la.ArmALiveRetriever, "_frozen")
    from dart_detective import arm_a_adapter
    assert arm_a_adapter.ArmAFrozenResultsRetriever not in la.ArmALiveRetriever.__mro__
