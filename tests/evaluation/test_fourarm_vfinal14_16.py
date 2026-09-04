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
    # 동일 node·동일 셀·동일 근거인데 원문 그대로가 아니라 정규화로만 일치(offset/공백/구두점)
    # → 경미 보고(탈락 아님). 다른 node의 동일 텍스트는 여기 해당 없음(→ UNRESOLVED, 아래 r3).
    m = _match("s", "node", _res("d1", 1, text="매출액 | 100 | 90", row=1, col=1), (1, 1))
    m["span_state"], m["norm_only"] = "verified", True
    got = _sev([m])
    assert got == [("minor", "same_evidence_offset_or_normalization")]


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


# ---------- 검수 2차: slot-found span 결박 (같은 node ≠ 같은 근거) ----------

_SPAN_STORE = _Store({"d1": ["헤더", "매출액 | 100 | 90\n영업이익 | 70 | 60", "다른 섹션"]})


def _span_slot(span="매출액 | 100 | 90", row=None, col=None):
    return fa.GoldSlot("s", [fa.GoldSource("d1", 1, span, row, col)])


def test_r2_same_node_other_rows_window_is_not_found():
    # 같은 node(1)의 창이지만 Gold span 줄이 없는 텍스트 — node 원문에는 span이 있으므로
    # '옳은 node의 다른 창' 확정 → slot-found 금지 (종전엔 node 일치만으로 인정되던 과대 계상).
    r = {"rank": 1, "doc_id": "d1", "node_index": 1, "text": "영업이익 | 70 | 60"}
    ok, *_ = fa.slot_found(_span_slot(), [r], k=10, store=_SPAN_STORE)
    assert not ok


def test_r2_same_node_span_present_is_verified_found():
    r = {"rank": 1, "doc_id": "d1", "node_index": 1, "text": "매출액 | 100 | 90"}
    ok, _, how, src, state = fa.slot_found(_span_slot(), [r], k=10, store=_SPAN_STORE)
    assert ok and how == "node" and state == "verified" and src.node_index == 1


def test_r2_different_period_row_with_explicit_rc_is_critical():
    # 같은 node의 다른 기간(행·열) 근거: 결과가 rc를 명시하면 rc 상이 = 치명(기간 오귀속 커버).
    qs = fa.QuestionScore("q", "LOW", 1, False)
    qs.slot_matches = [{"slot_name": "s", "method": "node", "span_state": "verified",
                        "result": _res("d1", 1, text="매출액 | 100 | 90", row=2, col=2),
                        "gold_row_col": (1, 1)}]
    v = fa.check_locators(qs, _SPAN_STORE)
    assert [x["severity"] for x in v] == ["critical"]


def test_r2_unverifiable_span_is_unresolved_packet():
    # span·text 둘 다 있는데 청크에도 node 원문에도 없음(렌더링 차이 가능) → 매치 유지 +
    # UNRESOLVED 패킷(16번 Owner행). 자동으로 found-clean도, 탈락도 시키지 않는다.
    slot = fa.GoldSlot("s", [fa.GoldSource("d1", 2, "원문과 다른 렌더링의 근거줄 ABCDEFG")])
    r = {"rank": 1, "doc_id": "d1", "node_index": 2, "text": "다른 섹션"}
    ok, _, how, _, state = fa.slot_found(slot, [r], k=10, store=_SPAN_STORE)
    assert ok and state == "unverified"
    qs = fa.QuestionScore("q", "LOW", 1, False)
    qs.slot_matches = [{"slot_name": "s", "method": "node", "span_state": "unverified",
                        "result": dict(r), "gold_row_col": None}]
    v = fa.check_locators(qs, _SPAN_STORE)
    assert [(x["severity"], x["reason"]) for x in v] == [("unresolved", "gold_span_not_verifiable")]


def test_r2_second_acceptable_source_on_same_node_matches():
    # 같은 node에 acceptable source가 여럿 — 첫 번째 고정이 아니라 전체 대조. 결과 rc와
    # 일치하는 두 번째 source가 선택되어 위반이 없어야 한다.
    slot = fa.GoldSlot("s", [fa.GoldSource("d1", 1, "매출액 | 100 | 90", 1, 1),
                             fa.GoldSource("d1", 1, "영업이익 | 70 | 60", 2, 1)])
    r = {"rank": 1, "doc_id": "d1", "node_index": 1,
         "text": "매출액 | 100 | 90\n영업이익 | 70 | 60", "row": 2, "col": 1}
    ok, _, _, src, state = fa.slot_found(slot, [r], k=10, store=_SPAN_STORE)
    assert ok and state == "verified" and (src.row, src.col) == (2, 1)
    qs = fa.QuestionScore("q", "LOW", 1, False)
    qs.slot_matches = [{"slot_name": "s", "method": "node", "span_state": "verified",
                        "result": dict(r), "gold_row_col": (src.row, src.col)}]
    assert fa.check_locators(qs, _SPAN_STORE) == []


def test_r2_whitespace_only_difference_is_verified_not_violation():
    # 동일 node·동일 셀, 공백/구두점만 다른 렌더링 — 정규화 대조로 verified, 위반 없음.
    r = {"rank": 1, "doc_id": "d1", "node_index": 1, "text": "매출액 |  100  |  90"}
    ok, _, _, _, state = fa.slot_found(_span_slot(), [r], k=10, store=_SPAN_STORE)
    assert ok and state == "verified"


# ---------- 검수 3차: different-node 규칙 (자동 경미 금지 → Owner 판정) ----------

_DUP_STORE = _Store({"d1": ["매출액 | 100 | 90 (2024년)", "매출액 | 100 | 90 (2024년)",
                            "매출액 | 100 | 90 (2023년)"]})


def _text_match(node, text, gold_node=0, gold_span="매출액 | 100 | 90 (2024년)"):
    return {"slot_name": "s", "method": "text", "span_state": "verified", "gold_node": gold_node,
            "gold_span": gold_span, "gold_row_col": None,
            "result": {"rank": 1, "doc_id": "d1", "node_index": node, "text": text}}


def _sev_dup(matches):
    qs = fa.QuestionScore("q", "LOW", len(matches), False)
    qs.slot_matches = matches
    return [(x["severity"], x["reason"].split(":")[0]) for x in fa.check_locators(qs, _DUP_STORE)]


def test_r3_case1_same_node_same_cell_offset_only_is_minor():
    r = {"rank": 1, "doc_id": "d1", "node_index": 1, "text": "매출액 |  100 |  90  (2024년)",
         "row": 1, "col": 1}
    slot = fa.GoldSlot("s", [fa.GoldSource("d1", 1, "매출액 | 100 | 90 (2024년)", 1, 1)])
    ok, _, how, _, state = fa.slot_found(slot, [r], k=10, store=_DUP_STORE)
    assert ok and how == "node" and state == "verified"
    gq = fa.GoldQuestion("q", {"d1"}, [slot])
    qs = fa.score_question(gq, {"results": [r]}, "LOW", ks=(10,), store=_DUP_STORE)
    assert qs.slot_matches[0]["norm_only"] is True
    v = fa.check_locators(qs, _DUP_STORE)
    assert [(x["severity"], x["reason"]) for x in v] == [("minor", "same_evidence_offset_or_normalization")]


def test_r3_case2_other_node_not_acceptable_same_text_is_unresolved():
    # 다른 node의 동일 문자열, Gold acceptable source 아님 → scorer가 경미/치명을 정하지 않고
    # UNRESOLVED(duplicate_evidence_different_node)로 Owner arm-blind 판정에 넘긴다.
    got = _sev_dup([_text_match(1, "매출액 | 100 | 90 (2024년)")])
    assert got == [("unresolved", "duplicate_evidence_different_node")]


def test_r3_case3_other_node_other_period_is_critical():
    # Gold span 연도(2024)가 청크에 없고 청크는 다른 연도(2023)를 담음 → 다른 기간 근거 확정 = 치명.
    got = _sev_dup([_text_match(2, "매출액 | 100 | 90 (2023년)")])
    assert got == [("critical", "different_node_different_period")]


def test_r3_case4_other_node_registered_as_acceptable_source_is_clean():
    # Gold acceptable source에 등록된 node면 node-method 매치 = 위반 없음.
    slot = fa.GoldSlot("s", [fa.GoldSource("d1", 0, "매출액 | 100 | 90 (2024년)"),
                             fa.GoldSource("d1", 1, "매출액 | 100 | 90 (2024년)")])
    r = {"rank": 1, "doc_id": "d1", "node_index": 1, "text": "매출액 | 100 | 90 (2024년)"}
    ok, _, how, src, state = fa.slot_found(slot, [r], k=10, store=_DUP_STORE)
    assert ok and how == "node" and src.node_index == 1 and state == "verified"
    gq = fa.GoldQuestion("q", {"d1"}, [slot])
    qs = fa.score_question(gq, {"results": [r]}, "LOW", ks=(10,), store=_DUP_STORE)
    assert fa.check_locators(qs, _DUP_STORE) == []


def test_r3_case5_partial_set_never_returns_official_winner():
    def rep(arm, low):
        seg = lambda q, f: {"questions": q, "recall@10": 0.9, "all_found@10": f}  # noqa: E731
        return {"arm": arm, "locator_checked": True, "pins": {"conditions_sha_matches": True},
                "violations": {"critical": 0, "minor": 0, "unresolved": 0, "coarse": 0, "items": []},
                "segments": {"ALL": seg(50, 40), "HIGH": seg(31, 25), "LOW": seg(19, low)},
                "latency_ms": {}, "peak_rss_mb": 1, "external_services": []}
    j = fa.judge({"B": rep("B", 11), "D": rep("D", 9)})
    assert j["status"] == "PARTIAL_SET_LEADER" and j["leader"] == "B" and "winner" not in j
    assert j["arm_set"] == ["B", "D"]
    j4 = fa.judge({a: rep(a, 10) for a in "ABCD"})
    assert j4["status"] == "PROVISIONAL_WINNER" and "winner" in j4


def test_r3_owner_equivalent_evidence_downgrades_to_minor():
    item = {"severity": "unresolved", "question_id": "q1", "slot_name": "s", "doc_id": "d1",
            "node_index": 1, "reason": "duplicate_evidence_different_node", "chunk_text": "t"}
    rep = {"violations": {"critical": 0, "minor": 0, "unresolved": 1, "coarse": 0, "items": [item]}}
    plan = fa.adjudication_plan({"B": rep}, {fa.packet_id_of(item): {"classification": "EQUIVALENT_EVIDENCE"}},
                                n_set=101)
    assert plan["per_arm_equivalent"] == {"B": [fa.packet_id_of(item)]} and plan["unknown_per_arm"] == {}
    assert fa.apply_equivalent_evidence(rep, plan["per_arm_equivalent"]["B"]) == 1
    assert rep["violations"]["minor"] == 1 and rep["violations"]["unresolved"] == 0
    # 판정이 없으면 자동 강등 없음 — UNKNOWN 그대로(위 apply가 item을 제자리 수정했으므로 새로 만든다).
    fresh = {**item, "severity": "unresolved", "reason": "duplicate_evidence_different_node"}
    plan2 = fa.adjudication_plan({"B": {"violations": {"items": [fresh]}}}, {}, n_set=101)
    assert plan2["unknown_per_arm"] == {"B": 1}


@pytest.mark.skipif(not (REPO / "results/fourarm/B.results.jsonl").exists(),
                    reason="B/D 결과 파일이 있는 환경에서만(로컬 실측 자산)")
def test_case12_bd_result_files_untouched():
    """scorer 수정은 결과 파일을 건드리지 않는다 — run.json 기록 해시와 byte 일치."""
    for arm in ("B", "D"):
        run = json.loads((REPO / f"results/fourarm/{arm}.run.json").read_text(encoding="utf-8"))
        actual = hashlib.sha256((REPO / f"results/fourarm/{arm}.results.jsonl").read_bytes()).hexdigest()
        assert actual == run["results_sha256"], f"{arm}.results.jsonl가 run.json 기록과 다르다"
