"""정정 Chain — 같은 사건의 공시들을 원문에 적힌 관계로 잇는다.

새 관계를 만들어내지 않는다. 공시 원문에 **이미 적혀 있는** 두 필드만 쓴다.

    거래소공시   "2. 정정관련 공시서류제출일  2025-04-18"
    주요사항보고서 "2. 정정대상 공시서류의 최초제출일 : 2023년 2월 27일"

이 날짜 + 같은 기업 + 같은 doc_group으로 원공시를 특정한다. 후보가 여럿이면
doc_subtype으로 한 번 더 좁히고, 그래도 여럿이면 **링크를 만들지 않는다**
(틀린 링크가 없는 링크보다 나쁘다).

실측(4,204건, 정정 문서 1,004건):
    resolved 493 / 대상이 코퍼스 밖 308 / 모호 102 / 날짜 필드 없음 101
코퍼스 기간(2023.01~2026.03) 이전에 제출된 원공시는 애초에 이을 수 없다.
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable, Sequence

# 거래소공시 서식
_EXCHANGE_DATE_RE = re.compile(r"정정관련\s*공시서류제출일\s*(\d{4})-(\d{2})-(\d{2})")
# 주요사항보고서 서식(한글 날짜)
_MAJOR_DATE_RE = re.compile(
    r"정정대상\s*공시서류의\s*최초제출일\s*:?\s*(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일"
)

MAX_CHAIN_DEPTH = 64   # 순환 방어용 상한. 실측 최장 chain은 15건이라 넉넉하다.


def parse_original_receipt_date(text: str) -> str | None:
    """정정 공시 본문에서 원공시 접수일(YYYYMMDD)을 읽는다. 없으면 None."""
    m = _EXCHANGE_DATE_RE.search(text) or _MAJOR_DATE_RE.search(text)
    if not m:
        return None
    y, mo, d = m.groups()
    return f"{int(y):04d}{int(mo):02d}{int(d):02d}"


@dataclass
class CorrectionLinks:
    """정정 -> 원공시 단방향 링크와 그로부터 파생된 chain."""

    parent: dict[str, str] = field(default_factory=dict)
    children: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    root_of: dict[str, str] = field(default_factory=dict)
    members: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    unresolved: dict[str, str] = field(default_factory=dict)   # doc_id -> 사유

    # ---------- 생성 ----------
    @classmethod
    def build(cls, documents: Sequence) -> "CorrectionLinks":
        links = cls()
        by_key: dict[tuple[str, str, str], list] = defaultdict(list)
        for d in documents:
            by_key[(_corp_key(d), d.rcept_dt, d.doc_group)].append(d)

        for d in documents:
            if not d.is_correction:
                continue
            date = parse_original_receipt_date(d.text)
            if date is None:
                links.unresolved[d.doc_id] = "no_date_field"
                continue
            cands = [c for c in by_key.get((_corp_key(d), date, d.doc_group), [])
                     if c.doc_id != d.doc_id]
            if not cands:
                links.unresolved[d.doc_id] = "target_not_in_corpus"
                continue
            if len(cands) > 1:
                narrowed = [c for c in cands if c.doc_subtype == d.doc_subtype]
                if len(narrowed) != 1:
                    links.unresolved[d.doc_id] = "ambiguous"
                    continue
                cands = narrowed
            links.parent[d.doc_id] = cands[0].doc_id

        for child, par in links.parent.items():
            links.children[par].append(child)

        seen = set(links.parent) | set(links.parent.values())
        for doc_id in seen:
            r = links._resolve_root(doc_id)
            links.root_of[doc_id] = r
            links.members[r].append(doc_id)
        for r in links.members:
            links.members[r].sort()
        return links

    def _resolve_root(self, doc_id: str) -> str:
        """부모를 끝까지 따라간다. 상한에 걸려 중간에서 멈추면 하나의 사건이 여러
        chain으로 쪼개진다 — 실제로 현대건설 아미랄 chain(15건)이 그렇게 갈렸다."""
        cur = doc_id
        seen = {cur}
        for _ in range(MAX_CHAIN_DEPTH):
            nxt = self.parent.get(cur)
            if nxt is None or nxt in seen:
                return cur
            seen.add(nxt)
            cur = nxt
        return cur

    # ---------- 조회 ----------
    def hop1(self, doc_id: str) -> list[str]:
        """1-hop: 부모 하나 + 직접 자식들."""
        out: list[str] = []
        par = self.parent.get(doc_id)
        if par:
            out.append(par)
        out.extend(self.children.get(doc_id, ()))
        return out

    def chain(self, doc_id: str) -> list[str]:
        """같은 root에 속한 문서 전부(자기 자신 포함)."""
        root = self.root_of.get(doc_id)
        if root is None:
            return []
        return list(self.members.get(root, ()))

    def stats(self) -> dict[str, int]:
        reasons: dict[str, int] = defaultdict(int)
        for reason in self.unresolved.values():
            reasons[reason] += 1
        return {
            "links": len(self.parent),
            "chains": len(self.members),
            "unresolved": len(self.unresolved),
            **{f"unresolved_{k}": v for k, v in sorted(reasons.items())},
        }


def _corp_key(doc) -> str:
    return doc.corp_code or doc.corp_name


def iter_chain_docs(links: CorrectionLinks, seeds: Iterable[str], mode: str) -> set[str]:
    """seed 문서들에서 확장해 얻는 문서 id 집합(seed 자신은 제외)."""
    out: set[str] = set()
    seeds = list(seeds)
    for s in seeds:
        out.update(links.hop1(s) if mode == "hop1" else links.chain(s))
    return out - set(seeds)
