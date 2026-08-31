"""실험 2번 — 청크당 인용 줄 수(LINES_PER_CHUNK) 2/3/4 스윕. LLM 호출 0회.

배경: 24문항 잔여 미스 5건(N02·N07·N08·N09·N18)이 전부 같은 원인 — 셋째 값이
안 실린다. 늘리면 그 5건이 잡히지만 관련 없는 줄이 딸려올 수 있다. 세 자로 잰다:
새 24문항 근거 / gold25 근거 커버리지. (검색 코드는 안 건드리므로 회귀는 상수 무관)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

from dart_corpus.evaluation.gold25 import load_gold_evidence, load_gold_questions  # noqa: E402
from dart_detective.agents import qa_agent  # noqa: E402
from dart_detective.corpus_retriever import CorpusRetriever  # noqa: E402

NEWQ = REPO / "experiments" / "newq"
VALUES = (2, 3, 4)


def measure_new24(retriever) -> tuple[int, int]:
    rows = [json.loads(l) for l in (NEWQ / "new_questions.jsonl").open(encoding="utf-8")
            if l.strip()]
    hit = tot = 0
    for r in rows:
        if not r["expect"]:
            continue
        state = qa_agent.answer_question(r["question"], retriever)
        blob = "\n".join(m.evidence_text for m in state.evidence_matches)
        hit += sum(1 for e in r["expect"] if e in blob)
        tot += len(r["expect"])
    return hit, tot


def measure_gold25(retriever) -> tuple[int, int]:
    gold_ev = load_gold_evidence(REPO / "check" / "seed-evidence-semantic-link-review.v0.1.jsonl")
    hit = tot = 0
    for q in load_gold_questions(REPO / "data" / "eval" / "gold25.jsonl"):
        state = qa_agent.answer_question(q.question, retriever)
        blob = "\n".join(m.evidence_text for m in state.evidence_matches)
        gold = gold_ev.get(q.qid, [])
        hit += sum(1 for e in gold if e.quote and e.quote in blob)
        tot += len(gold)
    return hit, tot


def main() -> int:
    newq_ret = CorpusRetriever.from_paths(
        REPO / "experiments" / "gold25_retrieval" / "doc_index.jsonl",
        NEWQ / "candidate_documents.jsonl",
        sorted((REPO / "data").rglob("universe.csv"))[0])
    gold_ret = CorpusRetriever.from_paths(
        REPO / "experiments" / "gold25_retrieval" / "doc_index.jsonl",
        REPO / "experiments" / "gold25_retrieval" / "evidence_documents.jsonl",
        sorted((REPO / "data").rglob("universe.csv"))[0])

    out = {}
    original = qa_agent.LINES_PER_CHUNK
    for v in VALUES:
        qa_agent.LINES_PER_CHUNK = v
        n_hit, n_tot = measure_new24(newq_ret)
        g_hit, g_tot = measure_gold25(gold_ret)
        out[v] = {"new24": f"{n_hit}/{n_tot}", "gold25": f"{g_hit}/{g_tot}"}
        print(f"LINES_PER_CHUNK={v}  new24={n_hit}/{n_tot}  gold25={g_hit}/{g_tot}",
              flush=True)
    qa_agent.LINES_PER_CHUNK = original

    (NEWQ / "lines_per_chunk_sweep.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
