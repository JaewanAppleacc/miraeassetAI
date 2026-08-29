"""Gold 25문항 검색 전수 회귀 — 공통 평가 하니스.

`experiments/gold25_retrieval/run_evidence_retrieval_eval.py`(실험 5-2)의 지표
정의와 집계를 **그대로** 옮긴 것이다. experiments/ 전체가 .gitignore라 그 스크립트는
라운드마다 유실됐고, 그때마다 다시 쓰면 이전 라운드 수치와 비교할 수 없게 된다.
그래서 여기로 승격했다 — 지표 정의를 바꾸면 과거 수치가 전부 무의미해지므로 바꾸지 않는다.

측정 구조(2단계):

    Stage 1  질문 -> top-k 문서            (DocumentIndex, 기본 k=50)
    Stage 2  그 문서들 -> 청크 랭킹         (ChunkIndex, 측정 대상)

지표:
  evidence_recall@k        상위 k개 청크를 이어붙인 텍스트가 gold 인용 span을 그대로
                           포함하는 비율. evidence span 단위 micro-average(문항 평균 아님).
  evidence_recall@N chars  같은 계산을 "문자 예산 N자까지"로 자른 것. 청크 크기가
                           전략마다 달라 top-k만으로는 공정 비교가 안 되기 때문이다.
  doc_ceiling@20           evidence의 원문서가 Stage 1 결과에 들어온 비율 = Stage 2 상한.
                           (키 이름은 STAGE1_K=20 시절 그대로 둔다 — 과거 결과와 같은 키여야
                           비교가 된다. 실제 k는 stage1_k 인자를 따른다.)
  chunk_rank               gold 인용을 담은 첫 청크의 1-based 순위. 못 찾으면 None.
                           recall@k가 0/1로만 움직여 진단이 안 될 때 "얼마나 멀리 있나"를 본다.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence

from ..retrieval.chunk_index import DEFAULT_ROW_ALPHA, DEFAULT_SECTION_ALPHA, ChunkIndex

KS: tuple[int, ...] = (1, 3, 5, 10, 20)
CHAR_BUDGETS: tuple[int, ...] = (2000, 5000, 10000, 20000)
DEFAULT_STAGE1_K = 50           # 11차 채택 — k=20 대비 P1 19 -> 4, E-R@20 0.807 -> 0.879
DOC_CEILING_KEY = "doc_ceiling@20"
# 25문항 gold의 question_id -> qid. 두 파일(gold25.jsonl / evidence 리뷰)이 서로 다른
# 식별자를 쓰기 때문에 여기서 맞춘다.
QID_OF: dict[str, str] = {f"question_seed_v07_{i:02d}": f"Q{i:02d}" for i in range(1, 26)}


def norm(s: str) -> str:
    """공백만 정규화한다. 인용 span 대조는 글자 그대로 비교하므로 그 이상 건드리지 않는다."""
    return re.sub(r"\s+", " ", s or "").strip()


@dataclass(frozen=True)
class GoldQuestion:
    qid: str
    question: str
    anchors: tuple[str, ...] = ()
    raw: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class GoldEvidence:
    evidence_id: str
    document_id: str
    quote: str
    block_type: str | None = None


@dataclass(frozen=True)
class QuestionResult:
    """한 문항의 원시 카운트. 집계는 여기 담긴 카운트를 합쳐서 한다(비율 평균 아님)."""
    qid: str
    n_evidence: int
    n_chunks: int
    found_at_k: Mapping[int, int]
    found_at_budget: Mapping[int, int]
    doc_ceiling_hits: int
    chunk_ranks: Mapping[str, int | None]

    def metrics(self) -> dict[str, object]:
        n = self.n_evidence or 1
        out: dict[str, object] = {}
        for k, found in self.found_at_k.items():
            out[f"evidence_recall@{k}"] = round(found / n, 4)
        for b, found in self.found_at_budget.items():
            out[f"evidence_recall@{b}chars"] = round(found / n, 4)
        out[DOC_CEILING_KEY] = round(self.doc_ceiling_hits / n, 4)
        out["n_evidence"] = self.n_evidence
        out["n_chunks"] = self.n_chunks
        out["chunk_rank"] = dict(self.chunk_ranks)
        return out


def load_gold_questions(path: Path | str) -> list[GoldQuestion]:
    out: list[GoldQuestion] = []
    with Path(path).open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            r = json.loads(line)
            out.append(GoldQuestion(qid=r["qid"], question=r["question"],
                                    anchors=tuple(r.get("anchors") or ()), raw=r))
    return out


def load_gold_evidence(path: Path | str) -> dict[str, list[GoldEvidence]]:
    """evidence 리뷰 JSONL -> qid별 gold 인용 span."""
    out: dict[str, list[GoldEvidence]] = {}
    with Path(path).open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            r = json.loads(line)
            qid = QID_OF[r["question_id"]]
            out.setdefault(qid, []).append(GoldEvidence(
                evidence_id=r["evidence_id"],
                document_id=r["document_id"],
                quote=norm(r["quoted_text"]),
                block_type=(r.get("source_context") or {}).get("block_type"),
            ))
    return out


def evidence_chunk_rank(quote: str, ranked_texts: Sequence[str]) -> int | None:
    """인용을 통째로 담은 첫 청크의 1-based 순위. 없으면 None."""
    if not quote:
        return None
    for i, text in enumerate(ranked_texts, start=1):
        if quote in text:
            return i
    return None


def score_question(qid: str, evidences: Sequence[GoldEvidence],
                   ranked_texts: Sequence[str], top_doc_ids: Iterable[str], *,
                   n_chunks: int = 0, ks: Sequence[int] = KS,
                   char_budgets: Sequence[int] = CHAR_BUDGETS,
                   budget_pool: int | None = None) -> QuestionResult:
    """랭킹된 청크 텍스트에 대해 한 문항의 카운트를 낸다.

    recall은 상위 k개를 개행으로 이어붙인 blob에 대한 부분문자열 판정이다 — 청크 경계에
    걸린 인용도 맞힌 것으로 센다. 실험 5-2와 같은 규칙이다.

    budget_pool: 문자예산 지표가 훑는 청크 수 상한. 기본값 max(ks)=20은 실험 5-2를
    그대로 재현하기 위한 것이다 — 그쪽은 애초에 top-20만 랭킹했기 때문에 문자예산도
    20청크가 사실상의 상한이었다. 여기서 상한을 풀면 @20000chars가 올라가(0.9143 ->
    0.9357) 과거 라운드 수치와 비교가 끊긴다. 새 실험에서 상한을 바꾸고 싶으면 이 인자를
    명시적으로 올리고, 그 라운드의 baseline도 같이 다시 잡아야 한다.
    """
    in_top = set(top_doc_ids)
    found_at_k: dict[int, int] = {}
    for k in ks:
        blob = "\n".join(ranked_texts[:k])
        found_at_k[k] = sum(1 for e in evidences if e.quote and e.quote in blob)
    pool = ranked_texts[:budget_pool if budget_pool is not None else max(ks)]
    found_at_budget: dict[int, int] = {}
    for b in char_budgets:
        picked: list[str] = []
        used = 0
        for t in pool:
            if used + len(t) > b:
                break
            picked.append(t)
            used += len(t)
        joined = "\n".join(picked)
        found_at_budget[b] = sum(1 for e in evidences if e.quote and e.quote in joined)
    return QuestionResult(
        qid=qid,
        n_evidence=len(evidences),
        n_chunks=n_chunks,
        found_at_k=found_at_k,
        found_at_budget=found_at_budget,
        doc_ceiling_hits=sum(1 for e in evidences if e.document_id in in_top),
        chunk_ranks={e.evidence_id: evidence_chunk_rank(e.quote, ranked_texts)
                     for e in evidences},
    )


def aggregate(results: Sequence[QuestionResult], *, ks: Sequence[int] = KS,
              char_budgets: Sequence[int] = CHAR_BUDGETS) -> dict[str, object]:
    """evidence span 단위 micro-average. 문항별 비율의 평균이 아니다 —
    문항마다 evidence 개수가 달라(1~12건) 두 값이 다르게 나온다."""
    n_ev = sum(r.n_evidence for r in results)
    if not n_ev:
        return {"n_evidence": 0, "n_questions": len(results)}
    out: dict[str, object] = {}
    for k in ks:
        out[f"evidence_recall@{k}"] = round(
            sum(r.found_at_k.get(k, 0) for r in results) / n_ev, 4)
    for b in char_budgets:
        out[f"evidence_recall@{b}chars"] = round(
            sum(r.found_at_budget.get(b, 0) for r in results) / n_ev, 4)
    out[DOC_CEILING_KEY] = round(sum(r.doc_ceiling_hits for r in results) / n_ev, 4)
    out["n_evidence"] = n_ev
    out["n_questions"] = len(results)
    out["mean_chunks_per_question"] = round(
        sum(r.n_chunks for r in results) / len(results), 1)
    return out


def run_gold25(questions: Sequence[GoldQuestion],
               gold_evidence: Mapping[str, Sequence[GoldEvidence]], *,
               stage1_docs: Callable[[str], Sequence[str]],
               docs_by_id: Mapping[str, dict],
               strategy: str = "line_window",
               section_alpha: float = DEFAULT_SECTION_ALPHA,
               row_alpha: float = DEFAULT_ROW_ALPHA,
               context_mode: str = "off",
               ks: Sequence[int] = KS,
               char_budgets: Sequence[int] = CHAR_BUDGETS,
               budget_pool: int | None = None,
               rank_all: bool = True,
               progress: Callable[[str], None] | None = None) -> list[QuestionResult]:
    """25문항 전수 실행.

    stage1_docs: 질문 -> 순위대로 정렬된 doc_id. Stage 1을 주입으로 받는 이유는
    (a) 하니스 테스트를 111MB 인덱스 없이 돌리기 위해서고,
    (b) Stage 1을 고정한 채 Stage 2만 재는 실험 설계를 코드에 박아두기 위해서다.
    rank_all=True면 청크 전체를 랭킹해 chunk_rank를 끝까지 찾는다(top-k 결과는 동일).
    """
    results: list[QuestionResult] = []
    for g in questions:
        evidences = list(gold_evidence.get(g.qid, ()))
        if not evidences:
            continue
        top_docs = list(stage1_docs(g.question))
        usable = [docs_by_id[d] for d in top_docs if d in docs_by_id]
        index = ChunkIndex.from_documents(usable, strategy=strategy,
                                          context_mode=context_mode)
        k = len(index.chunks) if rank_all else max(ks)
        hits = index.search(g.question, k=max(k, max(ks)),
                            section_alpha=section_alpha, row_alpha=row_alpha)
        texts = [norm(c.search_text) for _, c in hits]
        result = score_question(g.qid, evidences, texts, top_docs,
                                n_chunks=len(index.chunks), ks=ks,
                                char_budgets=char_budgets, budget_pool=budget_pool)
        results.append(result)
        if progress:
            progress(f"{g.qid} n_ev={result.n_evidence} "
                     f"@20={result.found_at_k.get(20, 0)}/{result.n_evidence}")
    return results
