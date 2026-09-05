import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "p11f0-fourarm-alternate-node-sensitivity-score.py"
SPEC = importlib.util.spec_from_file_location("sensitivity_score", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class Fourarm:
    @staticmethod
    def packet_id_of(v):
        return v["packet_id"]

    @staticmethod
    def common_exclusion_limit(n_set):
        return min(5, int(n_set * 0.05))


def violation(packet_id, question="q", slot="s", node=1):
    return {
        "severity": "unresolved",
        "packet_id": packet_id,
        "question_id": question,
        "slot_name": slot,
        "doc_id": "d",
        "node_index": node,
    }


def test_supported_is_preserved_and_not_unknown():
    reports = {"A": {"violations": {"items": [violation("u-a")]}}}
    plan = MODULE.sensitivity_adjudication_plan(
        Fourarm, reports, {"u-a": {"sensitivity_outcome": "SUPPORTED_ALTERNATE_NODE"}}, 101
    )
    assert plan["unknown_per_arm"] == {}
    assert plan["per_arm_invalid"] == {}
    assert plan["supported_alternate_node_per_arm"] == {"A": ["u-a"]}


def test_critical_and_noncritical_both_invalidate_but_only_critical_fails_gate():
    reports = {"C": {"violations": {"items": [
        violation("u-a", slot="a", node=1),
        violation("u-b", slot="b", node=2),
    ]}}}
    plan = MODULE.sensitivity_adjudication_plan(Fourarm, reports, {
        "u-a": {"sensitivity_outcome": "ARM_SPECIFIC_CRITICAL"},
        "u-b": {"sensitivity_outcome": "ARM_SPECIFIC_NON_CRITICAL"},
    }, 101)
    assert plan["per_arm_critical"] == {"C": ["u-a"]}
    assert set(plan["per_arm_invalid"]["C"]) == {("q", "a"), ("q", "b")}


def test_missing_decision_stays_unknown():
    reports = {"D": {"violations": {"items": [violation("u-a")]}}}
    plan = MODULE.sensitivity_adjudication_plan(Fourarm, reports, {}, 101)
    assert plan["unknown_per_arm"] == {"D": 1}


def test_loader_requires_owner_confirmation_and_known_outcomes(tmp_path):
    p = tmp_path / "d.json"
    p.write_text('{"owner_confirmed":false,"resolutions":{}}')
    with pytest.raises(ValueError, match="owner_confirmed"):
        MODULE.load_sensitivity_resolutions(p)
    p.write_text('{"owner_confirmed":true,"resolutions":{"u-a":{"sensitivity_outcome":"BAD"}}}')
    with pytest.raises(ValueError, match="invalid sensitivity outcome"):
        MODULE.load_sensitivity_resolutions(p)


def test_supported_violation_becomes_sensitivity_minor_without_mutating_baseline():
    report = {
        "violations": {
            "critical": 0,
            "minor": 0,
            "unresolved": 1,
            "coarse": 0,
            "items": [violation("u-a")],
        }
    }
    out = MODULE.mark_supported_alternate_nodes(
        Fourarm,
        report,
        {"u-a": {"sensitivity_outcome": "SUPPORTED_ALTERNATE_NODE"}},
    )
    assert report["violations"]["items"][0]["severity"] == "unresolved"
    assert out["violations"]["items"][0]["severity"] == "minor"
    assert out["violations"]["items"][0]["reason"] == "supported_alternate_node_sensitivity"
    assert out["violations"]["minor"] == 1
    assert out["violations"]["unresolved"] == 0
    assert out["violations"]["supported_alternate_node_sensitivity"] == 1
