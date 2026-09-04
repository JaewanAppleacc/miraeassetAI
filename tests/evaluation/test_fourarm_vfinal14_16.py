"""vFINAL 14번(위반 심각도)·16번(UNRESOLVED 판정 적용) 회귀 잠금 — A/C 검수 요청 12케이스.

케이스 3("다른 period → critical")은 locator 문법에 기간 성분이 없어 발생 자체가 불가능하다 —
test_locator_grammar_has_no_period_component가 그 사실을 잠근다(문법이 확장되면 이 테스트가
깨져서 기간 비교 구현을 강제한다).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from dart_corpus.evaluation import fourarm as fa

REPO = Path(__file__).resolve().parents[2]


class _Store:
    def __init__(self, docs):
        self.docs = docs

    def __contains__(self, d):
        return d in self.docs

    def location(self, d):
        class L:
            n_nodes = len(self.docs[d])
        return L()

    def fetch_node(self, d, n):
        return {"text": self.docs[d][n]}


def _res(doc, node, text="", rank=1, **extra):
    return {"rank": rank, "doc_id": doc, "node_index": node, "text": text, **extra}


def _match(slot, method, result, gold_rc):
    return {"slot_name": slot, "method": method, "result": result, "gold_row_col": gold_rc}


_STORE = _Store({"d1": ["구분 | 2024 | 2023", "매출액 | 100 | 90", "영업이익 | 70 | 60"]})


def _sev(matches):
    qs = fa.QuestionScore("q", "LOW", len(matches), False)
    qs.slot_matches = matches
    return [(x["severity"], x["reason"].split(":")[0]) for x in fa.check_locators(qs, _STORE)]


# ---------- 14번: 심각도 ----------

def test_case1_same_node_different_row_is_critical():
    got = _sev([_match("s", "node", _res("d1", 1, text="매출액 | 100 | 90", row=2, col=1), (1, 1))])
    assert got == [("critical", "row_col_differs")]


def test_case2_same_node_different_col_is_critical():
    got = _sev([_match("s", "node", _res("d1", 1, text="매출액 | 100 | 90", row=1, col=2), (1, 1))])
    assert got == [("critical", "row_col_differs")]


def test_case3_locator_grammar_has_no_period_component():
    # 기간을 지시하는 locator는 문법상 만들 수 없다 — 파싱 결과는 (doc, node, row, col) 4성분뿐.
    parsed = fa.parse_locator("periodic_20250317000429/20250317000429.xml#node=635&row=1&col=2")
    assert parsed is not None and len(parsed) == 4
    assert fa.parse_locator("periodic_1/1.xml#node=1&period=2024") is None   # 기간 성분은 문법 위반


def test_case4_cell_gold_node_only_result_with_text_verified_is_coarse():
    got = _sev([_match("s", "node", _res("d1", 1, text="매출액 | 100 | 90"), (1, 1))])
    assert got == [("coarse", "no_row_col_in_chunk")]


def test_case5_cell_gold_node_only_result_unverifiable_is_unresolved():
    got = _sev([_match("s", "node", _res("d1", 1, text="전혀 다른 본문 텍스트 XYZ 987654"), (1, 1))])
    assert got == [("unresolved", "claim_text_not_in_node")]


def test_case6_same_evidence_span_offset_only_is_minor():
    # text-method: 결과 locator는 자기 node에 정직하고(본문 대조 통과) Gold span도 그 본문에
    # 있지만 Gold 지정 node와는 다른 node/범위 → 경미(보고만, 탈락 아님).
    got = _sev([_match("s", "text", _res("d1", 1, text="매출액 | 100 | 90"), None)])
    assert got == [("minor", "same_evidence_span_offset_differs")]


def test_exact_cell_match_yields_no_violation():
    got = _sev([_match("s", "node", _res("d1", 1, text="매출액 | 100 | 90", row=1, col=1), (1, 1))])
    assert got == []


# ---------- 16번: 판정 적용 ----------

def _report_with_unresolved(arm, items):
    return {"arm": arm, "violations": {"critical": 0, "minor": 0,
                                       "unresolved": len(items), "coarse": 0, "items": items}}


def _unres(qid, slot="s", doc="d1", node=1):
    return {"severity": "unresolved", "question_id": qid, "slot_name": slot,
            "doc_id": doc, "node_index": node, "reason": "claim_text_not_in_node",
            "chunk_text": "t"}


def _resolve_all(items, classification, critical=False):
    return {fa.packet_id_of(v): {"classification": classification, "critical": critical}
            for v in items}


def test_case7_common_source_up_to_5_allowed():
    items = [_unres(f"q{i}") for i in range(5)]
    plan = fa.adjudication_plan({"B": _report_with_unresolved("B", items)},
                                _resolve_all(items, "COMMON_SOURCE"), n_set=101)
    assert plan["common_qids"] == [f"q{i}" for i in range(5)]
    assert plan["limit"] == 5 and not plan["over_limit"]


def test_case8_common_source_6_is_blocked():
    items = [_unres(f"q{i}") for i in range(6)]
    plan = fa.adjudication_plan({"B": _report_with_unresolved("B", items)},
                                _resolve_all(items, "COMMON_SOURCE"), n_set=101)
    assert plan["over_limit"]
    j = fa.judge({"B": {}, "D": {}}, adjudication=plan)
    assert j["status"] == "BLOCKED" and "16번 A" in j["reason"]


def test_case9_low_below_10_after_exclusion_is_underpowered():
    # 공통 제외로 LOW가 9문항이 되면 judge가 LOW_UNDERPOWERED 경로(의역 없음 → BLOCKED)로 간다.
    def rep(arm, low_q):
        seg = lambda q: {"questions": q, "recall@10": 0.9, "all_found@10": q}  # noqa: E731
        return {"arm": arm, "locator_checked": True,
                "pins": {"conditions_sha_matches": True},
                "violations": {"critical": 0, "minor": 0, "unresolved": 0, "coarse": 0, "items": []},
                "segments": {"ALL": seg(50), "HIGH": seg(41), "LOW": seg(low_q)},
                "latency_ms": {}, "peak_rss_mb": 1, "external_services": []}
    j = fa.judge({"B": rep("B", 9), "D": rep("D", 9)})
    assert j["status"] == "BLOCKED" and "LOW underpowered" in j["reason"]


def test_case10_arm_specific_counts_as_slot_failure_for_that_arm():
    gq = fa.GoldQuestion("q1", {"d1"}, [fa.GoldSlot("s", [fa.GoldSource("d1", 1, "")])])
    rec = {"results": [_res("d1", 1)]}
    base = fa.score_question(gq, rec, "LOW", ks=(10,))
    assert base.found_at[10] == 1
    banned = {"s": frozenset({("d1", 1)})}
    after = fa.score_question(gq, rec, "LOW", ks=(10,), banned=banned)
    assert after.found_at[10] == 0 and not after.all_found_at[10]
    assert after.slot_matches == []          # 무효화된 매치는 locator 재검사 대상에서도 빠진다


def test_arm_specific_critical_reaches_hard_gate_via_score_cli_pathway():
    items = [_unres("q1")]
    plan = fa.adjudication_plan({"B": _report_with_unresolved("B", items)},
                                _resolve_all(items, "ARM_SPECIFIC", critical=True), n_set=101)
    assert plan["per_arm_critical"] == {"B": [fa.packet_id_of(items[0])]}
    assert plan["per_arm_invalid"]["B"] == {("q1", "s"): frozenset({("d1", 1)})}


def test_case11_unknown_or_unadjudicated_stays_pending():
    items = [_unres("q1")]
    plan = fa.adjudication_plan({"B": _report_with_unresolved("B", items)}, {}, n_set=101)
    assert plan["unknown_per_arm"] == {"B": 1} and plan["common_qids"] == []
    # 자동 분류 금지: 판정 파일이 비어 있으면 공통 제외도 무효화도 일어나지 않는다.
    assert not plan["per_arm_invalid"] and not plan["per_arm_critical"]


def test_resolutions_reject_unknown_classification(tmp_path):
    p = tmp_path / "r.json"
    p.write_text(json.dumps({"u-x": {"classification": "AUTO_EXCLUDE"}}), encoding="utf-8")
    with pytest.raises(ValueError):
        fa.load_resolutions(p)


@pytest.mark.skipif(not (REPO / "results/fourarm/B.results.jsonl").exists(),
                    reason="B/D 결과 파일이 있는 환경에서만(로컬 실측 자산)")
def test_case12_bd_result_files_untouched():
    """scorer 수정은 결과 파일을 건드리지 않는다 — run.json 기록 해시와 byte 일치."""
    for arm in ("B", "D"):
        run = json.loads((REPO / f"results/fourarm/{arm}.run.json").read_text(encoding="utf-8"))
        actual = hashlib.sha256((REPO / f"results/fourarm/{arm}.results.jsonl").read_bytes()).hexdigest()
        assert actual == run["results_sha256"], f"{arm}.results.jsonl가 run.json 기록과 다르다"
