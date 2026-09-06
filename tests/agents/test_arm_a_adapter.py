"""arm_a_adapter 계약 테스트 — Turn A-PLUS-QA-ADAPTER-ONLY-V1.

전부 손으로 만든 합성 fixture만 쓴다(실제 A.results.jsonl·실제 Gold 파일 미사용) — 이 turn은
DEV_TUNE 실행·Gold 열람·DEV_CHECK/HOLDOUT 접근을 하지 않는다는 원칙을 지킨다.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from dart_detective import arm_a_adapter as aa
from dart_detective.retriever_adapter import RetrieverAdapter

# ---------- 기존 B/D 경로 byte-invariance ----------
# 이 turn은 기존 QA 파일을 한 byte도 바꾸지 않는다. base commit(0c92abbe...)에서
# `git show <sha>:<path> | shasum -a 256`로 캡처한 해시와 대조한다.
_EXPECTED_UNCHANGED_FILE_SHA256 = {
    "src/dart_detective/retriever_adapter.py":
        "642a832fea9b508d8c6a2f377a4b8c91a320faea97f53e7ac5cc2474aa2f7f7d",
    # Turn A-PLUS-QA-LIVE-WIRING-V1이 answer_api.py만 고쳤다(retrieval_backend 선택·A 브리지 배선).
    # 기본 경로(DEFAULT) 동작 불변은 tests/agents/test_arm_a_serving_bridge.py의 회귀 테스트가 잠근다.
    "src/dart_detective/answer_api.py":
        "f9f12921662d4c9eef34d2b17553c45e549cf59340aac6a1ce30de7e992ba4a3",
    "src/dart_detective/agents/qa_agent.py":
        "43e055aafc93c06f346ced4484bb94dc821111abc4c5b8b8c93d9470355d7020",
    "src/dart_detective/agents/validator.py":
        "0fbc179e1f9251f8dd2965d33bd292fdd9e1d71bcc35ac6e239338b897ac6423",
    "src/dart_detective/corpus_retriever.py":
        "c64bc9b4011fac8862f80c9dd8f3b8510f28c16718b613b74bc76160b44fcc8a",
}


def test_existing_qa_files_byte_unchanged():
    repo_root = Path(__file__).resolve().parents[2]
    for rel_path, expected_sha in _EXPECTED_UNCHANGED_FILE_SHA256.items():
        actual = hashlib.sha256((repo_root / rel_path).read_bytes()).hexdigest()
        assert actual == expected_sha, f"{rel_path}가 base commit과 달라졌다(B/D 경로 불변 위반)"


# ---------- 합성 fixture 헬퍼 ----------

def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


SINGLE_NODE_TEXT = "단일 node 청크 본문입니다."
MULTI_NODE_TEXT = "다중 node 청크 본문입니다."

SINGLE_NODE_ITEM = {
    "rank": 1,
    "doc_id": "holding_20240403000410",
    "node_index": 5,
    "node_indices": [5],
    "locator": "holding_20240403000410::20240403000410.xml::n5",
    "row": None,
    "col": None,
    "chunk_id": "chunk_single_0001",
    "chunk_text_sha256": _sha256(SINGLE_NODE_TEXT),
    "score": 0.031,
    "score_type": "RRF",
}

MULTI_NODE_ITEM = {
    "rank": 2,
    "doc_id": "major_20240913000790",
    "node_index": 9,
    "node_indices": [9, 10, 11, 12],
    "locator": "major_20240913000790::20240913000790.xml::n9",
    "row": 0,
    "col": 0,
    "chunk_id": "chunk_multi_0002",
    "chunk_text_sha256": _sha256(MULTI_NODE_TEXT),
    "score": 0.021,
    "score_type": "RRF",
}


def _make_record(question_id: str, items: list[dict]) -> dict:
    return {
        "question_id": question_id,
        "arm": "A",
        "segment": "HIGH",
        "config_sha256": "config-sha-test",
        "code_sha256": "code-sha-test",
        "latency_ms": 123,
        "results": items,
    }


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


@pytest.fixture
def fixture_paths(tmp_path: Path):
    question = "테스트 질문입니다 — 단일/다중 node 변환 검증용?"
    question_id = "test_q_0001"
    results_path = tmp_path / "A.results.jsonl"
    gold_path = tmp_path / "gold.jsonl"
    _write_jsonl(results_path, [_make_record(question_id, [SINGLE_NODE_ITEM, MULTI_NODE_ITEM])])
    _write_jsonl(gold_path, [{"question_id": question_id, "question": question}])
    return {"results_path": results_path, "gold_path": gold_path, "question": question,
            "question_id": question_id}


def _text_resolver(known: dict[str, str]):
    def _resolve(*, doc_id, node_index, node_indices, chunk_id, chunk_text_sha256):
        del doc_id, node_index, node_indices, chunk_text_sha256
        return known[chunk_id]
    return _resolve


# ---------- 단일-node 변환 ----------

def test_single_node_result_converts_to_chunk_with_correct_locator_and_text():
    resolver = _text_resolver({"chunk_single_0001": SINGLE_NODE_TEXT})
    chunk = aa.build_chunk_from_result_item(SINGLE_NODE_ITEM, text_resolver=resolver)
    assert chunk["chunk_id"] == "chunk_single_0001"
    assert chunk["doc_id"] == "holding_20240403000410"
    assert chunk["node_index"] == 5
    assert chunk["locator"] == "holding_20240403000410/20240403000410.xml#node=5"
    assert chunk["text"] == SINGLE_NODE_TEXT
    assert chunk["doc_group"] == "holding"
    assert chunk["score"] == pytest.approx(0.031)
    assert chunk["metadata"]["provenance"]["node_indices"] == [5]


# ---------- 다중-node 후보 전체 보존 ----------

def test_multi_node_result_preserves_all_node_indices_not_collapsed_to_first():
    resolver = _text_resolver({"chunk_multi_0002": MULTI_NODE_TEXT})
    chunk = aa.build_chunk_from_result_item(MULTI_NODE_ITEM, text_resolver=resolver)
    assert chunk["node_index"] == 9  # A가 준 primary node 그대로
    assert chunk["metadata"]["provenance"]["node_indices"] == [9, 10, 11, 12]
    assert chunk["metadata"]["provenance"]["row"] == 0
    assert chunk["metadata"]["provenance"]["col"] == 0


# ---------- rank 순서 불변 ----------

def test_search_preserves_rank_order_even_if_file_order_is_shuffled(fixture_paths):
    shuffled = [MULTI_NODE_ITEM, SINGLE_NODE_ITEM]  # rank 2가 rank 1보다 먼저 오도록 저장
    _write_jsonl(fixture_paths["results_path"],
                 [_make_record(fixture_paths["question_id"], shuffled)])
    resolver = _text_resolver({
        "chunk_single_0001": SINGLE_NODE_TEXT,
        "chunk_multi_0002": MULTI_NODE_TEXT,
    })
    retriever = aa.ArmAFrozenResultsRetriever(
        results_path=fixture_paths["results_path"],
        gold_questions_path=fixture_paths["gold_path"],
        text_resolver=resolver,
    )
    chunks = retriever.search(fixture_paths["question"])
    assert [c["metadata"]["provenance"]["rank"] for c in chunks] == [1, 2]
    assert [c["chunk_id"] for c in chunks] == ["chunk_single_0001", "chunk_multi_0002"]


# ---------- k가 보유량보다 작을 때: 절단이지 은닉 필터가 아님 ----------

def test_search_k_smaller_than_available_returns_exact_top_k_by_rank(fixture_paths):
    resolver = _text_resolver({
        "chunk_single_0001": SINGLE_NODE_TEXT,
        "chunk_multi_0002": MULTI_NODE_TEXT,
    })
    retriever = aa.ArmAFrozenResultsRetriever(
        results_path=fixture_paths["results_path"],
        gold_questions_path=fixture_paths["gold_path"],
        text_resolver=resolver,
    )
    chunks = retriever.search(fixture_paths["question"], k=1)
    assert len(chunks) == 1
    assert chunks[0]["chunk_id"] == "chunk_single_0001"


# ---------- text 누락 시 fail-closed ----------

def test_missing_text_resolver_raises_instead_of_empty_string():
    with pytest.raises(aa.TextResolutionRequiredError):
        aa.build_chunk_from_result_item(SINGLE_NODE_ITEM, text_resolver=None)


def test_resolver_returning_empty_string_raises():
    resolver = _text_resolver({"chunk_single_0001": ""})
    with pytest.raises(aa.TextResolutionRequiredError):
        aa.build_chunk_from_result_item(SINGLE_NODE_ITEM, text_resolver=resolver)


# ---------- text integrity: sha256 불일치 시 fail-closed ----------

def test_resolver_text_with_wrong_sha256_raises():
    resolver = _text_resolver({"chunk_single_0001": "이건 다른 텍스트다"})
    with pytest.raises(aa.TextIntegrityMismatchError):
        aa.build_chunk_from_result_item(SINGLE_NODE_ITEM, text_resolver=resolver)


# ---------- 잘못된 필드 형식 거부 ----------

@pytest.mark.parametrize("broken_item", [
    {**SINGLE_NODE_ITEM, "node_index": "5"},          # 문자열 — int 아님
    {**SINGLE_NODE_ITEM, "rank": "1"},                 # 문자열 — int 아님
    {**SINGLE_NODE_ITEM, "node_indices": ["5", "6"]},  # 문자열 리스트
    {k: v for k, v in SINGLE_NODE_ITEM.items() if k != "chunk_text_sha256"},  # 필드 누락
])
def test_malformed_result_item_is_rejected(broken_item):
    resolver = _text_resolver({"chunk_single_0001": SINGLE_NODE_TEXT})
    with pytest.raises(aa.MalformedArmAResultError):
        aa.build_chunk_from_result_item(broken_item, text_resolver=resolver)


# ---------- 알 수 없는 질문 ----------

def test_unknown_question_raises(fixture_paths):
    resolver = _text_resolver({
        "chunk_single_0001": SINGLE_NODE_TEXT,
        "chunk_multi_0002": MULTI_NODE_TEXT,
    })
    retriever = aa.ArmAFrozenResultsRetriever(
        results_path=fixture_paths["results_path"],
        gold_questions_path=fixture_paths["gold_path"],
        text_resolver=resolver,
    )
    with pytest.raises(aa.UnknownQuestionForFrozenArmAError):
        retriever.search("이 질문은 gold 101문항에 없다")


# ---------- Protocol 구조 적합성 + readiness ----------

def test_retriever_satisfies_retriever_adapter_protocol(fixture_paths):
    resolver = _text_resolver({
        "chunk_single_0001": SINGLE_NODE_TEXT,
        "chunk_multi_0002": MULTI_NODE_TEXT,
    })
    retriever = aa.ArmAFrozenResultsRetriever(
        results_path=fixture_paths["results_path"],
        gold_questions_path=fixture_paths["gold_path"],
        text_resolver=resolver,
    )
    assert isinstance(retriever, RetrieverAdapter)
    assert retriever.arm == "A"
    readiness = retriever.readiness()
    assert readiness["ready"] is True
    assert readiness["text_resolver_configured"] is True


def test_readiness_not_ready_without_text_resolver(fixture_paths):
    retriever = aa.ArmAFrozenResultsRetriever(
        results_path=fixture_paths["results_path"],
        gold_questions_path=fixture_paths["gold_path"],
        text_resolver=None,
    )
    assert retriever.readiness()["ready"] is False


# ---------- build_retriever_for_arm: DI 셀렉터, 기본값 불변 ----------

def test_build_retriever_for_arm_requires_results_path_for_arm_a():
    with pytest.raises(aa.ArmAAdapterError):
        aa.build_retriever_for_arm("A")


def test_build_retriever_for_arm_builds_arm_a_retriever(fixture_paths):
    resolver = _text_resolver({
        "chunk_single_0001": SINGLE_NODE_TEXT,
        "chunk_multi_0002": MULTI_NODE_TEXT,
    })
    retriever = aa.build_retriever_for_arm(
        "A",
        arm_a_results_path=fixture_paths["results_path"],
        arm_a_gold_questions_path=fixture_paths["gold_path"],
        arm_a_text_resolver=resolver,
    )
    assert isinstance(retriever, aa.ArmAFrozenResultsRetriever)


def test_build_retriever_for_arm_delegates_non_a_arms_to_existing_bind(monkeypatch):
    calls = []

    def _fake_bind(arm=None, **kwargs):
        calls.append((arm, kwargs))
        return "SENTINEL_FROM_EXISTING_BIND"

    monkeypatch.setattr(aa, "bind", _fake_bind)
    result = aa.build_retriever_for_arm("D")
    assert result == "SENTINEL_FROM_EXISTING_BIND"
    assert calls == [("D", {})]
