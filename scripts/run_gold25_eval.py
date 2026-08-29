"""Gold 25문항 검색 전수 회귀 실행기 — 이후 실험의 공통 하니스.

지표 정의·집계는 `dart_corpus.evaluation.gold25`에 있다(실험 5-2에서 승격).
이 파일은 경로/설정을 붙여 실제 코퍼스로 돌리는 껍데기다.

    Stage 1  DocumentIndex  질문 -> top-k 문서 (기본 k=50, 고정)
    Stage 2  ChunkIndex     그 문서들 -> 청크 랭킹 (측정 대상)

실행:
    PYTHONIOENCODING=utf-8 python scripts/run_gold25_eval.py \
        --out experiments/gold25_retrieval/results_gold25_baseline.json

회귀 확인(이전 라운드 결과와 비교):
    python scripts/run_gold25_eval.py --baseline experiments/gold25_retrieval/results_gold25_baseline.json

대용량 입력(doc_index.jsonl 111MB, evidence_documents.jsonl 28MB)은 .gitignore된
experiments/ 아래에 있다. 없으면 어떤 스크립트로 만드는지 알려주고 종료한다.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from dart_corpus.evaluation.gold25 import (  # noqa: E402
    DEFAULT_STAGE1_K, KS, aggregate, load_gold_evidence, load_gold_questions, run_gold25,
)
from dart_corpus.retrieval import CorpDictionary, DocumentIndex, extract_conditions  # noqa: E402
from dart_corpus.retrieval.chunk_index import load_documents  # noqa: E402

EXP = REPO / "experiments" / "gold25_retrieval"
DEFAULTS = {
    # 질문 25문항은 리포에 있다(experiments/가 통째로 ignore라 그쪽 사본은 유실된다).
    "gold": REPO / "data" / "eval" / "gold25.jsonl",
    "evidence_gold": REPO / "check" / "seed-evidence-semantic-link-review.v0.1.jsonl",
    # 대용량 파생물은 로컬에서 만든다 — 커밋하지 않는다.
    "doc_index": EXP / "doc_index.jsonl",
    "evidence_docs": EXP / "evidence_documents.jsonl",
}
HOW_TO_BUILD = {
    "gold": "리포에 있어야 한다 — data/eval/gold25.jsonl",
    "evidence_gold": "check/ 아래 evidence 리뷰 산출물(팀 공유본)",
    "doc_index": "python scripts/build_retrieval_doc_index.py",
    "evidence_docs": "python scripts/extract_evidence_documents.py",
}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="gold25 검색 전수 회귀")
    for key, path in DEFAULTS.items():
        p.add_argument(f"--{key.replace('_', '-')}", type=Path, default=path)
    p.add_argument("--strategy", default="line_window")
    p.add_argument("--section-alpha", type=float, default=0.5)
    p.add_argument("--row-alpha", type=float, default=0.5)
    p.add_argument("--context-mode", default="off",
                   choices=("off", "title", "title_unit", "full"))
    p.add_argument("--stage1-k", type=int, default=DEFAULT_STAGE1_K)
    p.add_argument("--qids", default="", help="쉼표로 구분한 부분집합(진단용). 비우면 25문항 전수")
    p.add_argument("--label", default="", help="결과 JSON에 남길 실행 이름")
    p.add_argument("--out", type=Path, default=None)
    p.add_argument("--baseline", type=Path, default=None,
                   help="이전 결과 JSON. summary를 비교해 회귀 여부를 판정한다")
    return p.parse_args(argv)


def missing_inputs(args: argparse.Namespace) -> list[str]:
    return [key for key in DEFAULTS if not getattr(args, key).exists()]


def label_of(args: argparse.Namespace) -> str:
    if args.label:
        return args.label
    name = args.strategy
    if args.section_alpha:
        name += f"+section{args.section_alpha}"
    if args.row_alpha:
        name += f"+row{args.row_alpha}"
    if args.context_mode != "off":
        name += f"+ctx_{args.context_mode}"
    return name


def compare(summary: dict, baseline_path: Path) -> int:
    """이전 결과와 E-R@k를 비교한다. 하락이 하나라도 있으면 exit code 1."""
    prev = json.loads(baseline_path.read_text(encoding="utf-8"))["summary"]
    regressed = 0
    print(f"\n=== baseline: {baseline_path.name}")
    print(f"{'metric':28}{'baseline':>10}{'now':>10}{'delta':>10}")
    for k in KS:
        key = f"evidence_recall@{k}"
        if key not in prev:
            continue
        before, after = prev[key], summary[key]
        delta = round(after - before, 4)
        flag = "  REGRESSION" if delta < 0 else ""
        if delta < 0:
            regressed += 1
        print(f"{key:28}{before:>10.4f}{after:>10.4f}{delta:>+10.4f}{flag}")
    return 1 if regressed else 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    missing = missing_inputs(args)
    if missing:
        for key in missing:
            print(f"입력 없음: {getattr(args, key)}\n  만드는 법: {HOW_TO_BUILD[key]}",
                  file=sys.stderr)
        return 2

    corp_dict = CorpDictionary.from_universe_csv(
        sorted((REPO / "data").rglob("universe.csv"))[0])
    questions = load_gold_questions(args.gold)
    if args.qids:
        wanted = {q.strip() for q in args.qids.split(",") if q.strip()}
        questions = [q for q in questions if q.qid in wanted]
    gold_ev = load_gold_evidence(args.evidence_gold)

    stage1 = DocumentIndex.from_jsonl(args.doc_index, corp_dict)
    docs_by_id = {d["doc_id"]: d for d in load_documents(args.evidence_docs)}
    print(f"stage1 docs={len(stage1.documents)}  evidence docs cached={len(docs_by_id)}",
          flush=True)

    def stage1_docs(question: str) -> list[str]:
        cond = extract_conditions(question, corp_dict)
        return [h.doc_id for h in stage1.search(question, k=args.stage1_k,
                                                conditions=cond)]

    results = run_gold25(
        questions, gold_ev, stage1_docs=stage1_docs, docs_by_id=docs_by_id,
        strategy=args.strategy, section_alpha=args.section_alpha,
        row_alpha=args.row_alpha, context_mode=args.context_mode,
        progress=lambda line: print(f"  {line}", flush=True),
    )
    summary = aggregate(results)
    name = label_of(args)
    print(f"\n{name}")
    for k in KS:
        print(f"  evidence_recall@{k:<3} {summary[f'evidence_recall@{k}']:.4f}")
    print(f"  doc_ceiling@20    {summary['doc_ceiling@20']:.4f}  "
          f"(n_evidence={summary['n_evidence']}, n_questions={summary['n_questions']})")

    payload = {
        "label": name,
        "config": {"strategy": args.strategy, "section_alpha": args.section_alpha,
                   "row_alpha": args.row_alpha, "context_mode": args.context_mode,
                   "stage1_k": args.stage1_k},
        "summary": summary,
        "per_question": {r.qid: r.metrics() for r in results},
    }
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        print(f"\n-> {args.out}")
    return compare(summary, args.baseline) if args.baseline else 0


if __name__ == "__main__":
    sys.exit(main())
