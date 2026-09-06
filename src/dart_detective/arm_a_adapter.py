"""arm_a_adapter — frozen Arm A 검색 결과를 retriever_adapter.RetrieverAdapter Protocol로 노출한다.

Turn A-PLUS-QA-ADAPTER-ONLY-V1. Arm A(hybrid BM25+dense+RRF, codex/fourarm-ac-vector-import-v01
@ 44f0523)의 frozen 결과 파일(A.results.jsonl, codex/fourarm-a2-integration-v01 @ 900d3cc, 별개
git 히스토리)을 재실행 없이 재생(replay)해 search/fetch_node/readiness 세 함수로 돌려준다
(retriever_adapter.py 상단 docstring, interfaces.md §3의 "유일한 문" 계약).

원칙:
  - A의 rank·score를 바꾸지 않는다. 새 검색·임베딩·재정렬을 실행하지 않는다.
  - 후보를 추가·제거·재정렬하지 않는다. node_indices 전체를 보존한다(첫 node로 축소 금지).
  - A에 없는 필드는 추측하지 않는다 — 없으면 명시적으로 비우거나 fail-closed 오류를 낸다.
  - retriever_adapter.py 등 기존 QA 파일은 import만 하고 절대 수정하지 않는다.

범위 밖(다음 작업자 몫 — docs/reports/arm_a_adapter_handoff.md 참고):
  - 실제 DocumentIR 기반 TextResolver 구현. 지금은 호출자가 주입해야 하며, 없으면 매 chunk에서
    TextResolutionRequiredError로 멈춘다(빈 문자열을 본문처럼 돌려주지 않는다).
  - build_serving_retriever()/answer_api._get_retriever()가 실제로 이 어댑터를 타도록 배선하는 것.
    build_serving_retriever()는 CorpusRetriever 모양(conditions/retrieve/docs_by_id/
    statement_scopes)의 별도 서빙 전용 경로이고, bind()가 돌려주는 RetrieverAdapter Protocol과
    모양이 다르다 — 이 어댑터는 문서화된 Protocol(bind()의 결과 모양)만 구현한다.
  - judge34/101문항 실행, 안전성·성능 판정, winner 선언.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Mapping, Protocol, runtime_checkable

from .retriever_adapter import ARM_LABELS, Chunk, Node, RetrieverAdapter, bind, locator_of

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GOLD_QUESTIONS_PATH = REPO_ROOT / "data" / "eval" / "phase1_devtune_gold.v0.1.jsonl"

ARM_A_ADAPTER_VERSION = "arm-a.qa-retriever-adapter.v1"


class ArmAAdapterError(Exception):
    """이 어댑터가 내는 모든 오류의 공통 베이스."""


class TextResolutionRequiredError(ArmAAdapterError):
    """A.results.jsonl에는 본문(text)이 없다 — text_resolver 없이는 여기서 멈춘다."""


class TextIntegrityMismatchError(ArmAAdapterError):
    """resolver가 돌려준 text의 sha256이 A의 chunk_text_sha256과 다르다 — 신뢰하지 않는다."""


class MalformedArmAResultError(ArmAAdapterError):
    """A.results.jsonl의 레코드/항목이 기대한 필드·타입을 갖추지 못했다."""


class UnknownQuestionForFrozenArmAError(ArmAAdapterError):
    """이 question 텍스트가 frozen A 실행이 대상으로 한 101문항 Gold 집합에 없다."""


@runtime_checkable
class TextResolver(Protocol):
    """호출자가 주입하는 read-only 본문 조회 인터페이스. 새 검색이 아니라 이미 아는
    (doc_id, node_index)의 원문을 돌려주는 것뿐이다. 실패 시 예외를 내야 한다(빈 문자열 금지)."""

    def __call__(self, *, doc_id: str, node_index: int, node_indices: list[int],
                 chunk_id: str, chunk_text_sha256: str) -> str: ...


def doc_group_of(doc_id: str) -> str:
    """doc_id의 첫 '_' 앞부분. retriever_adapter.chunk_from_retrieved의 fallback 규칙과 동일."""
    return doc_id.split("_", 1)[0]


def _require(item: Mapping[str, Any], field: str, types: Any) -> Any:
    if field not in item:
        raise MalformedArmAResultError(f"A result item에 '{field}' 필드가 없다: {item!r}")
    value = item[field]
    if isinstance(value, bool) or not isinstance(value, types):
        raise MalformedArmAResultError(
            f"A result item의 '{field}'가 기대한 타입이 아니다 (got {type(value).__name__}): {item!r}")
    return value


def _verify_text_integrity(text: str, expected_sha256: str, *, chunk_id: str) -> None:
    actual = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if actual != expected_sha256:
        raise TextIntegrityMismatchError(
            f"chunk_id={chunk_id}: resolver text sha256({actual})이 "
            f"chunk_text_sha256({expected_sha256})과 다르다 — 신뢰하지 않는다")


def build_chunk_from_result_item(item: Mapping[str, Any], *,
                                  text_resolver: TextResolver | None,
                                  record_context: Mapping[str, Any] | None = None) -> Chunk:
    """A.results.jsonl의 한 result 항목을 QA의 Chunk TypedDict로 변환한다.

    rank/score/doc_id/chunk_id/node_index는 A값 그대로(passthrough). locator는
    retriever_adapter.locator_of(doc_id, node_index)로 재포맷한다 — 같은 (doc_id, node_index)
    identity를 B/D와 같은 문자열 규약으로 다시 쓰는 것뿐, 새 사실을 만들지 않는다. text는
    text_resolver가 없으면 TextResolutionRequiredError, 있으면 호출 후 chunk_text_sha256과
    대조한다(불일치 시 TextIntegrityMismatchError) — 빈 문자열이나 미검증 텍스트를 절대
    돌려주지 않는다. header/section_path는 A에 없는 정보이므로 "" / [] 로 둔다(추측 금지).
    metadata['provenance']에 node_indices 전체·chunk_text_sha256·score_type·rank·row/col과
    (있다면) question_id/arm/segment/config_sha256/code_sha256을 보존한다.
    """
    rank = _require(item, "rank", int)
    doc_id = _require(item, "doc_id", str)
    node_index = _require(item, "node_index", int)
    chunk_id = _require(item, "chunk_id", str)
    chunk_text_sha256 = _require(item, "chunk_text_sha256", str)
    score = _require(item, "score", (int, float))

    node_indices_raw = item.get("node_indices")
    if node_indices_raw is None:
        node_indices = [node_index]
    elif isinstance(node_indices_raw, list) and all(
        isinstance(n, int) and not isinstance(n, bool) for n in node_indices_raw
    ):
        node_indices = list(node_indices_raw)
    else:
        raise MalformedArmAResultError(
            f"A result item의 'node_indices'가 int 리스트가 아니다: {item!r}")

    if text_resolver is None:
        raise TextResolutionRequiredError(
            f"chunk_id={chunk_id}: text_resolver가 주입되지 않았다 — A.results.jsonl에는 본문이 없다")
    text = text_resolver(doc_id=doc_id, node_index=node_index, node_indices=node_indices,
                          chunk_id=chunk_id, chunk_text_sha256=chunk_text_sha256)
    if not isinstance(text, str) or text == "":
        raise TextResolutionRequiredError(
            f"chunk_id={chunk_id}: text_resolver가 빈 값을 돌려줬다 — fail-closed")
    _verify_text_integrity(text, chunk_text_sha256, chunk_id=chunk_id)

    provenance: dict[str, Any] = {
        "node_indices": node_indices,
        "chunk_text_sha256": chunk_text_sha256,
        "score_type": item.get("score_type"),
        "rank": rank,
        "row": item.get("row"),
        "col": item.get("col"),
    }
    for key in ("question_id", "arm", "segment", "config_sha256", "code_sha256"):
        if record_context and key in record_context:
            provenance[key] = record_context[key]

    return Chunk(
        chunk_id=chunk_id,
        doc_id=doc_id,
        node_index=node_index,
        locator=locator_of(doc_id, node_index),
        text=text,
        header="",
        section_path=[],
        doc_group=doc_group_of(doc_id),
        score=float(score),
        metadata={"provenance": provenance},
    )


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    records = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


class ArmAFrozenResultsRetriever:
    """RetrieverAdapter Protocol 구현 — Arm A의 frozen A.results.jsonl을 재생(replay)한다.

    새 검색을 하지 않는다. 이미 A가 만든 top-k 결과를 question_id로 찾아 그대로 돌려줄 뿐이다.
    search()는 free-text question을 받지만 A는 question_id로 색인돼 있으므로, 이 어댑터가
    대상으로 하는 고정 101문항 Gold 파일(gold_questions_path)로 question -> question_id를
    역색인한다. Gold에 없는 질문은 UnknownQuestionForFrozenArmAError로 fail-closed한다
    (임의의 새 질문에 대한 라이브 검색이 아니므로 추측하지 않는다).
    """

    arm = "A"

    def __init__(self, results_path: str | os.PathLike,
                 gold_questions_path: str | os.PathLike | None = None,
                 text_resolver: TextResolver | None = None):
        self.results_path = Path(results_path)
        self.gold_questions_path = (
            Path(gold_questions_path) if gold_questions_path else DEFAULT_GOLD_QUESTIONS_PATH
        )
        self.text_resolver = text_resolver

        self._records_by_qid: dict[str, dict[str, Any]] = {}
        for record in _load_jsonl(self.results_path):
            qid = record.get("question_id")
            if not qid:
                raise MalformedArmAResultError(
                    f"A.results.jsonl 레코드에 question_id가 없다: {record!r}")
            self._records_by_qid[qid] = record

        self._qid_by_question_text: dict[str, str] = {}
        for gold_row in _load_jsonl(self.gold_questions_path):
            question = gold_row.get("question")
            qid = gold_row.get("question_id")
            if question and qid:
                self._qid_by_question_text[question] = qid

    def _resolve_question_id(self, question: str) -> str:
        qid = self._qid_by_question_text.get(question)
        if qid is None:
            raise UnknownQuestionForFrozenArmAError(
                f"question이 frozen Arm A gold 집합(101문항)에 없다: {question!r}")
        if qid not in self._records_by_qid:
            raise UnknownQuestionForFrozenArmAError(
                f"question_id={qid}가 A.results.jsonl에 없다 (question={question!r})")
        return qid

    def search(self, question: str, conditions: Mapping[str, Any] | None = None,
               k: int = 20) -> list[Chunk]:
        # conditions는 Protocol 서명을 맞추기 위해 받되 사용하지 않는다 — frozen 재생이므로
        # 실시간 조건 재필터링을 하지 않는다("새 검색을 실행하지 않는다" 원칙).
        del conditions
        qid = self._resolve_question_id(question)
        record = self._records_by_qid[qid]
        items = record.get("results")
        if not isinstance(items, list):
            raise MalformedArmAResultError(f"question_id={qid}의 'results'가 리스트가 아니다")
        # rank로 정렬해 A가 매긴 순서를 보증한다(파일 내 물리적 순서에 기대지 않는다).
        ordered = sorted(items, key=lambda it: _require(it, "rank", int))
        record_context = {
            key: record[key]
            for key in ("question_id", "arm", "segment", "config_sha256", "code_sha256")
            if key in record
        }
        chunks = [
            build_chunk_from_result_item(it, text_resolver=self.text_resolver,
                                          record_context=record_context)
            for it in ordered
        ]
        # k가 보유 후보보다 작을 때만 자른다 — 이는 호출자가 명시적으로 요청한 절단이지,
        # 어댑터가 임의로 후보를 제거하는 것이 아니다.
        return chunks[:k]

    def fetch_node(self, doc_id: str, node_index: int) -> Node:
        # 알려진 한계(handoff 참고): 실제 DocumentIR node-store가 아직 배선되지 않아
        # kind/section_path는 채우지 못한다 — 추측하지 않고 빈 값으로 둔다.
        if self.text_resolver is None:
            raise TextResolutionRequiredError(
                f"fetch_node({doc_id}, {node_index}): text_resolver가 주입되지 않았다")
        text = self.text_resolver(doc_id=doc_id, node_index=node_index, node_indices=[node_index],
                                   chunk_id="", chunk_text_sha256="")
        if not isinstance(text, str) or text == "":
            raise TextResolutionRequiredError(
                f"fetch_node({doc_id}, {node_index}): text_resolver가 빈 값을 돌려줬다")
        return Node(doc_id=doc_id, node_index=node_index, kind="", section_path=[],
                    lines=text.splitlines(), text=text)

    def readiness(self) -> dict[str, Any]:
        return {
            "arm": self.arm,
            "label": ARM_LABELS.get(self.arm, "FIXED+FULL_DENSE"),
            "ready": bool(self._records_by_qid) and self.text_resolver is not None,
            "mode": "frozen_replay",
            "n_questions_loaded": len(self._records_by_qid),
            "n_gold_questions_indexed": len(self._qid_by_question_text),
            "text_resolver_configured": self.text_resolver is not None,
            "external_services": [],
        }


def build_retriever_for_arm(arm: str | None = None,
                             *, arm_a_results_path: str | os.PathLike | None = None,
                             arm_a_gold_questions_path: str | os.PathLike | None = None,
                             arm_a_text_resolver: TextResolver | None = None,
                             **bind_kwargs: Any) -> RetrieverAdapter:
    """DART_QA_ARM(또는 인자)로 RetrieverAdapter를 고른다.

    retriever_adapter.bind()와 같은 선택 규칙(env DART_QA_ARM, 기본 D)을 따르되, arm이 "A"일
    때만 이 어댑터로 가로챈다. 그 외(B/C/D)는 기존 retriever_adapter.bind()를 수정 없이
    그대로 호출한다 — 기존 B/D 경로는 이 함수를 거쳐도 완전히 그대로다.
    """
    resolved_arm = (arm or os.environ.get("DART_QA_ARM") or "D").upper()
    if resolved_arm != "A":
        return bind(arm, **bind_kwargs)

    results_path = arm_a_results_path or os.environ.get("ARM_A_RESULTS_PATH")
    if not results_path:
        raise ArmAAdapterError(
            "arm=A는 results_path(또는 ARM_A_RESULTS_PATH env)가 필요하다 — A.results.jsonl은 "
            "이 저장소 밖(별개 git 히스토리)에 있어 기본 경로를 추정하지 않는다"
        )
    gold_path = arm_a_gold_questions_path or os.environ.get("ARM_A_GOLD_QUESTIONS_PATH")
    return ArmAFrozenResultsRetriever(
        results_path=results_path,
        gold_questions_path=gold_path,
        text_resolver=arm_a_text_resolver,
    )
