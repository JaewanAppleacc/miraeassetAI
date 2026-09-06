"""QA-side evidence adaptation for Arm A's fixed 512-token windows.

Arm A (and the frozen A4/A3 pipeline) owns retrieval rank. This module never
searches for another document and never calls DB/KURE/LLM — it only restores
DocumentIR node/row structure that the fixed-window representation omits, then
exposes small node/row evidence units to the existing QA selectors.

This rewrite (node-row-v2) replaces an earlier attempt (ef6925d, never merged)
that dropped evidence scores in production. The earlier version used an "exact
label" match as a *filter* that discarded every sibling row once one exact hit
appeared, capped children at a hardcoded 4 regardless of how many items the
question asked for, and computed `source_row_index` by counting only lines
that contained "|" — which silently collapses two different pipe-less rows
(e.g. two prose cells) onto the same locator and makes the cross-parent
dedup step below delete one of them. All three are fixed here generally
(not just for the cases that happened to be observed), see the docstring on
`normalize_arm_a_evidence`.
"""
from __future__ import annotations

import re
from dataclasses import replace
from itertools import zip_longest
from typing import Any, Mapping, Sequence

from dart_corpus.retrieval.chunk_index import infer_metrics, normalize_row_label, row_label_of
from dart_corpus.retrieval.lexical import tokenize

from .corpus_retriever import RetrievedChunk, extract_disclosure_items

ARM_A_EVIDENCE_NORMALIZATION = "node-row-v2"

# 요구 항목이 없을 때의 기본 여유(옛 고정값 4와 동일 — 기본 경로 회귀 없음).
DEFAULT_MIN_CHILDREN = 4
# 요구 항목 하나당 자리 하나(exact) + sibling 하나(반복/문맥) 여유.
CHILDREN_PER_REQUESTED_ITEM = 2
# 전체 안전 상한 — 요구 항목이 아무리 많아도 이 값을 넘지 않는다.
GLOBAL_MAX_CHILDREN_PER_PARENT = 12

_HEADER_LABELS = frozenset({"구분", "항목", "과목", "내용", "구성", "분류"})
_HEADER_HINT_RE = re.compile(r"(?:20\d{2}\s*년|제\s*\d+\s*기|당기|전기|전년|기준일)")
_UNIT_RE = re.compile(r"단위\s*[:：]")
_SOFT_LABEL_SEP_RE = re.compile(r"[:：]")
_SOFT_LABEL_MAX_LEN = 20


def _node_of(doc: Mapping[str, Any], node_index: int) -> Mapping[str, Any] | None:
    for node in doc.get("nodes") or ():
        if int(node.get("node_index", -1)) == node_index:
            return node
    return None


def _node_indices(chunk: RetrievedChunk) -> list[int]:
    provenance = dict(chunk.metadata.get("provenance") or {})
    values = provenance.get("node_indices") or (
        [chunk.node_index] if chunk.node_index is not None else [])
    out: list[int] = []
    for value in values:
        try:
            index = int(value)
        except (TypeError, ValueError):
            continue
        if index not in out:
            out.append(index)
    return out


def _requested_labels(question: str) -> tuple[str, ...]:
    # Local import avoids a module cycle: qa_agent imports the serving retriever types,
    # while normalization runs only after the QA modules have finished loading.
    from .agents.qa_agent import planned_form_items

    labels = [*infer_metrics(question), *extract_disclosure_items(question),
              *planned_form_items(question)]
    return tuple(dict.fromkeys(label for label in labels if label))


def _label_matches(label: str, wanted: str) -> bool:
    """Allow the question-side shorthand used by major-report row labels."""
    left = label.replace(" ", "")
    right = wanted.replace(" ", "")
    return left == right or left == f"{right}수" or right == f"{left}수"


def _soft_label_of(line: str) -> str:
    """행 라벨을 뽑는다. `|` 구분 표 행은 첫 칸, 병합 셀(단일 셀) 행은 앞의
    `구분:내용` 꼴만 라벨로 본다 — 산문 행 전체를 라벨로 취급하면 아무 것과도
    맞지 않아 무해하지만, 짧은 콜론 앞부분은 실제 라벨(예: "보유목적")인 경우가
    많아 exact-label 가산과 부모 문맥 판정에 쓸 수 있다."""
    if "|" in line:
        return row_label_of(line)
    head, sep, _ = line.partition(":")
    if not sep:
        head, sep, _ = line.partition("：")
    if sep and len(head) <= _SOFT_LABEL_MAX_LEN:
        return normalize_row_label(head)
    return ""


def _line_mentions_label(line: str, target: str) -> bool:
    """라벨이 칸 경계 없이 산문 안에 그대로 적힌 경우(예: 병합 셀 "보유목적 :
    경영권 영향력 행사 목적")도 항목 적중으로 본다."""
    compact_line = line.replace(" ", "")
    compact_target = target.replace(" ", "")
    return bool(compact_target) and compact_target in compact_line


def _header_lines(lines: Sequence[str], selected_row: int, scope: str) -> list[str]:
    context: list[str] = []
    if scope:
        context.append(f"[구분: {scope}]")
    for index, line in enumerate(lines):
        if index == selected_row:
            continue
        label = row_label_of(line) if "|" in line else ""
        is_preamble = index < selected_row and "|" not in line
        cells = [cell.strip() for cell in line.split("|")]
        period_cells = sum(1 for cell in cells[1:] if _HEADER_HINT_RE.search(cell))
        # A data row may contain a date too (처분예정기간 등).  A period/header line
        # needs an explicit header label or at least two period-valued columns.
        is_header = (index < selected_row and
                     (label in _HEADER_LABELS or (not label and period_cells >= 2)))
        if (index < selected_row and _UNIT_RE.search(line)) or is_preamble or is_header:
            if line not in context:
                context.append(line)
    return context


_HEADING_PREFIX = tuple(f"{c}." for c in "가나다라마바사아자차") + tuple(f"{i}." for i in range(1, 10))


def _looks_like_heading(text: str) -> bool:
    line = text.split(chr(10), 1)[0].strip()
    return len(line) <= 40 and line.startswith(_HEADING_PREFIX)


def _table_scope(doc: Mapping[str, Any], node_index: int, lines: Sequence[str]) -> str:
    """노드 번호 -> "연결" | "별도" | "". `corpus_retriever.statement_scopes`와 같은
    규칙(표 첫 줄 우선, 없으면 앞선 문단 제목)을 이 노드 하나에 맞춰 다시 쓴다 —
    검색 파사드(corpus_retriever.py)는 건드리지 않는다는 제약 때문에 로직만 복제한다."""
    first = lines[0] if lines else ""
    if "연결" in first and "별도" not in first and "개별" not in first:
        return "연결"
    if "별도" in first or "개별" in first:
        return "별도"
    current = ""
    for node in doc.get("nodes") or ():
        idx = node.get("node_index")
        if idx is None or int(idx) >= node_index:
            break
        if node.get("kind") == "table":
            continue
        text = str(node.get("text") or "").strip()
        if not text:
            continue
        head = text[:60]
        if "연결" in head and "별도" not in head and "개별" not in head:
            current = "연결"
        elif ("별도" in head or "개별" in head
              or head.startswith(("나. 요약재무정보", "요약재무정보"))):
            current = "별도"
        elif _looks_like_heading(text):
            current = ""
    return current


def _row_score(line: str, question: str, wanted: Sequence[str], row_index: int,
               candidate_rows: frozenset[int]) -> float:
    """모든 행(파이프 표 행이든 병합 셀 산문 행이든)을 후보로 채점한다. exact label
    은 필터가 아니라 가산점 하나일 뿐 — 여기서 점수 0 이하만 나중에 버려진다."""
    label = _soft_label_of(line)
    if label in _HEADER_LABELS:
        return -1.0
    compact_question = "".join(question.split())
    score = 0.0
    if label and any(_label_matches(label, target) for target in wanted):
        score += 20.0
    elif wanted and any(_line_mentions_label(line, target) for target in wanted):
        score += 15.0
    if label and label in compact_question:
        score += 12.0
    score += len(set(tokenize(line)) & set(tokenize(question)))
    if row_index in candidate_rows:
        score += 0.5
    return score


def _source_row_index(lines: Sequence[str], line_index: int) -> int:
    """직렬화된 표 텍스트 줄 -> DocumentIR normalized_rows 인덱스.

    옛 구현은 `"|" in line`인 줄만 세어 병합 셀(단일 칸) 행을 건너뛰었다 — 그 결과
    서로 다른 두 산문 행이 같은 인덱스로 계산돼 아래 dedup 단계에서 하나가
    조용히 삭제됐다. 실제 행은 전부(파이프 유무 무관) normalized_rows 한 줄씩이므로
    앞선 줄 전부를 센다.
    """
    return line_index


def _dynamic_max_children(n_wanted: int) -> int:
    """children 예산은 요구 항목 수에 비례한다 — 항목마다 exact 자리 하나 +
    sibling 자리 하나를 기본으로 주고, 전체 안전 상한(12)을 넘지 않는다."""
    dynamic = max(DEFAULT_MIN_CHILDREN, n_wanted * CHILDREN_PER_REQUESTED_ITEM)
    return min(dynamic, GLOBAL_MAX_CHILDREN_PER_PARENT)


def _child_metadata(parent: RetrievedChunk, *, parent_rank: int, node_index: int,
                    row_index: int | None, locator_status: str) -> dict[str, Any]:
    metadata = dict(parent.metadata)
    provenance = dict(metadata.get("provenance") or {})
    provenance["parent_chunk_id"] = parent.chunk_id
    provenance["parent_rank"] = parent_rank
    provenance["normalized_node_index"] = node_index
    provenance["normalized_row_index"] = row_index
    metadata.update({
        "provenance": provenance,
        "arm_a_parent_chunk_id": parent.chunk_id,
        "arm_a_parent_rank": parent_rank,
        "arm_a_normalization": ARM_A_EVIDENCE_NORMALIZATION,
        "locator_status": locator_status,
    })
    return metadata


def _select_rows(lines: Sequence[str], question: str, wanted: Sequence[str],
                 candidate_rows: frozenset[int],
                 max_children: int) -> list[tuple[float, int, str]]:
    """행 선발: (1) 요구 항목마다 최소 1개를 먼저 확보하고 (2) 남는 예산은 새 라벨을
    우선해 채운다(반복 라벨이 예산을 독점하지 않게) (3) 전체 상한을 지킨다."""
    scored = [(_row_score(line, question, wanted, index, candidate_rows), index, line)
              for index, line in enumerate(lines)]
    relevant = [item for item in scored if item[0] > 0]
    if not relevant:
        return []
    relevant.sort(key=lambda item: (-item[0], item[1]))

    covered: set[str] = set()
    coverage_picks: list[tuple[float, int, str]] = []
    remaining: list[tuple[float, int, str]] = []
    for item in relevant:
        label = _soft_label_of(item[2])
        target = next((t for t in wanted if t not in covered and (
            _label_matches(label, t) if label else _line_mentions_label(item[2], t))), None)
        if target is not None:
            covered.add(target)
            coverage_picks.append(item)
        else:
            remaining.append(item)

    used_labels = {_soft_label_of(item[2]) for item in coverage_picks if _soft_label_of(item[2])}
    first_by_label: list[tuple[float, int, str]] = []
    repeated: list[tuple[float, int, str]] = []
    for item in remaining:
        label = _soft_label_of(item[2])
        if label and label in used_labels:
            repeated.append(item)
        else:
            if label:
                used_labels.add(label)
            first_by_label.append(item)

    fill_budget = max(0, max_children - len(coverage_picks))
    fill_picks = (first_by_label + repeated)[:fill_budget]
    selected = (coverage_picks + fill_picks)[:max_children]
    return sorted(selected, key=lambda item: item[1])


def _table_children(question: str, parent: RetrievedChunk, node: Mapping[str, Any],
                    node_index: int, parent_rank: int, doc: Mapping[str, Any],
                    ) -> tuple[list[RetrievedChunk], bool]:
    """returns (children, complete) — complete=False면 이 노드가 요구 항목을 전부
    덮지 못했다는 뜻이고, 호출자가 부모 evidence를 안전망으로 덧붙인다."""
    lines = [line.strip() for line in str(node.get("text") or "").splitlines() if line.strip()]
    if not lines:
        return [], True
    wanted = _requested_labels(question)
    max_children = _dynamic_max_children(len(wanted))
    provenance = dict(parent.metadata.get("provenance") or {})
    candidate_rows = frozenset(
        int(c.get("row_start", c.get("row")))
        for c in (provenance.get("candidates") or ())
        if c.get("node_index") == node_index
        and isinstance(c.get("row_start", c.get("row")), int))
    scope = _table_scope(doc, node_index, lines)

    selected = _select_rows(lines, question, wanted, candidate_rows, max_children)
    covered = {t for t in wanted if any(
        (_label_matches(_soft_label_of(line), t) if _soft_label_of(line)
         else _line_mentions_label(line, t))
        for _, _, line in selected)}
    complete = (not wanted) or covered >= set(wanted)

    children: list[RetrievedChunk] = []
    for _, row_index, line in selected:
        source_row = _source_row_index(lines, row_index)
        evidence_lines = [*_header_lines(lines, row_index, scope), line]
        metadata = _child_metadata(
            parent, parent_rank=parent_rank, node_index=node_index,
            row_index=source_row, locator_status="exact")
        children.append(RetrievedChunk(
            chunk_id=f"{parent.chunk_id}::n{node_index}:r{source_row}",
            doc_id=parent.doc_id,
            score=parent.score,
            section_path=tuple(node.get("section_hierarchy") or ()),
            row_labels=(row_label_of(line) if "|" in line else _soft_label_of(line),),
            evidence_text="\n".join(evidence_lines),
            metadata=metadata,
            node_index=node_index,
        ))
    return children, complete


def _node_child(parent: RetrievedChunk, node: Mapping[str, Any], node_index: int,
                parent_rank: int) -> RetrievedChunk | None:
    text = str(node.get("text") or "").strip()
    if not text:
        return None
    metadata = _child_metadata(
        parent, parent_rank=parent_rank, node_index=node_index,
        row_index=None, locator_status="node_only")
    return RetrievedChunk(
        chunk_id=f"{parent.chunk_id}::n{node_index}",
        doc_id=parent.doc_id,
        score=parent.score,
        section_path=tuple(node.get("section_hierarchy") or ()),
        row_labels=(),
        evidence_text=text,
        metadata=metadata,
        node_index=node_index,
    )


def _unresolved(parent: RetrievedChunk, parent_rank: int) -> RetrievedChunk:
    metadata = dict(parent.metadata)
    metadata.update({
        "arm_a_parent_chunk_id": parent.chunk_id,
        "arm_a_parent_rank": parent_rank,
        "arm_a_normalization": "unresolved",
        "locator_status": "unresolved",
    })
    return replace(parent, metadata=metadata)


def _parent_context(parent: RetrievedChunk, parent_rank: int) -> RetrievedChunk:
    metadata = dict(parent.metadata)
    provenance = dict(metadata.get("provenance") or {})
    metadata.update({
        "arm_a_parent_chunk_id": parent.chunk_id,
        "arm_a_parent_rank": parent_rank,
        "arm_a_normalization": "parent-context",
        "locator_status": provenance.get("status") or "node_only",
    })
    return replace(parent, metadata=metadata)


def _child_relevance(question: str, child: RetrievedChunk) -> float:
    compact_question = "".join(question.split())
    score = float(len(set(tokenize(child.evidence_text)) & set(tokenize(question))))
    if child.row_labels:
        wanted = set(_requested_labels(question))
        label = child.row_labels[0]
        if (label and label in compact_question) or bool(wanted & set(child.row_labels)) or any(
                _label_matches(label, target) for target in wanted):
            return 1000.0
        score += 20.0
    return score


def _parent_children(question: str, parent: RetrievedChunk,
                     docs_by_id: Mapping[str, Mapping[str, Any]],
                     parent_rank: int) -> list[RetrievedChunk]:
    doc = docs_by_id.get(parent.doc_id)
    if not doc:
        return [_unresolved(parent, parent_rank)]
    wanted = _requested_labels(question)
    max_total = _dynamic_max_children(len(wanted))
    candidates: list[tuple[float, int, RetrievedChunk]] = []
    order = 0
    found_node = False
    incomplete = False
    for node_index in _node_indices(parent):
        node = _node_of(doc, node_index)
        if node is None:
            continue
        found_node = True
        if node.get("kind") == "table":
            node_children, complete = _table_children(
                question, parent, node, node_index, parent_rank, doc)
            if not complete:
                incomplete = True
        else:
            child = _node_child(parent, node, node_index, parent_rank)
            node_children = [child] if child is not None else []
        for child in node_children:
            candidates.append((_child_relevance(question, child), order, child))
            order += 1
    candidates.sort(key=lambda item: (-item[0], item[1]))
    children = [child for _, _, child in candidates[:max_total]]

    if not children:
        # 비어 있음(요구 10) — 기존 부모 evidence를 그대로 유지한다.
        return [_parent_context(parent, parent_rank) if found_node
                else _unresolved(parent, parent_rank)]
    if incomplete:
        # 불완전함(요구 10) — 뽑아낸 행은 유지하되, 못 덮은 요구 항목을 위해
        # 원본 부모 evidence를 안전망으로 덧붙인다(대체가 아니라 추가).
        return [*children, _parent_context(parent, parent_rank)]
    return children


def normalize_arm_a_evidence(question: str, chunks: Sequence[RetrievedChunk],
                             docs_by_id: Mapping[str, Mapping[str, Any]] | None,
                             ) -> list[RetrievedChunk]:
    """Restore node/table structure without changing Arm A's parent ranking.

    The first child of every parent is emitted in A rank order before any parent's
    second child. This keeps the original rank as the primary ordering signal
    while letting every parent contribute at least one refined row.

    입력(`chunks`/`docs_by_id`)은 읽기만 한다 — 반환값은 새 리스트/새 RetrievedChunk
    (frozen dataclass)뿐이고, 원본 dict/list는 수정하지 않는다(결정론·입력 불변성).
    """
    docs = docs_by_id or {}
    groups = [
        _parent_children(question, chunk, docs, rank)
        for rank, chunk in enumerate(chunks, start=1)
    ]
    # Overlapping Fixed512 parents can resolve to the exact same source row.  Remove
    # only identical normalized locators (doc, node, row) — this is the one and only
    # dedup criterion (요구 9): distinct rows in the same node, or the same row seen
    # from two ranked parents at different provenance, are never collapsed together.
    seen_locators: set[tuple[str, int | None, int | None]] = set()
    unique_groups: list[list[RetrievedChunk]] = []
    for group in groups:
        unique: list[RetrievedChunk] = []
        for child in group:
            if child.metadata.get("arm_a_normalization") != ARM_A_EVIDENCE_NORMALIZATION:
                unique.append(child)
                continue
            provenance = dict(child.metadata.get("provenance") or {})
            locator = (
                child.doc_id,
                provenance.get("normalized_node_index"),
                provenance.get("normalized_row_index"),
            )
            if locator in seen_locators:
                continue
            seen_locators.add(locator)
            unique.append(child)
        unique_groups.append(unique)
    out: list[RetrievedChunk] = []
    for layer in zip_longest(*unique_groups):
        out.extend(child for child in layer if child is not None)
    return out
