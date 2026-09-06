"""LOW / HIGH 세그먼트 — vFINAL 1번 "LOW = 확정 조건 ≤2, HIGH = ≥3".

확정 조건 수 계산 규칙(인터페이스 계약 §1-2):
    len(corps)
  + (years ∪ year_months 가 비면 0, 아니면 1)
  + (doc_groups ∪ periodic_subtypes ∪ exchange_subtypes ∪ major_labels 가 비면 0, 아니면 1)

conditions.py(검색 코어)는 수정하지 않는다 — 이 모듈은 QueryConditions를 읽기만 한다.
"""
from __future__ import annotations

from typing import Any, Mapping

from .conditions import QueryConditions

LOW_MAX_CONDITIONS = 2


def hard_condition_count(cond: QueryConditions | Mapping[str, Any]) -> int:
    d = cond.as_dict() if isinstance(cond, QueryConditions) else dict(cond)
    n = len(d.get("corps") or [])
    if d.get("years") or d.get("year_months"):
        n += 1
    if (d.get("doc_groups") or d.get("periodic_subtypes")
            or d.get("exchange_subtypes") or d.get("major_labels")):
        n += 1
    return n


def segment_of(cond: QueryConditions | Mapping[str, Any]) -> str:
    return "LOW" if hard_condition_count(cond) <= LOW_MAX_CONDITIONS else "HIGH"


def conditions_from_dict(d: Mapping[str, Any]) -> QueryConditions:
    """QueryConditions.as_dict()의 역변환 — 사전 계산 파일(§1-2)을 검색기에 넣을 때 쓴다."""
    return QueryConditions(
        corps=frozenset(d.get("corps") or ()),
        years=frozenset(int(y) for y in (d.get("years") or ())),
        year_months=frozenset((int(y), int(m)) for y, m in (d.get("year_months") or ())),
        doc_groups=frozenset(d.get("doc_groups") or ()),
        periodic_subtypes=frozenset(d.get("periodic_subtypes") or ()),
        exchange_subtypes=frozenset(d.get("exchange_subtypes") or ()),
        major_labels=frozenset(d.get("major_labels") or ()),
        correction=bool(d.get("correction", False)),
        wants_latest=bool(d.get("wants_latest", False)),
        candidate_terms=tuple(d.get("candidate_terms") or ()),
    )
