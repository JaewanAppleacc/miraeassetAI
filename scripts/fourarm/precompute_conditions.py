"""4-arm 공통 입력 — DEV_TUNE 101 질문의 검색 조건을 사전 계산해 SHA로 고정한다.

vFINAL 1번(conditions.py 단일 사용 · 실행 전 결과·SHA 고정 · arm별 재계산 금지)과
20번(메타 필터 입력은 질문 텍스트에서 사전 추출한 조건만 · Gold 유래 정보 사용 금지)의 근거 파일.

이 스크립트는 Gold 행에서 **question_id와 question만** 읽는다. gold_document_ids·corp_codes·
doc_groups·required_evidence_slots는 읽지 않는다(non-leak). 조건 추출은 B/D 스택이 런타임에 쓰는
`CorpusRetriever.conditions`(= dart_corpus.retrieval.conditions.extract_conditions + 하이픈 날짜 연도
보정)를 그대로 부른다 — 파일과 런타임이 같은 함수를 지난다.

출력 (interfaces.md §1-2):
    data/eval/devtune101_conditions.v1.jsonl   문항당 1줄 {question_id, question, segment,
                                               n_hard_conditions, conditions}
    data/eval/devtune101_conditions.v1.meta.json  입력 SHA(gold·universe)·코드 HEAD·세그먼트 분포·출력 SHA

실행:
    PYTHONIOENCODING=utf-8 .venv/bin/python scripts/fourarm/precompute_conditions.py
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

from dart_corpus.retrieval.segments import hard_condition_count, segment_of  # noqa: E402
from dart_detective.retriever_adapter import build_line_window_retriever  # noqa: E402

VERSION = "v2"
ALLOWED_GOLD_FIELDS = ("question_id", "question")     # non-leak: 이 둘 외에는 읽지 않는다


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_head() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="DEV_TUNE 101 조건 사전 계산")
    p.add_argument("--gold", type=Path, default=REPO / "data" / "eval" / "phase1_devtune_gold.v0.1.jsonl")
    p.add_argument("--out", type=Path,
                   default=REPO / "data" / "eval" / f"devtune101_conditions.{VERSION}.jsonl")
    args = p.parse_args(argv)

    rows = []
    with args.gold.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                g = json.loads(line)
                rows.append({k: g[k] for k in ALLOWED_GOLD_FIELDS})     # 나머지 필드는 여기서 버린다

    t0 = time.perf_counter()
    retriever, store = build_line_window_retriever()
    universe_path = REPO / "data" / "corpus" / "universe.csv"

    out_rows = []
    for r in rows:
        cond = retriever.conditions(r["question"])
        out_rows.append({
            "question_id": r["question_id"],
            "question": r["question"],
            "segment": segment_of(cond),
            "n_hard_conditions": hard_condition_count(cond),
            "conditions": cond.as_dict(),
        })
    store.close()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        for row in out_rows:
            f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")

    seg = collections.Counter(r["segment"] for r in out_rows)
    n_hard = collections.Counter(r["n_hard_conditions"] for r in out_rows)
    no_corp = [r["question_id"] for r in out_rows if not r["conditions"]["corps"]]
    meta = {
        "version": VERSION,
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "n_questions": len(out_rows),
        "gold_sha256": sha256_of(args.gold),
        "universe_sha256": sha256_of(universe_path),
        "code_head": git_head(),
        "extractor": "dart_detective.corpus_retriever.CorpusRetriever.conditions "
                     "(dart_corpus.retrieval.conditions.extract_conditions + question_dates 연도 보정)",
        "segment_rule": "dart_corpus.retrieval.segments.hard_condition_count: "
                        "len(corps) + [years|year_months] + [doc_groups|periodic_subtypes|exchange_subtypes|major_labels]; LOW = <=2",
        "segments": dict(seg),
        "n_hard_conditions_hist": {str(k): v for k, v in sorted(n_hard.items())},
        "n_without_corp": len(no_corp),
        "without_corp_question_ids": no_corp,
        "output_sha256": sha256_of(args.out),
        "elapsed_s": round(time.perf_counter() - t0, 1),
    }
    meta_path = args.out.with_suffix(".meta.json")
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
