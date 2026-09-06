"""arm_a_document_binder — DocumentBinder V1: 문서 경계를 Evidence V2보다 먼저 고정한다.

Turn A4-A3-QA-DOCUMENT-BINDER-V1. 계약은 docs/A4_A3_QA_DOCUMENT_BINDER_V1_CONTRACT.md에
있다 — 이 파일과 그 문서가 어긋나면 문서가 우선이다.

이 모듈은 A4 R4 -> A3 Guard/refill이 이미 만든 top-20 `RetrievedChunk` 리스트를 **그대로**
받아, 그 순서·provenance를 손대지 않고 "이 질문에 답할 document_id(들)"만 고른다. 새
후보를 만들지 않고(검색·DB·임베딩 재호출 0), 명시적으로 모순되는 문서만 제외하며, 정보가
없어 판단할 수 없는 경우는 절대 제외하지 않고 AMBIGUOUS로 남긴다. 행 단위 확장(Evidence
V2)은 이 모듈 다음 단계의 책임이다 — 여기서는 문서 단위 예산(`document_budgets`)만
내려준다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from dart_corpus.retrieval.conditions import QueryConditions

from .corpus_retriever import RetrievedChunk, question_dates

STATUS_BOUND = "BOUND"
STATUS_MULTI_DOCUMENT_BOUND = "MULTI_DOCUMENT_BOUND"
STATUS_AMBIGUOUS = "AMBIGUOUS"
STATUS_UNRESOLVED = "UNRESOLVED"

DEFAULT_TOTAL_EVIDENCE_BUDGET = 20


@dataclass(frozen=True)
class CandidateGroup:
    group_id: str
    role: str | None
    document_ids: tuple[str, ...]
    selected: bool
    candidates: tuple[RetrievedChunk, ...]


@dataclass(frozen=True)
class DocumentBindingResult:
    status: str
    selected_document_ids: tuple[str, ...]
    candidate_groups: tuple[CandidateGroup, ...]
    rejected_document_ids: tuple[str, ...]
    rejection_reasons: Mapping[str, tuple[str, ...]]
    retained_candidates: tuple[RetrievedChunk, ...]
    original_rank: Mapping[str, int]
    document_budgets: Mapping[str, int]
    diagnostics: Mapping[str, Any]


# ---------- 메타데이터 접근 ----------

def _meta(candidate: RetrievedChunk, key: str) -> Any:
    return (candidate.metadata or {}).get(key)


def _normalize_corp(s: str) -> str:
    return "".join(str(s).split())


def _cand_year_month(candidate: RetrievedChunk) -> tuple[int | None, int | None]:
    base_year = _meta(candidate, "base_year")
    base_month = _meta(candidate, "base_month")
    if isinstance(base_year, int):
        return base_year, (base_month if isinstance(base_month, int) else None)
    rcept = _meta(candidate, "rcept_dt")
    if isinstance(rcept, str) and len(rcept) >= 6 and rcept[:6].isdigit():
        return int(rcept[:4]), int(rcept[4:6])
    return None, None


def _cand_ymd(candidate: RetrievedChunk) -> tuple[int, int, int] | None:
    rcept = _meta(candidate, "rcept_dt")
    if isinstance(rcept, str) and len(rcept) >= 8 and rcept[:8].isdigit():
        return int(rcept[:4]), int(rcept[4:6]), int(rcept[6:8])
    return None


# ---------- §4 우선순위 1-5: 각 차원은 "match"|"conflict"|"unknown"만 돌려준다 ----------
# 판정에 필요한 값이 후보에 없으면 언제나 "unknown"이다 — 절대 "conflict"로 추측하지 않는다.

def _dimension_company(candidate: RetrievedChunk, corps: frozenset[str]) -> str:
    if not corps:
        return "match"
    corp_code = _meta(candidate, "corp_code")
    corp_name = _meta(candidate, "corp_name")
    if not corp_code and not corp_name:
        return "unknown"
    values = {_normalize_corp(v) for v in (corp_code, corp_name) if v}
    targets = {_normalize_corp(v) for v in corps if v}
    for v in values:
        for t in targets:
            if v == t or (t and t in v) or (v and v in t):
                return "match"
    return "conflict"


def _dimension_doc_group(candidate: RetrievedChunk, doc_groups: frozenset[str]) -> str:
    if not doc_groups:
        return "match"
    dg = _meta(candidate, "doc_group")
    if not dg:
        return "unknown"
    return "match" if dg in doc_groups else "conflict"


def _dimension_period(candidate: RetrievedChunk, conditions: QueryConditions,
                      exact_dates: frozenset[tuple[int, int, int]]) -> str:
    if not (exact_dates or conditions.years or conditions.year_months):
        return "match"
    cand_year, cand_month = _cand_year_month(candidate)
    cand_date = _cand_ymd(candidate)
    any_unknown = False
    if exact_dates:
        if cand_date is not None:
            if cand_date not in exact_dates:
                return "conflict"
        else:
            any_unknown = True
    if conditions.years:
        if cand_year is not None:
            if cand_year not in conditions.years:
                return "conflict"
        else:
            any_unknown = True
    if conditions.year_months:
        if cand_year is not None and cand_month is not None:
            if (cand_year, cand_month) not in conditions.year_months:
                return "conflict"
        else:
            any_unknown = True
    return "unknown" if any_unknown else "match"


def _dimension_subtype(candidate: RetrievedChunk, conditions: QueryConditions) -> str:
    dg = _meta(candidate, "doc_group")
    wanted: frozenset[str] = frozenset()
    if dg == "periodic":
        wanted = conditions.periodic_subtypes
    elif dg == "exchange":
        wanted = conditions.exchange_subtypes
    elif dg == "major":
        wanted = conditions.major_labels
    if not wanted:
        return "match"
    subtype = _meta(candidate, "doc_subtype")
    if not subtype:
        return "unknown"
    return "match" if subtype in wanted else "conflict"


def _dimension_correction(candidate: RetrievedChunk, conditions: QueryConditions) -> str:
    if not conditions.correction:
        return "match"
    is_corr = _meta(candidate, "is_correction")
    if is_corr is None:
        return "unknown"
    # 질문이 정정을 요구하는데 문서가 확실히 정정이 아니면 제외. 반대(질문은 정정을
    # 요구 안 하는데 문서가 정정)는 최신 유효본일 수 있어 제외하지 않는다(§4-5).
    return "match" if is_corr else "conflict"


_DIMENSION_REASON = {
    "company": "company_mismatch",
    "doc_group": "doc_group_mismatch",
    "period": "period_mismatch",
    "subtype": "subtype_mismatch",
    "correction": "correction_mismatch",
}


def _evaluate_document(candidates: Sequence[RetrievedChunk], conditions: QueryConditions,
                       exact_dates: frozenset[tuple[int, int, int]],
                       ) -> tuple[bool, tuple[str, ...], tuple[str, ...]]:
    """대표 후보(같은 doc_id는 같은 문서 메타데이터를 공유한다) 기준 판정.

    returns (rejected, reasons, unknown_dims).
    """
    rep = candidates[0]
    checks = {
        "company": _dimension_company(rep, conditions.corps),
        "doc_group": _dimension_doc_group(rep, conditions.doc_groups),
        "period": _dimension_period(rep, conditions, exact_dates),
        "subtype": _dimension_subtype(rep, conditions),
        "correction": _dimension_correction(rep, conditions),
    }
    reasons = tuple(_DIMENSION_REASON[dim] for dim, result in checks.items() if result == "conflict")
    unknown_dims = tuple(dim for dim, result in checks.items() if result == "unknown")
    return bool(reasons), reasons, unknown_dims


# ---------- §5 복수 문서 신호 ----------

_BEFORE_WORDS = ("정정 전", "정정전", "변경 전", "변경전")
_AFTER_WORDS = ("정정 후", "정정후", "변경 후", "변경후")
_PREVIOUS_WORDS = ("직전",)
_CURRENT_WORDS = ("현재", "이번")


def _multi_document_signal(question: str, conditions: QueryConditions) -> str | None:
    if len(conditions.years) >= 2:
        return "multi_year"
    if len(conditions.year_months) >= 2:
        return "multi_year_month"
    if len(conditions.corps) >= 2:
        return "multi_corp"
    q = question or ""
    if any(w in q for w in _BEFORE_WORDS) and any(w in q for w in _AFTER_WORDS):
        return "before_after"
    if any(w in q for w in _PREVIOUS_WORDS) and any(w in q for w in _CURRENT_WORDS):
        return "previous_current"
    return None


def _assign_roles(signal: str, conditions: QueryConditions,
                  survivors: Mapping[str, Sequence[RetrievedChunk]]) -> dict[str, list[str]]:
    """생존 문서를 역할별로 나눈다. 어느 역할에도 못 들어간 문서는 "unclassified"."""
    roles: dict[str, list[str]] = {}
    assigned: set[str] = set()

    if signal == "multi_year":
        for year in sorted(conditions.years):
            matching = [d for d, c in survivors.items() if _cand_year_month(c[0])[0] == year]
            if matching:
                roles[f"year_{year}"] = matching
                assigned.update(matching)
    elif signal == "multi_year_month":
        for y, m in sorted(conditions.year_months):
            matching = [d for d, c in survivors.items() if _cand_year_month(c[0]) == (y, m)]
            if matching:
                roles[f"period_{y}_{m:02d}"] = matching
                assigned.update(matching)
    elif signal == "multi_corp":
        for corp in sorted(conditions.corps):
            matching = [d for d, c in survivors.items()
                       if _dimension_company(c[0], frozenset({corp})) == "match"]
            if matching:
                roles[corp] = matching
                assigned.update(matching)
    elif signal == "before_after":
        before = [d for d, c in survivors.items() if _meta(c[0], "is_correction") is False]
        after = [d for d, c in survivors.items() if _meta(c[0], "is_correction") is True]
        if before:
            roles["before"] = before
            assigned.update(before)
        if after:
            roles["after"] = after
            assigned.update(after)
    elif signal == "previous_current":
        dated = sorted(
            ((d, c) for d, c in survivors.items() if _meta(c[0], "rcept_dt")),
            key=lambda item: str(_meta(item[1][0], "rcept_dt")),
        )
        if len(dated) >= 2:
            roles["previous"] = [dated[0][0]]
            roles["current"] = [dated[-1][0]]
            assigned.update({dated[0][0], dated[-1][0]})
        elif len(dated) == 1:
            roles["current"] = [dated[0][0]]
            assigned.add(dated[0][0])

    leftover = [d for d in survivors if d not in assigned]
    if leftover:
        roles["unclassified"] = leftover
    return roles


def _resolve_role(doc_ids: Sequence[str], survivors: Mapping[str, Sequence[RetrievedChunk]],
                  unknown_map: Mapping[str, tuple[str, ...]],
                  original_rank: Mapping[str, int]) -> tuple[str | None, bool]:
    """returns (winner_doc_id_or_None, ambiguous)."""
    if len(doc_ids) == 1:
        return doc_ids[0], False
    if any(d in unknown_map for d in doc_ids):
        return None, True
    winner = min(doc_ids, key=lambda d: min(original_rank[c.chunk_id] for c in survivors[d]))
    return winner, False


# ---------- §6 evidence budget ----------

def _allocate_budget(doc_ids: Sequence[str], survivors: Mapping[str, Sequence[RetrievedChunk]],
                     original_rank: Mapping[str, int],
                     total: int = DEFAULT_TOTAL_EVIDENCE_BUDGET) -> dict[str, int]:
    if not doc_ids:
        return {}
    ordered = sorted(doc_ids, key=lambda d: min(original_rank[c.chunk_id] for c in survivors[d]))
    n = len(ordered)
    base, remainder = divmod(total, n)
    return {d: base + (1 if i < remainder else 0) for i, d in enumerate(ordered)}


# ---------- 문서 그룹핑(입력 순서 = rank 순서를 그대로 보존) ----------

def _group_by_doc(candidates: Sequence[RetrievedChunk]) -> dict[str, list[RetrievedChunk]]:
    groups: dict[str, list[RetrievedChunk]] = {}
    for c in candidates:
        groups.setdefault(c.doc_id, []).append(c)
    return groups


def _flatten_in_rank_order(candidates: Sequence[RetrievedChunk], doc_ids: set[str]
                           ) -> tuple[RetrievedChunk, ...]:
    return tuple(c for c in candidates if c.doc_id in doc_ids)


# ---------- 진입점 ----------

def bind_documents(question: str, conditions: QueryConditions,
                   retrieved_candidates: Sequence[RetrievedChunk]) -> DocumentBindingResult:
    original_rank = {c.chunk_id: i + 1 for i, c in enumerate(retrieved_candidates)}

    if not retrieved_candidates:
        return DocumentBindingResult(
            status=STATUS_UNRESOLVED, selected_document_ids=(), candidate_groups=(),
            rejected_document_ids=(), rejection_reasons={}, retained_candidates=(),
            original_rank={}, document_budgets={},
            diagnostics={"reason": "no_candidates"})

    exact_dates = frozenset(question_dates(question))
    doc_map = _group_by_doc(retrieved_candidates)

    rejected_ids: list[str] = []
    reasons_map: dict[str, tuple[str, ...]] = {}
    unknown_map: dict[str, tuple[str, ...]] = {}
    survivors: dict[str, list[RetrievedChunk]] = {}
    for doc_id, cands in doc_map.items():
        rejected, reasons, unknowns = _evaluate_document(cands, conditions, exact_dates)
        if rejected:
            rejected_ids.append(doc_id)
            reasons_map[doc_id] = reasons
        else:
            survivors[doc_id] = cands
            if unknowns:
                unknown_map[doc_id] = unknowns

    diagnostics_base: dict[str, Any] = {
        "n_input_candidates": len(retrieved_candidates),
        "n_input_documents": len(doc_map),
        "n_rejected_documents": len(rejected_ids),
        "n_surviving_documents": len(survivors),
        "unknown_dimensions": dict(unknown_map),
        "exact_dates_in_question": sorted(exact_dates),
    }

    if not survivors:
        return DocumentBindingResult(
            status=STATUS_UNRESOLVED, selected_document_ids=(), candidate_groups=(),
            rejected_document_ids=tuple(rejected_ids), rejection_reasons=reasons_map,
            retained_candidates=(), original_rank=original_rank, document_budgets={},
            diagnostics={**diagnostics_base, "reason": "all_documents_rejected"})

    signal = _multi_document_signal(question, conditions)
    diagnostics_base["multi_document_signal"] = signal

    if signal is None:
        if len(survivors) == 1:
            doc_id = next(iter(survivors))
            group = CandidateGroup(group_id="g0", role="primary", document_ids=(doc_id,),
                                   selected=True, candidates=tuple(survivors[doc_id]))
            return DocumentBindingResult(
                status=STATUS_BOUND, selected_document_ids=(doc_id,), candidate_groups=(group,),
                rejected_document_ids=tuple(rejected_ids), rejection_reasons=reasons_map,
                retained_candidates=tuple(survivors[doc_id]), original_rank=original_rank,
                document_budgets=_allocate_budget([doc_id], survivors, original_rank),
                diagnostics=diagnostics_base)

        if unknown_map:
            # 정보 부족 때문에 못 좁힌다 — 아무것도 강제로 고르지 않는다(§4, §3 AMBIGUOUS).
            groups = tuple(
                CandidateGroup(group_id=f"g{i}", role="ambiguous", document_ids=(doc_id,),
                               selected=False, candidates=tuple(cands))
                for i, (doc_id, cands) in enumerate(survivors.items()))
            retained = _flatten_in_rank_order(retrieved_candidates, set(survivors))
            return DocumentBindingResult(
                status=STATUS_AMBIGUOUS, selected_document_ids=(), candidate_groups=groups,
                rejected_document_ids=tuple(rejected_ids), rejection_reasons=reasons_map,
                retained_candidates=retained, original_rank=original_rank,
                document_budgets=_allocate_budget(list(survivors), survivors, original_rank),
                diagnostics=diagnostics_base)

        # 정보는 전부 있는데 우열이 안 갈린다 — 기존 rank로 하나를 정한다(§4-6).
        winner, _ = _resolve_role(list(survivors), survivors, unknown_map, original_rank)
        groups = []
        for i, (doc_id, cands) in enumerate(survivors.items()):
            role = "primary" if doc_id == winner else "not_selected_tie"
            groups.append(CandidateGroup(group_id=f"g{i}", role=role, document_ids=(doc_id,),
                                         selected=(doc_id == winner), candidates=tuple(cands)))
        return DocumentBindingResult(
            status=STATUS_BOUND, selected_document_ids=(winner,), candidate_groups=tuple(groups),
            rejected_document_ids=tuple(rejected_ids), rejection_reasons=reasons_map,
            retained_candidates=tuple(survivors[winner]), original_rank=original_rank,
            document_budgets=_allocate_budget([winner], survivors, original_rank),
            diagnostics=diagnostics_base)

    # ---- 복수 문서 신호가 있다: 역할별로 좁힌다(§5) ----
    role_map = _assign_roles(signal, conditions, survivors)
    groups: list[CandidateGroup] = []
    selected_ids: list[str] = []
    any_role_ambiguous = False
    gi = 0
    for role, doc_ids in role_map.items():
        if role == "unclassified":
            for d in doc_ids:
                groups.append(CandidateGroup(group_id=f"g{gi}", role="unclassified",
                                             document_ids=(d,), selected=False,
                                             candidates=tuple(survivors[d])))
                gi += 1
            continue
        winner, ambiguous = _resolve_role(doc_ids, survivors, unknown_map, original_rank)
        if ambiguous:
            any_role_ambiguous = True
            for d in doc_ids:
                groups.append(CandidateGroup(group_id=f"g{gi}", role=role, document_ids=(d,),
                                             selected=False, candidates=tuple(survivors[d])))
                gi += 1
        else:
            groups.append(CandidateGroup(group_id=f"g{gi}", role=role, document_ids=(winner,),
                                         selected=True, candidates=tuple(survivors[winner])))
            selected_ids.append(winner)
            gi += 1
            for d in doc_ids:
                if d != winner:
                    groups.append(CandidateGroup(group_id=f"g{gi}", role=f"{role}_not_selected",
                                                 document_ids=(d,), selected=False,
                                                 candidates=tuple(survivors[d])))
                    gi += 1

    if not selected_ids or any_role_ambiguous:
        # 신호는 있었지만 역할 전부(또는 일부)를 확신 있게 못 좁혔다 — 과장하지 않고
        # AMBIGUOUS로 낮춘다. 살아남은 후보는 전부 유지한다.
        retained = _flatten_in_rank_order(retrieved_candidates, set(survivors))
        return DocumentBindingResult(
            status=STATUS_AMBIGUOUS, selected_document_ids=(), candidate_groups=tuple(groups),
            rejected_document_ids=tuple(rejected_ids), rejection_reasons=reasons_map,
            retained_candidates=retained, original_rank=original_rank,
            document_budgets=_allocate_budget(list(survivors), survivors, original_rank),
            diagnostics=diagnostics_base)

    retained = _flatten_in_rank_order(retrieved_candidates, set(selected_ids))
    return DocumentBindingResult(
        status=STATUS_MULTI_DOCUMENT_BOUND, selected_document_ids=tuple(selected_ids),
        candidate_groups=tuple(groups), rejected_document_ids=tuple(rejected_ids),
        rejection_reasons=reasons_map, retained_candidates=retained, original_rank=original_rank,
        document_budgets=_allocate_budget(selected_ids, survivors, original_rank),
        diagnostics=diagnostics_base)
