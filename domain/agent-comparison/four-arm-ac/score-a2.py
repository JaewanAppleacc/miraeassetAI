#!/usr/bin/env python3
"""Turn A2-DOCUMENTIR-NODESTORE-V1.1, Section 6: score A2 using the frozen,
patched scorer's own `fourarm.score_arm()` -- the exact function
`scripts/fourarm/score.py` calls per arm -- WITHOUT modifying score.py or
fourarm.py in any way (score.py's own CLI restricts --arms to A/B/C/D only,
so this is a separate, additive invocation script, not a patch to either
frozen file).

No personal absolute path is hardcoded (CLAUDE.md). Every real-data
location is read from an environment variable:

  FOURARM_SCORER_SRC_DIR   the scorer's `src/` directory (containing
                           `dart_corpus/evaluation/fourarm.py`, the exact
                           SHA-256-pinned patched module -- verified below,
                           never modified)
  FOURARM_SCORER_DATA_DIR  the scorer's `data/` directory (containing
                           `eval/phase1_devtune_gold.v0.1.jsonl`,
                           `eval/devtune101_conditions.v2.jsonl`, `index/`)
  A2_RESULTS_DIR           this worktree's own
                           domain/agent-comparison/four-arm-ac/results
                           (default: alongside this script)

Reads Gold (required for scoring -- this is the one script in this turn
that legitimately opens it, only after A2's results are already frozen and
written). Writes only `score.A2.json` into A2_RESULTS_DIR; never touches
score.py, fourarm.py, or any other arm's results/score file.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

EXPECTED_FOURARM_PY_SHA256 = "4a717350d697ebac343f80d61bd335e98519dd2884a169316af1284740f9b804"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    src_dir = os.environ.get("FOURARM_SCORER_SRC_DIR")
    data_dir = os.environ.get("FOURARM_SCORER_DATA_DIR")
    if not src_dir or not data_dir:
        print("FOURARM_SCORER_SRC_DIR and FOURARM_SCORER_DATA_DIR must both be set -- refusing to run.", file=sys.stderr)
        return 1

    src_path = Path(src_dir)
    fourarm_py = src_path / "dart_corpus" / "evaluation" / "fourarm.py"
    actual_sha = sha256_of(fourarm_py)
    if actual_sha != EXPECTED_FOURARM_PY_SHA256:
        print(f"SCORER_SHA_MISMATCH: {fourarm_py} sha256={actual_sha}, expected {EXPECTED_FOURARM_PY_SHA256}. "
              "Refusing to score with an unverified scorer -- BLOCKED_CONTRACT.", file=sys.stderr)
        return 1

    sys.path.insert(0, str(src_path))
    from dart_corpus.evaluation import fourarm  # noqa: E402
    from dart_corpus.retrieval.node_store import NodeStore  # noqa: E402

    data_path = Path(data_dir)
    gold_path = data_path / "eval" / "phase1_devtune_gold.v0.1.jsonl"
    conditions_path = data_path / "eval" / "devtune101_conditions.v2.jsonl"
    index_dir = data_path / "index"

    a2_results_dir = Path(os.environ.get("A2_RESULTS_DIR") or (Path(__file__).resolve().parent / "results"))
    a2_results_path = a2_results_dir / "A2.results.jsonl"
    a2_run_path = a2_results_dir / "A2.run.json"

    gold = fourarm.load_gold(gold_path)
    segments = fourarm.load_segments(conditions_path)
    gold_sha = sha256_of(gold_path)
    cond_sha = sha256_of(conditions_path)

    results = fourarm.load_results(a2_results_path)
    run = json.loads(a2_run_path.read_text(encoding="utf-8"))
    # A2.run.json's own input_sha256.conditions is this worktree's copy of
    # devtune101_conditions.v2.jsonl, already verified byte-identical to the
    # scorer's own copy (same SHA-256) before this script runs.

    store = NodeStore(index_dir)
    try:
        report = fourarm.score_arm(
            "A2", results, gold, segments, run=run, store=store,
            conditions_sha=cond_sha, gold_sha=gold_sha,
        )
    finally:
        store.close()

    out_path = a2_results_dir / "score.A2.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    print(json.dumps({
        "n_questions": report["n_questions"],
        "n_excluded_zero_slot": report["n_excluded_zero_slot"],
        "n_missing_or_error": report["n_missing_or_error"],
        "locator_checked": report["locator_checked"],
        "violations": {k: v for k, v in report["violations"].items() if k != "items"},
        "segments": {
            seg: {k: v for k, v in vals.items() if k.startswith("recall@") or k.startswith("all_found") or k == "questions" or k == "slots_total"}
            for seg, vals in report["segments"].items()
        },
        "pins": report["pins"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
