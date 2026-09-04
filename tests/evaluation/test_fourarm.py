"""4-arm 채점기·판정 체인 — 합성 Gold·결과로 정의와 순서를 잠근다. 코퍼스·모델 없음."""
from __future__ import annotations

import pytest

from dart_corpus.evaluation import fourarm as fa


# ---------- locator ----------

def test_parse_locator_both_grammars():
    assert fa.parse_locator("holding_20240620000340/20240620000340.xml#node=0&row=4&col=2") == \
        ("holding_20240620000340", 0, 4, 2)
    assert fa.parse_locator("major_20241128001098/20241128001098.xml#node=9") == ("major_20241128001098", 9, None, None)
    assert fa.parse_locator("holding_20240403000410::20240403000410.xml::n1") == ("holding_20240403000410", 1, None, None)
    assert fa.parse_locator("garbage") is None


# ---------- slot_found ----------

def _slot(*sources):
    return fa.GoldSlot("s", [fa.GoldSource(d, n, span) for d, n, span in sources])


def _res(doc, node, text="", rank=1, **extra):
    return {"rank": rank, "doc_id": doc, "node_index": node, "text": text, **extra}


def test_slot_found_by_node_then_text_then_miss():
    slot = _slot(("d1", 5, "매출액 | 10,891,443\n영업이익 | 1,461,202"))
    ok, r, how = fa.slot_found(slot, [_res("d1", 5)], k=10)
    assert ok and how == "node"
    # node 다르지만 텍스트에 span 한 줄 포함 → 2순위 text
    ok, r, how = fa.slot_found(slot, [_res("d1", 7, text="구분 | 값\n매출액 | 10,891,443")], k=10)
    assert ok and how == "text"
    # 다른 문서면 텍스트가 같아도 불일치
    ok, _, _ = fa.slot_found(slot, [_res("d2", 5, text="매출액 | 10,891,443")], k=10)
    assert not ok
    # k 밖이면 불일치
    ok, _, _ = fa.slot_found(slot, [_res("d9", 1), _res("d1", 5, rank=2)], k=1)
    assert not ok


def test_slot_found_uses_node_indices_for_multi_node_chunks():
    slot = _slot(("d1", 12, ""))
    ok, _, how = fa.slot_found(slot, [_res("d1", 10, node_indices=[10, 11, 12])], k=10)
    assert ok and how == "node"


# ---------- score_question / score_arm ----------

def _gold(qid, docs, slots):
    return fa.GoldQuestion(qid, set(docs), [_slot(*s) for s in slots])


def test_score_question_and_exclusion():
    gq = _gold("q1", ["d1"], [[("d1", 1, "")], [("d1", 2, "")]])
    rec = {"results": [_res("d1", 1, rank=1), _res("dX", 0, rank=2), _res("d1", 2, rank=3)]}
    qs = fa.score_question(gq, rec, "LOW", ks=(1, 3))
    assert qs.found_at == {1: 1, 3: 2} and qs.all_found_at == {1: False, 3: True}
    assert qs.doc_hit_at == {1: True, 3: True} and not qs.excluded
    zero = fa.score_question(_gold("q0", [], []), rec, "HIGH", ks=(1,))
    assert zero.excluded and zero.all_found_at == {1: False}
    missing = fa.score_question(gq, None, "LOW", ks=(1,))
    assert missing.error == "missing" and missing.found_at == {1: 0}


def _report(arm, *, r_all, r_high, low_all_found, low_q=12, critical=0, minor=0, unresolved=0,
            p95=1000, rss=500, ext=(), pins_ok=True):
    def seg(recall, all_found, q):
        return {"questions": q, "slots_total": q * 2, "slots_found@10": int(recall * q * 2),
                "recall@10": recall, "all_found@10": all_found}
    return {"arm": arm,
            "segments": {"ALL": seg(r_all, 0, 90), "HIGH": seg(r_high, 0, 90 - low_q),
                         "LOW": seg(0.8, low_all_found, low_q)},
            "violations": {"critical": critical, "minor": minor, "unresolved": unresolved, "items": []},
            "latency_ms": {"p95": p95}, "peak_rss_mb": rss, "external_services": list(ext),
            "pins": {"conditions_sha_matches": pins_ok}, "locator_checked": True}


def test_score_arm_aggregates_by_segment():
    gold = {"q1": _gold("q1", ["d1"], [[("d1", 1, "")], [("d1", 2, "")]]),
            "q2": _gold("q2", ["d2"], [[("d2", 3, "")]]),
            "q0": _gold("q0", [], [])}
    results = {"q1": {"results": [_res("d1", 1), _res("d1", 2, rank=2)]},
               "q2": {"results": [_res("d2", 9)]},
               "q0": {"results": []}}
    rep = fa.score_arm("D", results, gold, {"q1": "LOW", "q2": "HIGH", "q0": "HIGH"},
                       run={"input_sha256": {"conditions": "abc"}, "latency_ms": {"p95": 5}},
                       conditions_sha="abc")
    assert rep["n_excluded_zero_slot"] == 1
    assert rep["segments"]["ALL"]["slots_total"] == 3 and rep["segments"]["ALL"]["slots_found@10"] == 2
    assert rep["segments"]["ALL"]["recall@10"] == pytest.approx(2 / 3, abs=1e-4)
    assert rep["segments"]["LOW"]["all_found@10"] == 1 and rep["segments"]["HIGH"]["all_found@10"] == 0
    assert rep["pins"]["conditions_sha_matches"] is True and rep["latency_ms"]["p95"] == 5


# ---------- locator 검사 (14번) ----------

class _Store:
    def __init__(self, docs):   # doc_id -> list of node texts
        self.docs = docs

    def __contains__(self, d): return d in self.docs

    def location(self, d):
        class L: n_nodes = len(self.docs[d])
        return L()

    def fetch_node(self, d, n): return {"text": self.docs[d][n]}


def test_check_locators_severities():
    store = _Store({"d1": ["구분 | 값", "매출액 | 10", "영업이익 | 1"]})
    qs = fa.QuestionScore("q", "LOW", 3, False)
    qs.slot_matches = [
        {"slot_name": "a", "method": "node", "result": _res("d1", 1, text="매출액 | 10")},       # OK
        {"slot_name": "b", "method": "node", "result": _res("dZ", 0)},                          # 문서 없음
        {"slot_name": "c", "method": "node", "result": _res("d1", 7)},                          # node 범위 밖
        {"slot_name": "d", "method": "node", "result": _res("d1", 2, text="전혀 다른 텍스트 XYZ 1234567")},  # 대조 불가
    ]
    v = fa.check_locators(qs, store)
    sev = sorted((x["severity"], x["reason"].split(":")[0]) for x in v)
    assert sev == [("critical", "doc_missing"), ("critical", "node_missing"), ("unresolved", "claim_text_not_in_node")]


def test_check_locators_no_text_is_unresolved_and_row_col_rules():
    # vFINAL 14번 원문: 명시된 row/col 상이 = "다른 행/열 지시" = 치명 (A/C 검수 반영으로 교정 —
    # 종전 '경미'는 오독. 경미는 동일 근거의 offset 차이에 한정).
    store = _Store({"d1": ["구분 | 값", "매출액 | 10"]})
    qs = fa.QuestionScore("q", "LOW", 3, False)
    qs.slot_matches = [
        {"slot_name": "a", "method": "node", "result": _res("d1", 1), "gold_row_col": None},          # text 없음 → 판정 불가
        {"slot_name": "b", "method": "node", "result": _res("d1", 1, text="매출액 | 10"), "gold_row_col": (1, 2)},   # 청크에 row/col 없음 → coarse
        {"slot_name": "c", "method": "node", "result": _res("d1", 1, text="매출액 | 10", row=1, col=3), "gold_row_col": (1, 2)},  # 다름 → 치명
        {"slot_name": "d", "method": "node", "result": _res("d1", 1, text="매출액 | 10", row=1, col=2), "gold_row_col": (1, 2)},  # 같음 → 없음
    ]
    v = fa.check_locators(qs, store)
    got = sorted((x["slot_name"], x["severity"], x["reason"].split(":")[0]) for x in v)
    assert got == [("a", "unresolved", "no_text_to_verify"), ("b", "coarse", "no_row_col_in_chunk"),
                   ("c", "critical", "row_col_differs")]


def test_unresolved_packets_are_arm_blind_and_unique_across_arms():
    item = {"severity": "unresolved", "question_id": "q", "slot_name": "s", "doc_id": "d", "node_index": 1,
            "reason": "claim_text_not_in_node", "chunk_text": "t"}
    other = {**item, "node_index": 2}
    pb = fa.unresolved_packets({"arm": "B", "violations": {"items": [item]}})
    pd = fa.unresolved_packets({"arm": "D", "violations": {"items": [other]}})
    assert len(pb) == 1 and "arm" not in pb[0] and pb[0]["packet_id"].startswith("u-")
    assert pb[0]["packet_id"] != pd[0]["packet_id"]                      # 다른 청크 → 다른 id (arm 무관)
    same = fa.unresolved_packets({"arm": "D", "violations": {"items": [item]}})
    assert same[0]["packet_id"] == pb[0]["packet_id"]                    # 같은 청크·사유 → 같은 id (중복 제거 가능)


# ---------- judge (판정 체인) ----------

def test_hard_gate_removes_critical_arm_and_blocks_when_none():
    reps = {"A": _report("A", r_all=0.9, r_high=0.9, low_all_found=10, critical=1),
            "D": _report("D", r_all=0.85, r_high=0.85, low_all_found=9)}
    j = fa.judge(reps)
    assert j["winner"] == "D" and j["status"] == "PROVISIONAL_WINNER"
    assert fa.judge({"A": reps["A"]})["status"] == "BLOCKED"


def test_quality_gate_margin_and_no_selection():
    reps = {"A": _report("A", r_all=0.90, r_high=0.90, low_all_found=8),
            "D": _report("D", r_all=0.88, r_high=0.90, low_all_found=12)}      # ALL 0.02 낮음 → 탈락
    j = fa.judge(reps)
    assert j["winner"] == "A"
    reps["D"]["segments"]["ALL"]["recall@10"] = 0.89                             # 정확히 0.01 낮음 → "0.01 이상" 탈락
    assert fa.judge(reps)["winner"] == "A"
    reps["D"]["segments"]["ALL"]["recall@10"] = 0.895                            # 0.005 낮음 → 통과, LOW 12 vs 8 → D
    assert fa.judge(reps)["winner"] == "D"


def test_final_tie_set_prefers_dense_off_and_cd_tiebreak_by_latency():
    reps = {"A": _report("A", r_all=0.9, r_high=0.9, low_all_found=10),
            "C": _report("C", r_all=0.9, r_high=0.9, low_all_found=9, p95=2000),
            "D": _report("D", r_all=0.9, r_high=0.9, low_all_found=10, p95=1000)}
    j = fa.judge(reps)
    assert set(j["tie_set"]) == {"A", "C", "D"}
    assert j["winner"] == "D" and j["selection_type"] == "PERFORMANCE_TIE_BREAK_SELECTION"
    assert any(s["step"].startswith("18 latency") for s in j["chain"])


def test_two_below_best_is_dropped_and_ab_tie_goes_to_b():
    reps = {"A": _report("A", r_all=0.9, r_high=0.9, low_all_found=10),
            "B": _report("B", r_all=0.9, r_high=0.9, low_all_found=10),
            "D": _report("D", r_all=0.9, r_high=0.9, low_all_found=8)}          # 최고−2 → 탈락
    j = fa.judge(reps)
    assert j["tie_set"] == ["A", "B"] and j["winner"] == "B"
    assert j["selection_type"] == "PERFORMANCE_TIE_BREAK_SELECTION"


def test_low_underpowered_paths():
    reps = {"B": _report("B", r_all=0.9, r_high=0.9, low_all_found=3, low_q=5),
            "D": _report("D", r_all=0.9, r_high=0.9, low_all_found=4, low_q=5)}
    assert fa.judge(reps)["status"] == "BLOCKED"                                    # 의역 세트 없음·B 배포성 미확인
    j = fa.judge(reps, deployable={"B": True})
    assert j["status"] == "OPERATIONAL_FALLBACK" and j["winner"] == "B"
    j = fa.judge(reps, paraphrase_all_found={"B": 12, "D": 15})
    assert j["winner"] == "D" and j["status"] == "PROVISIONAL_WINNER"


def test_pins_mismatch_is_invalid_and_unresolved_marks_pending():
    reps = {"C": _report("C", r_all=0.9, r_high=0.9, low_all_found=10, pins_ok=False),
            "D": _report("D", r_all=0.9, r_high=0.9, low_all_found=10)}
    assert fa.judge(reps)["status"] == "INVALID"
    reps["C"]["pins"]["conditions_sha_matches"] = True
    reps["D"]["violations"]["unresolved"] = 2
    j = fa.judge(reps)
    assert j["status"] == "PENDING_UNRESOLVED" and j["candidate"] == "D" and "winner" not in j


def test_judge_refuses_reports_without_locator_check():
    reps = {"C": _report("C", r_all=0.9, r_high=0.9, low_all_found=10),
            "D": _report("D", r_all=0.9, r_high=0.9, low_all_found=10)}
    reps["D"]["locator_checked"] = False
    j = fa.judge(reps)
    assert j["status"] == "INVALID" and "locator" in j["reason"]


def test_judge_require_arms_blocks_partial_sets():
    """검수 발견 2: 최종 판정은 A/B/C/D 완비 + 문항 누락 0을 강제할 수 있어야 한다."""
    reps = {a: _report(a, r_all=0.9, r_high=0.9, low_all_found=10) for a in ("B", "D")}
    # 잠정 판정(require 없음)은 그대로 돈다 — B/D 중간 판정 호환.
    assert fa.judge(reps)["status"] == "PROVISIONAL_WINNER"
    j = fa.judge(reps, require_arms={"A", "B", "C", "D"})
    assert j["status"] == "INVALID" and "missing=['A', 'C']" in j["reason"]
    reps4 = {a: _report(a, r_all=0.9, r_high=0.9, low_all_found=10) for a in "ABCD"}
    assert fa.judge(reps4, require_arms={"A", "B", "C", "D"})["status"] == "PROVISIONAL_WINNER"
    reps4["A"]["n_missing_or_error"] = 3
    j = fa.judge(reps4, require_arms={"A", "B", "C", "D"})
    assert j["status"] == "INVALID" and "missing/error" in j["reason"]
