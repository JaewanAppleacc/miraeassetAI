#!/usr/bin/env python3
"""Run the existing scorer through a sensitivity-only resolution adapter.

The scorer package and original result/run files remain unchanged. This wrapper
patches only the in-memory resolution loader/adjudication plan for the current
process so SUPPORTED_ALTERNATE_NODE can preserve evidence without becoming an
official vFINAL resolution class.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Mapping


ALLOWED = {
    "SUPPORTED_ALTERNATE_NODE",
    "ARM_SPECIFIC_CRITICAL",
    "ARM_SPECIFIC_NON_CRITICAL",
    "UNKNOWN",
}


def load_sensitivity_resolutions(path: Path | str) -> dict[str, dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("owner_confirmed") is not True:
        raise ValueError("sensitivity decisions must carry owner_confirmed=true")
    rows = data.get("resolutions")
    if not isinstance(rows, dict):
        raise ValueError("sensitivity decisions resolutions must be an object")
    out: dict[str, dict] = {}
    for packet_id, row in rows.items():
        outcome = str((row or {}).get("sensitivity_outcome") or "")
        if outcome not in ALLOWED:
            raise ValueError(f"invalid sensitivity outcome for {packet_id}: {outcome!r}")
        out[packet_id] = {"sensitivity_outcome": outcome}
    return out


def sensitivity_adjudication_plan(
    fourarm: Any,
    reports: Mapping[str, dict],
    resolutions: Mapping[str, dict],
    n_set: int,
) -> dict[str, Any]:
    per_arm_invalid: dict[str, dict[tuple[str, str], set]] = {}
    per_arm_critical: dict[str, list[str]] = {}
    unknown_per_arm: dict[str, int] = {}
    supported_per_arm: dict[str, list[str]] = {}
    for arm, report in reports.items():
        for violation in report["violations"]["items"]:
            if violation["severity"] != "unresolved":
                continue
            packet_id = fourarm.packet_id_of(violation)
            outcome = (resolutions.get(packet_id) or {}).get("sensitivity_outcome", "UNKNOWN")
            if outcome == "SUPPORTED_ALTERNATE_NODE":
                supported_per_arm.setdefault(arm, []).append(packet_id)
            elif outcome in {"ARM_SPECIFIC_CRITICAL", "ARM_SPECIFIC_NON_CRITICAL"}:
                key = (violation["question_id"], violation["slot_name"])
                per_arm_invalid.setdefault(arm, {}).setdefault(key, set()).add(
                    (str(violation["doc_id"]), int(violation["node_index"] if violation["node_index"] is not None else -1))
                )
                if outcome == "ARM_SPECIFIC_CRITICAL":
                    per_arm_critical.setdefault(arm, []).append(packet_id)
            else:
                unknown_per_arm[arm] = unknown_per_arm.get(arm, 0) + 1
    return {
        "common_qids": [],
        "limit": fourarm.common_exclusion_limit(n_set),
        "over_limit": False,
        "per_arm_invalid": {
            arm: {key: frozenset(values) for key, values in slots.items()}
            for arm, slots in per_arm_invalid.items()
        },
        "per_arm_critical": per_arm_critical,
        "unknown_per_arm": unknown_per_arm,
        "supported_alternate_node_per_arm": supported_per_arm,
        "sensitivity_only": True,
    }


def mark_supported_alternate_nodes(fourarm: Any, report: dict, resolutions: Mapping[str, dict]) -> dict:
    """Turn accepted duplicate-node violations into sensitivity-only minor records.

    The original score report object is not reused outside this sensitivity
    process, but deepcopy keeps this helper side-effect free for callers/tests.
    """
    out = copy.deepcopy(report)
    items = out.get("violations", {}).get("items", [])
    supported = 0
    for item in items:
        if item.get("severity") != "unresolved":
            continue
        packet_id = fourarm.packet_id_of(item)
        outcome = (resolutions.get(packet_id) or {}).get("sensitivity_outcome")
        if outcome == "SUPPORTED_ALTERNATE_NODE":
            item["severity"] = "minor"
            item["reason"] = "supported_alternate_node_sensitivity"
            supported += 1
    for severity in ("critical", "minor", "unresolved", "coarse"):
        out["violations"][severity] = sum(1 for item in items if item.get("severity") == severity)
    out["violations"]["supported_alternate_node_sensitivity"] = supported
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scorer-root", type=Path, required=True)
    parser.add_argument("--decisions", type=Path, required=True)
    parser.add_argument("scorer_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    scorer_args = args.scorer_args[1:] if args.scorer_args[:1] == ["--"] else args.scorer_args

    scorer_root = args.scorer_root.resolve()
    sys.path.insert(0, str(scorer_root / "src"))
    score_path = scorer_root / "scripts" / "fourarm" / "score.py"
    spec = importlib.util.spec_from_file_location("fourarm_sensitivity_score_cli", score_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import scorer CLI: {score_path}")
    score_cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(score_cli)
    fourarm = score_cli.fourarm
    decisions_path = args.decisions.resolve()
    sensitivity_resolutions = load_sensitivity_resolutions(decisions_path)
    fourarm.load_resolutions = lambda _path: sensitivity_resolutions
    fourarm.adjudication_plan = lambda reports, resolutions, n_set: sensitivity_adjudication_plan(
        fourarm, reports, resolutions, n_set
    )
    original_score_arm = fourarm.score_arm
    fourarm.score_arm = lambda *score_args, **score_kwargs: mark_supported_alternate_nodes(
        fourarm,
        original_score_arm(*score_args, **score_kwargs),
        sensitivity_resolutions,
    )
    return int(score_cli.main(scorer_args))


if __name__ == "__main__":
    raise SystemExit(main())
