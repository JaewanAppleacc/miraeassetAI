"""A-REMEDIATION-REPLAY-CONTRACT-V2 — locator compatibility view.

Translates a hydrated results.jsonl (real `text`, real `provenance.candidates[]` for
multi-node-ambiguous items, `node_index: null`) into a view the EXISTING, UNMODIFIED
`scripts/fourarm/score.py` / `src/dart_corpus/evaluation/fourarm.py` can score without
crashing -- neither of those files is touched by this script.

Contract (see docs/A_REMEDIATION_REPLAY_CONTRACT_V2_AMENDMENT.md §3 -- fixed before any
result was seen):
  - Full node union preserved: node_index (if not null) UNION node_indices (if present)
    UNION every provenance.candidates[].node_index (if a provenance block is present).
    Never reduced to "the first node."
  - view.node_index = min(union) (a deterministic representative the existing scorer's
    scalar-typed field can hold); view.node_indices = sorted(union) IN FULL, so
    `_result_nodes()`'s `{node_index} | set(node_indices)` recovers the complete original
    union regardless of which element became the representative. No candidate dropped.
  - row/col passed through only if every candidate in the union agrees on the same
    (row, col); otherwise both null (matches the scorer's own "coarse" category, never a
    fabricated single value).
  - Fail-closed for the WHOLE run (writes nothing) if any candidate's node_id belongs to a
    different doc_id than the item's own doc_id, or if the resolved union is empty for an
    item that had a provenance block or node reference at all.
  - Items with a normal (non-ambiguous) node_index and no provenance block pass through
    with node_index/node_indices exactly as they already were -- no ambiguity to resolve.

Usage:
    python3 scripts/a-remediation-locator-compat-view.py --in <hydrated.jsonl> --out <path>
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

NODE_ID_RE = re.compile(r"^(.*)::[^:]+::n(\d+)$")


def node_id_doc(node_id: str) -> str | None:
    m = NODE_ID_RE.match(node_id or "")
    return m.group(1) if m else None


def resolve_item(item: dict, question_id: str) -> tuple[dict, str | None]:
    """Returns (transformed_item, failure_reason_or_None)."""
    doc_id = item.get("doc_id")
    union: set[int] = set()
    if item.get("node_index") is not None:
        union.add(int(item["node_index"]))
    for n in item.get("node_indices") or []:
        union.add(int(n))

    provenance = item.get("provenance") or {}
    candidates = provenance.get("candidates") or []
    rowcols: set[tuple] = set()
    had_candidates = bool(candidates)
    for c in candidates:
        cdoc = node_id_doc(c.get("node_id") or "")
        if cdoc is not None and cdoc != doc_id:
            return item, (
                f"document_id_mismatch: candidate node_id={c.get('node_id')} "
                f"implies doc={cdoc} but item.doc_id={doc_id}"
            )
        if c.get("node_index") is not None:
            union.add(int(c["node_index"]))
        rowcols.add((c.get("row_start"), c.get("col_start"), c.get("row_end"), c.get("col_end")))

    if had_candidates and not union:
        return item, "empty_node_union_with_provenance_present"
    if not had_candidates and item.get("node_index") is None and not (item.get("node_indices") or []):
        return item, "empty_node_union_no_provenance_no_node_index"

    out = dict(item)
    out["node_index"] = min(union) if union else item.get("node_index")
    out["node_indices"] = sorted(union) if union else (item.get("node_indices") or [])

    if had_candidates:
        if len(rowcols) == 1:
            (rs, cs, re_, ce) = next(iter(rowcols))
            out["row"] = rs if rs is not None and rs == re_ else out.get("row")
            out["col"] = cs if cs is not None and cs == ce else out.get("col")
        else:
            out["row"] = None
            out["col"] = None
        out["_compat_view_note"] = {
            "original_node_index": item.get("node_index"),
            "original_locator_status": item.get("locator_status"),
            "resolved_node_union": sorted(union),
            "candidate_count": len(candidates),
        }
    return out, None


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="in_path", type=Path, required=True)
    p.add_argument("--out", dest="out_path", type=Path, required=True)
    args = p.parse_args()

    rows = [json.loads(l) for l in args.in_path.open(encoding="utf-8") if l.strip()]
    out_rows = []
    failures = []
    for row in rows:
        qid = row.get("question_id")
        new_results = []
        for item in row.get("results") or []:
            transformed, failure = resolve_item(item, qid)
            if failure:
                failures.append({"question_id": qid, "chunk_id": item.get("chunk_id"), "reason": failure})
                continue
            new_results.append(transformed)
        out_rows.append({**row, "results": new_results})

    if failures:
        print(json.dumps({"status": "BLOCKED_CONTRACT", "reason": "locator compat view fail-closed",
                          "failures": failures[:20], "n_failures": len(failures)},
                         ensure_ascii=False, indent=1))
        return 1

    args.out_path.parent.mkdir(parents=True, exist_ok=True)
    with args.out_path.open("w", encoding="utf-8") as f:
        for row in out_rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    n_items = sum(len(r["results"]) for r in out_rows)
    n_resolved = sum(1 for r in out_rows for it in r["results"] if "_compat_view_note" in it)
    print(json.dumps({"status": "OK", "n_questions": len(out_rows), "n_items": n_items,
                      "n_multi_node_resolved": n_resolved}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
