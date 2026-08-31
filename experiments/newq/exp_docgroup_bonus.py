"""실험 4번 — 항목 질문일 때 원문 공시(exchange/major) 조각 가산. LLM 호출 0회.

배경(N05): 사업보고서의 요약 한 줄(233자)이 실제 공시 원문(671자)을 BM25 길이
정규화로 이겼다. 계약금액·투자금액 같은 항목 질문의 답은 원문 공시 서식에 있다.

방법: 질문에 공시 항목이 잡히면 exchange/major 조각 점수에 (1+beta) 배.
production 무변경 — 여기서 재정렬만 하고 세 자로 판정한다.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

from dart_corpus.evaluation.gold25 import (  # noqa: E402
    KS, aggregate, load_gold_evidence, load_gold_questions, norm, score_question)
from dart_corpus.retrieval import CorpDictionary, DocumentIndex, extract_conditions  # noqa: E402
from dart_corpus.retrieval.chunk_index import ChunkIndex, load_documents  # noqa: E402
from dart_detective.agents.qa_agent import extract_disclosure_items  # noqa: E402

EXP = REPO / "experiments" / "gold25_retrieval"
NEWQ = REPO / "experiments" / "newq"
BETAS = (0.0, 0.15, 0.3, 0.5)
PRIMARY_GROUPS = ("exchange", "major")


def reranked(hits, beta, active):
    if not beta or not active:
        return list(hits)
    scored = [(s * (1.0 + beta) if c.doc_group in PRIMARY_GROUPS else s, c)
              for s, c in hits]
    return sorted(scored, key=lambda x: -x[0])


def main() -> int:
    corp_dict = CorpDictionary.from_universe_csv(
        sorted((REPO / "data").rglob("universe.csv"))[0])
    stage1 = DocumentIndex.from_jsonl(EXP / "doc_index.jsonl", corp_dict)
    gold_docs = {d["doc_id"]: d for d in load_documents(EXP / "evidence_documents.jsonl")}
    new_docs = {d["doc_id"]: d for d in load_documents(NEWQ / "candidate_documents.jsonl")}
    questions = load_gold_questions(REPO / "data" / "eval" / "gold25.jsonl")
    gold_ev = load_gold_evidence(REPO / "check" / "seed-evidence-semantic-link-review.v0.1.jsonl")
    newq = [json.loads(l) for l in (NEWQ / "new_questions.jsonl").open(encoding="utf-8")
            if l.strip() and json.loads(l)["expect"]]

    print("=== gold25 (문서 캐시 조건)", flush=True)
    gold_summary = {}
    per_beta = {b: [] for b in BETAS}
    for g in questions:
        evidences = list(gold_ev.get(g.qid, ()))
        if not evidences:
            continue
        cond = extract_conditions(g.question, corp_dict)
        docs = [h.doc_id for h in stage1.search(g.question, k=50, conditions=cond)]
        usable = [gold_docs[d] for d in docs if d in gold_docs]
        if not usable:
            continue
        index = ChunkIndex.from_documents(usable, strategy="line_window", context_mode="off")
        hits = index.search(g.question, k=max(len(index.chunks), max(KS)),
                            section_alpha=0.5, row_alpha=0.5)
        active = bool(extract_disclosure_items(g.question))
        for b in BETAS:
            texts = [norm(c.search_text) for _, c in reranked(hits, b, active)]
            per_beta[b].append(score_question(g.qid, evidences, texts, docs,
                                              n_chunks=len(index.chunks)))
    for b in BETAS:
        s = aggregate(per_beta[b])
        gold_summary[b] = {f"@{k}": s[f"evidence_recall@{k}"] for k in KS}
        print("  beta=%-5s " % b + " ".join(f"@{k}={s[f'evidence_recall@{k}']:.4f}"
                                            for k in KS), flush=True)

    print("\n=== 새 24문항 (상위20 적중)", flush=True)
    new_summary = {}
    for b in BETAS:
        hit = tot = 0
        n05 = None
        for r in newq:
            cond = extract_conditions(r["question"], corp_dict)
            docs = [h.doc_id for h in stage1.search(r["question"], k=50, conditions=cond)]
            usable = [new_docs[d] for d in docs if d in new_docs]
            if not usable:
                tot += len(r["expect"])
                continue
            index = ChunkIndex.from_documents(usable, strategy="line_window",
                                              context_mode="off")
            hits = index.search(r["question"], k=max(len(index.chunks), 20),
                                section_alpha=0.5, row_alpha=0.5)
            active = bool(extract_disclosure_items(r["question"]))
            top20 = "\n".join(c.search_text for _, c in reranked(hits, b, active)[:20])
            found = sum(1 for e in r["expect"] if e in top20)
            hit += found
            tot += len(r["expect"])
            if r["qid"] == "N05":
                n05 = f"{found}/{len(r['expect'])}"
        new_summary[b] = {"top20": f"{hit}/{tot}", "N05": n05}
        print(f"  beta=%-5s top20={hit}/{tot}  N05={n05}" % b, flush=True)

    (NEWQ / "docgroup_bonus_sweep.json").write_text(json.dumps(
        {"gold25": {str(b): gold_summary[b] for b in BETAS},
         "new24": {str(b): new_summary[b] for b in BETAS}},
        ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
