"""조건 인지 문서 Retriever.

파이프라인:

    질문
      -> extract_conditions()          기업 / 기간 / 공시유형 / 사건 식별어
      -> hard constraint  (기업, 기간)  후보 풀 자체를 자른다
      -> BM25 + soft boost (공시유형, 사건 식별어, 정정여부, 보고자)
      -> top-k

hard와 soft를 나눈 이유는 실측 결과다. 기업·기간을 hard로 자르면 회귀 없이 개선되지만,
공시유형을 hard로 자르면 doc_group을 넘나드는 multi-hop 질문(주요사항보고서에서 시작해
반기보고서에서 결과를 확인하는 질문)이 깨진다. 그래서 공시유형은 점수만 올린다.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .chains import CorrectionLinks, iter_chain_docs
from .conditions import QueryConditions, extract_conditions
from .corp_dictionary import CorpDictionary
from .lexical import BM25, tokenize

_PAREN_RE = re.compile(r"\(([^)]+)\)")


@dataclass(frozen=True)
class IndexedDocument:
    doc_id: str
    corp_name: str
    corp_code: str
    filer_name: str
    doc_group: str
    doc_subtype: str
    report_nm: str
    rcept_dt: str
    base_year: int | None
    base_month: int | None
    is_correction: bool
    text: str

    @property
    def major_label(self) -> str:
        """major는 manifest에 doc_subtype이 비어 있다 — report_nm 괄호 안이 실질 유형."""
        m = _PAREN_RE.search(self.report_nm or "")
        return m.group(1) if m else ""

    @property
    def rcept_year(self) -> int:
        try:
            return int((self.rcept_dt or "")[:4])
        except ValueError:
            return 0

    @property
    def period_year(self) -> int:
        """질문의 '2025년'과 대조할 연도.

        정기공시는 보고서 기준연도(base_year)다. 접수연도가 아니다 —
        사업보고서 (2025.12)는 2026-03에 접수되기 때문이다.
        나머지 공시는 사건 발생일이 곧 접수일이다.
        """
        return self.base_year if self.base_year is not None else self.rcept_year


@dataclass(frozen=True)
class RetrievalHit:
    doc_id: str
    rank: int
    score: float
    components: dict
    document: IndexedDocument


@dataclass(frozen=True)
class Weights:
    doc_group: float = 6.0
    doc_subtype: float = 4.0
    salient_term: float = 8.0
    max_salient_terms: int = 3
    correction: float = 1.5
    filer: float = 2.0
    salient_max_df_ratio: float = 0.02
    # 점수 결합 (score_mode="minmax"/"maxnorm"일 때만 쓰인다)
    #   metadata_alpha: 최종 점수에서 metadata가 차지하는 비중. BM25와 metadata를
    #   둘 다 [0,1]로 맞춘 뒤 쓰므로 질문마다 BM25 점수 범위가 달라도 의미가 같다.
    #   0.5 = 어휘 증거와 metadata 증거를 같은 무게로 본다는 중립값이다. Gold 25문항
    #   sweep에서 0.35~0.65 구간이 같은 결과를 내므로(고원), 그 한가운데를 쓴다 —
    #   최고점을 고른 값이 아니다.
    metadata_alpha: float = 0.5
    rrf_k: float = 60.0
    # chain expansion
    chain_seed_k: int = 20          # 확장의 출발점으로 쓸 상위 문서 수
    chain_inherit: float = 0.9      # 확장 문서가 물려받는 seed 점수 비율
    # 질문이 최신본을 요구할 때 chain 안에서만 주는 시간순 가산의 최대 크기.
    # 결과 점수 폭(span)에 대한 비율로 쓴다 — 점수 스케일이 바뀌어도 의미가 같다.
    # 같은 사건 안에서 순서를 바꿀 만큼은 되고, 사건 사이 순위를 뒤집을 만큼은 아니다.
    chain_recency_span: float = 0.03


class DocumentIndex:
    """문서 단위 조건 인지 검색.

    corp_mode / period_mode는 "hard" | "soft" | "off"다. 기본값은 실측에서 회귀 없이
    가장 좋았던 조합(둘 다 hard)이고, ablation 비교를 위해 열어 둔다.
    """

    def __init__(self, documents: list[IndexedDocument], corp_dict: CorpDictionary,
                 weights: Weights | None = None,
                 corp_mode: str = "hard", period_mode: str = "hard",
                 use_doctype_boost: bool = True, use_salient_boost: bool = True,
                 chain_mode: str = "rank_only", chain_recency: bool = True,
                 score_mode: str = "maxnorm"):
        self.documents = documents
        self.corp_dict = corp_dict
        self.weights = weights or Weights()
        self.corp_mode = corp_mode
        self.period_mode = period_mode
        self.use_doctype_boost = use_doctype_boost
        self.use_salient_boost = use_salient_boost
        # 점수 결합 방식: "maxnorm"(기본) | "minmax" | "fixed" | "rrf"
        #   maxnorm : BM25 / max(BM25) 로 정규화한 뒤 metadata와 가중합.
        #             후보 풀의 최솟값에 흔들리지 않아 minmax보다 안정적이다.
        #   minmax  : (BM25 - min) / (max - min) 정규화. 후보 하나가 바뀌면 전체가 바뀐다.
        #   fixed   : BM25 + 상수 boost. 후보 풀의 BM25 최댓값이 질문마다 17.7~77.9로
        #             4.4배 달라서, 같은 +6이 상위 점수의 7.7%~34.0%로 작용한다(실측).
        #   rrf     : BM25 순위와 metadata 순위를 순위로 결합. metadata가 독립 검색기가
        #             아니라 소수의 boolean 조건이라 순위에 동점이 대량으로 생긴다.
        self.score_mode = score_mode
        # "off" | "rank_only" | "hop1" | "chain"
        #   rank_only : chain을 만들되 후보를 늘리지 않고 순서만 조정
        #   hop1      : seed의 부모/자식만 후보에 추가
        #   chain     : seed가 속한 chain 전체를 후보에 추가
        self.chain_mode = chain_mode
        self.chain_recency = chain_recency
        self._bm25 = BM25([tokenize(d.text) for d in documents])
        self._lower_texts = [d.text.lower() for d in documents]
        self._df_cache: dict[str, int] = {}
        self._pos = {d.doc_id: i for i, d in enumerate(documents)}
        self._links: CorrectionLinks | None = None

    @property
    def links(self) -> CorrectionLinks:
        """정정 chain은 처음 필요할 때 한 번만 만든다(전수 스캔 1회)."""
        if self._links is None:
            self._links = CorrectionLinks.build(self.documents)
        return self._links

    # ---------- 로딩 ----------
    @classmethod
    def from_jsonl(cls, path: Path | str, corp_dict: CorpDictionary,
                   text_cap: int = 3000, **kwargs) -> "DocumentIndex":
        docs = [
            IndexedDocument(
                doc_id=d["doc_id"],
                corp_name=d.get("corp_name") or "",
                corp_code=d.get("corp_code") or "",
                filer_name=d.get("filer_name") or d.get("flr_nm") or "",
                doc_group=d.get("doc_group") or "",
                doc_subtype=d.get("doc_subtype") or "",
                report_nm=d.get("report_nm") or "",
                rcept_dt=d.get("rcept_dt") or "",
                base_year=d.get("base_year"),
                base_month=d.get("base_month"),
                is_correction=bool(d.get("is_correction")),
                text=(d.get("text") or "")[:text_cap],
            )
            for d in _iter_jsonl(path)
        ]
        return cls(docs, corp_dict, **kwargs)

    # ---------- 사건 식별어 ----------
    def document_frequency(self, term: str) -> int:
        key = term.lower()
        hit = self._df_cache.get(key)
        if hit is None:
            hit = sum(1 for t in self._lower_texts if key in t)
            self._df_cache[key] = hit
        return hit

    def salient_terms(self, conditions: QueryConditions) -> list[str]:
        """코퍼스에서 희소한 말만 남긴다.

        정정공시 서식은 문장 대부분이 항목명 boilerplate라, 사건을 가르는 말
        ("아미랄", "Salamanca")이 BM25 점수에서 묻힌다. 그 말만 따로 세운다.
        """
        n = len(self.documents) or 1
        # 문서 1건에만 있는 말은 코퍼스 크기와 무관하게 항상 사건 식별어다.
        # (비율만 쓰면 작은 인덱스에서 limit이 1 미만이 되어 아무것도 못 고른다.)
        limit = max(1.0, self.weights.salient_max_df_ratio * n)
        scored: list[tuple[int, str]] = []
        for term in conditions.candidate_terms:
            df = self.document_frequency(term)
            if not (0 < df <= limit):
                continue
            # 조사가 덜 벗겨진 말 걸러내기: 한 글자를 떼면 흔한 말이 되는 것은
            # 사건 식별어가 아니라 활용형이다("년과" -> "년", "사실과" -> "사실").
            if len(term) >= 2 and self.document_frequency(term[:-1]) > limit:
                continue
            scored.append((df, term))

        # 희소한 순, 같으면 긴 쪽 우선. 같은 어절에서 나온 변형("사우디"/"사우")이
        # 슬롯을 나눠 먹지 않도록 df가 같은 접두형은 버린다.
        scored.sort(key=lambda x: (x[0], -len(x[1]), x[1]))
        kept: list[str] = []
        for df, term in scored:
            if any(k.startswith(term) and self.document_frequency(k) == df for k in kept):
                continue
            kept.append(term)
            if len(kept) >= self.weights.max_salient_terms:
                break
        return kept

    # ---------- 조건 적용 ----------
    def _corp_ok(self, doc: IndexedDocument, c: QueryConditions) -> bool:
        if self.corp_mode != "hard" or not c.corps:
            return True
        return doc.corp_name in c.corps or doc.filer_name in c.corps

    def _period_ok(self, doc: IndexedDocument, c: QueryConditions) -> bool:
        if self.period_mode != "hard" or not c.years:
            return True
        return doc.period_year in c.years

    def _doctype_bonus(self, doc: IndexedDocument, c: QueryConditions) -> float:
        w = self.weights
        bonus = 0.0
        if c.doc_groups and doc.doc_group in c.doc_groups:
            bonus += w.doc_group
        if doc.doc_group == "periodic" and c.periodic_subtypes:
            if doc.doc_subtype in c.periodic_subtypes:
                bonus += w.doc_subtype
        elif doc.doc_group == "exchange" and c.exchange_subtypes:
            if doc.doc_subtype in c.exchange_subtypes:
                bonus += w.doc_subtype
        elif doc.doc_group == "major" and c.major_labels:
            if any(lbl in doc.major_label for lbl in c.major_labels):
                bonus += w.doc_subtype
        return bonus

    def _soft_condition_bonus(self, doc: IndexedDocument, c: QueryConditions) -> float:
        w = self.weights
        bonus = 0.0
        if self.corp_mode == "soft" and c.corps and (
                doc.corp_name in c.corps or doc.filer_name in c.corps):
            bonus += w.doc_group
        if self.period_mode == "soft" and c.years and doc.period_year in c.years:
            bonus += w.doc_subtype
        if c.correction and doc.is_correction:
            bonus += w.correction
        if c.corps and doc.filer_name in c.corps and doc.filer_name != doc.corp_name:
            bonus += w.filer
        return bonus

    # ---------- metadata 만점 ----------
    def _metadata_ceiling(self, c: QueryConditions, n_salient: int) -> float:
        """이 질문에서 metadata 점수가 가질 수 있는 최댓값.

        정규화 모드에서 metadata를 [0,1]로 맞추려면 분모가 필요하다. 조건이 몇 개
        걸렸는지는 질문마다 다르므로 질문별로 계산한다.
        """
        w = self.weights
        ceiling = 0.0
        if self.use_doctype_boost:
            if c.doc_groups:
                ceiling += w.doc_group
            if c.periodic_subtypes or c.exchange_subtypes or c.major_labels:
                ceiling += w.doc_subtype
        if n_salient:
            ceiling += w.salient_term * n_salient
        if self.corp_mode == "soft" and c.corps:
            ceiling += w.doc_group
        if self.period_mode == "soft" and c.years:
            ceiling += w.doc_subtype
        if c.correction:
            ceiling += w.correction
        if c.corps:
            ceiling += w.filer
        return ceiling

    # ---------- 검색 ----------
    def search(self, question: str, k: int = 10, *,
               conditions: QueryConditions | None = None) -> list[RetrievalHit]:
        c = conditions or extract_conditions(question, self.corp_dict)
        qt = tokenize(question)
        salient = self.salient_terms(c) if self.use_salient_boost else []
        w = self.weights

        # 1단계: BM25와 metadata를 **따로** 모은다. 합치는 방식은 score_mode가 정한다.
        raw: list[tuple[int, float, float, dict]] = []   # (idx, bm25, meta, parts)
        for i, doc in enumerate(self.documents):
            if not self._corp_ok(doc, c) or not self._period_ok(doc, c):
                continue
            bm25 = self._bm25.score(qt, i)
            parts: dict = {"bm25": round(bm25, 4)}
            meta = 0.0
            if self.use_doctype_boost:
                dt = self._doctype_bonus(doc, c)
                if dt:
                    parts["doctype"] = dt
                    meta += dt
            if salient:
                text = self._lower_texts[i]
                hits = [t for t in salient if t.lower() in text]
                if hits:
                    parts["salient"] = w.salient_term * len(hits)
                    parts["salient_terms"] = hits
                    meta += w.salient_term * len(hits)
            extra = self._soft_condition_bonus(doc, c)
            if extra:
                parts["condition"] = extra
                meta += extra
            if bm25 > 0 or meta > 0:
                raw.append((i, bm25, meta, parts))

        scored = self._combine(raw, c, len(salient))
        scored.sort(key=lambda x: (-x[0], self.documents[x[1]].doc_id))
        if self.chain_mode != "off":
            scored = self._expand_chain(scored, c)
            scored.sort(key=lambda x: (-x[0], self.documents[x[1]].doc_id))
        return [
            RetrievalHit(doc_id=self.documents[i].doc_id, rank=rank, score=round(s, 4),
                         components=parts, document=self.documents[i])
            for rank, (s, i, parts) in enumerate(scored[:k], start=1)
        ]

    # ---------- 점수 결합 ----------
    def _combine(self, raw: list[tuple[int, float, float, dict]],
                 c: QueryConditions, n_salient: int) -> list[tuple[float, int, dict]]:
        """BM25와 metadata를 하나의 점수로 합친다.

        `fixed`는 둘을 그냥 더한다 — 지금까지 쓰던 방식이고, BM25 점수 범위가
        질문마다 17~78로 달라지기 때문에 같은 상수 boost가 어떤 질문에서는 8%,
        어떤 질문에서는 34%로 작용한다(실측). 나머지 모드는 그 스케일 의존을 없앤다.
        """
        if not raw:
            return []
        w = self.weights
        mode = self.score_mode
        if mode == "fixed":
            return [(bm + meta, i, parts) for i, bm, meta, parts in raw]

        ceiling = self._metadata_ceiling(c, n_salient)
        bms = [bm for _, bm, _, _ in raw]
        lo, hi = min(bms), max(bms)

        if mode == "rrf":
            by_bm = sorted(range(len(raw)), key=lambda j: -raw[j][1])
            by_meta = sorted(range(len(raw)), key=lambda j: -raw[j][2])
            rank_bm = {j: r for r, j in enumerate(by_bm, start=1)}
            rank_meta = {j: r for r, j in enumerate(by_meta, start=1)}
            out = []
            for j, (i, bm, meta, parts) in enumerate(raw):
                score = 1.0 / (w.rrf_k + rank_bm[j])
                if ceiling > 0:
                    score += 1.0 / (w.rrf_k + rank_meta[j])
                parts = dict(parts)
                parts["rank_bm25"] = rank_bm[j]
                parts["rank_meta"] = rank_meta[j]
                out.append((score, i, parts))
            return out

        out = []
        for i, bm, meta, parts in raw:
            if mode == "minmax":
                nb = (bm - lo) / (hi - lo) if hi > lo else 1.0
            else:                                   # maxnorm
                nb = bm / hi if hi > 0 else 0.0
            nm = (meta / ceiling) if ceiling > 0 else 0.0
            alpha = w.metadata_alpha if ceiling > 0 else 0.0
            parts = dict(parts)
            parts["norm_bm25"] = round(nb, 4)
            parts["norm_meta"] = round(nm, 4)
            out.append(((1.0 - alpha) * nb + alpha * nm, i, parts))
        return out

    # ---------- 정정 chain 확장 ----------
    def _expand_chain(self, scored: list[tuple[float, int, dict]],
                      c: QueryConditions) -> list[tuple[float, int, dict]]:
        """정정 chain을 검색 결과에 반영한다.

        두 가지를 한다.
          1) 후보 확장(hop1 / chain) — 기본값은 **끄는 것**이다.
             Gold 25문항 실측: top-50 밖으로 빠진 anchor는 3건뿐이고 그중 정정
             링크로 닿는 것은 0건이었다. 정정 공시는 원공시 내용을 그대로 다시
             적기 때문에 BM25가 이미 chain 구성원을 한 덩어리로 올려놓는다.
             확장 문서는 seed 점수의 chain_inherit배를 물려받는데, 자기 점수가
             이미 그보다 높아서 순위가 바뀌지도 않는다. 실측상 이득 0, Q20에서
             회귀 1건이라 기본값에서 뺐다(뒤에 붙일 Evidence 단계에서 "이 사건의
             문서 전부"가 필요할 때 쓰라고 남겨 둔다).
          2) chain 내부 시간순 정렬(chain_recency) — 질문이 최신 상태를 물을 때만.
             이쪽은 후보를 늘리지 않고 같은 사건 안에서 순서만 바꾼다.

        기간 조건은 확장에 적용하지 않는다 — chain은 하나의 사건이 여러 해에 걸쳐
        정정된 것이라, 질문의 기간은 사건에 걸리지 문서 하나하나에 걸리지 않는다.
        기업 조건은 그대로 지킨다(chain 구성상 같은 기업이므로 실질 no-op).
        """
        w = self.weights
        links = self.links
        best: dict[int, tuple[float, dict]] = {}
        for score, i, parts in scored:
            best[i] = (score, parts)

        seeds = [self.documents[i].doc_id for _, i, _ in scored[:w.chain_seed_k]]
        seed_score = {self.documents[i].doc_id: sc for sc, i, _ in scored[:w.chain_seed_k]}
        touched_chains: set[str] = set()
        added: dict[int, tuple[float, dict]] = {}

        for sid in seeds:
            if self.chain_mode == "rank_only":
                related: list[str] = []
            elif self.chain_mode == "hop1":
                related = links.hop1(sid)
            else:
                related = links.chain(sid)
            root = links.root_of.get(sid)
            if root:
                touched_chains.add(root)
            inherited = seed_score[sid] * w.chain_inherit
            for rid in related:
                i = self._pos.get(rid)
                if i is None or rid == sid:
                    continue
                doc = self.documents[i]
                if not self._corp_ok(doc, c):
                    continue
                prev = best.get(i, added.get(i))
                if prev is not None and prev[0] >= inherited:
                    continue
                parts = dict(prev[1]) if prev else {"bm25": 0.0}
                parts["chain_from"] = sid
                parts["chain"] = round(inherited - (prev[0] if prev else 0.0), 4)
                added[i] = (inherited, parts)

        merged = dict(best)
        merged.update(added)

        if self.chain_recency and c.wants_latest and touched_chains:
            all_scores = [sc for sc, _ in merged.values()]
            span = (max(all_scores) - min(all_scores)) if len(all_scores) > 1 else 1.0
            recency_unit = w.chain_recency_span * span
            # "최신 유효 조건"을 묻는 질문에서만, chain 안에서 시간순 가산을 준다.
            # 최신이 곧 정답이라고 단정하지 않는다 — 동점 부근을 가르는 크기만 쓴다.
            for root in touched_chains:
                members = [m for m in links.members.get(root, ())
                           if self._pos.get(m) is not None]
                members.sort(key=lambda m: self.documents[self._pos[m]].rcept_dt)
                if len(members) < 2:
                    continue
                for order, mid in enumerate(members):
                    i = self._pos[mid]
                    if i not in merged:
                        continue
                    bonus = recency_unit * order / (len(members) - 1)
                    sc, parts = merged[i]
                    parts = dict(parts)
                    parts["recency"] = round(bonus, 4)
                    merged[i] = (sc + bonus, parts)

        return [(sc, i, parts) for i, (sc, parts) in merged.items()]

    def candidate_pool_size(self, conditions: QueryConditions) -> int:
        return sum(1 for d in self.documents
                   if self._corp_ok(d, conditions) and self._period_ok(d, conditions))


def _iter_jsonl(path: Path | str) -> Iterable[dict]:
    with Path(path).open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)
