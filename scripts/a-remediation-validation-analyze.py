"""A-RETRIEVAL-REMEDIATION-VALIDATION-V1 — per-question diagnostic analysis.

Reuses `dart_corpus.evaluation.fourarm` (load_gold, slot_found) UNMODIFIED from the frozen
QA worktree via an absolute sys.path insert (read-only import, that worktree is never
written to). Computes, on top of what `scripts/fourarm/score.py --no-locator-check` already
reports (Recall@5/10/20, LOW all_found@10):

  - zero-result question count (both runs)
  - per-question improved/regressed/unchanged (found-count@10, control vs candidate)
  - date-anchored-question recovery count (question text contains a full day-level date,
    doc_groups in {exchange, major, holding}, control all_found@10=False -> candidate=True)
  - subtype-narrowed-question recovery count (conditions.exchange_subtypes or
    .periodic_subtypes non-empty, control all_found@10=False -> candidate=True)
  - correction-notice ("정정") presence change in top-20, using metadata.is_correction
    fetched from disclosure_reference.reference_retrieval_chunks for every chunk_id that
    appears in either run's results (diagnostic only, not a pass/fail gate)

Usage:
    python3 scripts/a-remediation-validation-analyze.py \
        --qa-root /Users/jaewan/Documents/Codex/worktrees/agent-a4-a3-plus-qa-final-v01 \
        --conditions work/a-remediation-review/../.. (see --conditions default) \
        --control work/a-remediation-review/control \
        --candidate work/a-remediation-review/candidate \
        --chunk-metadata work/a-remediation-review/chunk_metadata.json \
        --out work/a-remediation-review/analysis.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

DATE_RE = re.compile(
    r"(\d{4})[.\-년]\s?(\d{1,2})[.\-월]\s?(\d{1,2})일?"
)


def load_jsonl(path: Path) -> dict[str, dict]:
    out = {}
    for line in path.open(encoding="utf-8"):
        if not line.strip():
            continue
        row = json.loads(line)
        out[row["question_id"]] = row
    return out


def has_full_date(question: str) -> bool:
    return bool(DATE_RE.search(question or ""))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--qa-root", type=Path, required=True)
    p.add_argument("--conditions", type=Path, required=True)
    p.add_argument("--control", type=Path, required=True)
    p.add_argument("--candidate", type=Path, required=True)
    p.add_argument("--chunk-metadata", type=Path, default=None)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()

    sys.path.insert(0, str(args.qa_root / "src"))
    from dart_corpus.evaluation import fourarm  # noqa: E402

    gold = fourarm.load_gold(args.qa_root / "data" / "eval" / "phase1_devtune_gold.v0.1.jsonl")
    conditions_rows = [json.loads(l) for l in args.conditions.open(encoding="utf-8") if l.strip()]
    conditions_by_qid = {r["question_id"]: r for r in conditions_rows}

    control = load_jsonl(args.control / "A.results.jsonl")
    candidate = load_jsonl(args.candidate / "A.results.jsonl")

    chunk_meta = {}
    if args.chunk_metadata and args.chunk_metadata.exists():
        chunk_meta = json.loads(args.chunk_metadata.read_text(encoding="utf-8"))

    K = 10
    zero_result = {"control": 0, "candidate": 0}
    improved, regressed, unchanged = [], [], []
    date_recovered, subtype_recovered = [], []
    per_question = []
    correction_count = {"control": 0, "candidate": 0}

    for qid, gq in gold.items():
        crec = control.get(qid)
        drec = candidate.get(qid)
        cresults = (crec or {}).get("results") or []
        dresults = (drec or {}).get("results") or []
        if not cresults:
            zero_result["control"] += 1
        if not dresults:
            zero_result["candidate"] += 1

        def found_count(results):
            n = 0
            for slot in gq.slots:
                ok, *_ = fourarm.slot_found(slot, results, K, frozenset(), None)
                n += int(ok)
            return n

        c_found = found_count(cresults)
        d_found = found_count(dresults)
        c_all_found = len(gq.slots) > 0 and c_found == len(gq.slots)
        d_all_found = len(gq.slots) > 0 and d_found == len(gq.slots)

        row = {"question_id": qid, "n_slots": len(gq.slots),
               "control_found_at_10": c_found, "candidate_found_at_10": d_found,
               "control_all_found_at_10": c_all_found, "candidate_all_found_at_10": d_all_found}
        per_question.append(row)

        if d_found > c_found:
            improved.append(qid)
        elif d_found < c_found:
            regressed.append(qid)
        else:
            unchanged.append(qid)

        cond_row = conditions_by_qid.get(qid) or {}
        cond = cond_row.get("conditions") or {}
        question_text = cond_row.get("question") or ""
        recovered = (not c_all_found) and d_all_found
        if recovered and has_full_date(question_text) and \
           set(cond.get("doc_groups") or []) & {"exchange", "major", "holding"}:
            date_recovered.append(qid)
        if recovered and (cond.get("exchange_subtypes") or cond.get("periodic_subtypes")):
            subtype_recovered.append(qid)

        for label, results in (("control", cresults), ("candidate", dresults)):
            for item in results[:20]:
                meta = chunk_meta.get(item.get("chunk_id") or "")
                if meta and meta.get("is_correction"):
                    correction_count[label] += 1

    out = {
        "n_questions": len(gold),
        "zero_result": zero_result,
        "improved_count": len(improved), "regressed_count": len(regressed),
        "unchanged_count": len(unchanged),
        "improved_question_ids": improved, "regressed_question_ids": regressed,
        "date_anchored_recovery_count": len(date_recovered),
        "date_anchored_recovery_question_ids": date_recovered,
        "subtype_narrowed_recovery_count": len(subtype_recovered),
        "subtype_narrowed_recovery_question_ids": subtype_recovered,
        "correction_notice_chunk_count_top20": correction_count,
        "per_question": per_question,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in out.items() if k != "per_question"}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
