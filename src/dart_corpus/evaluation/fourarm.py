"""4-arm 공용 채점기 + 판정 체인 — vFINAL 2·4·5·10·11·12·14·16·17·18번, interfaces.md §1.

한 채점기가 네 arm의 결과 파일(§1-1)을 같은 Gold·같은 세그먼트로 채점한다. arm별 코드가 아니다.

채점 정의(실행 전 고정 — vFINAL 15번):
  slot found@k   Gold required_evidence_slot의 acceptable_sources 중 하나가 상위 k 결과에 있으면 1.
                 1순위: (doc_id, node_index) 일치 — 결과의 node_index ∪ node_indices.
                 2순위: 결과에 text가 있고, 같은 doc_id이며 Gold evidence_span의 한 줄(공백 제거·6자 이상)이
                        청크 텍스트에 부분문자열로 있으면 1. (병합 셀 반복 등 렌더링 차이 대비, §5-7)
  Recall@k       slots_found@k / slots_total (micro). 전체·HIGH·LOW 각각.
  all_found@k    문항의 required slot이 전부 found인 문항 수(vFINAL 2번 주 판정: LOW all-required-slots-found).
  제외           required slot이 0개인 문항(NOT_FOUND/답변가능성 문항)은 Recall 분모에서 뺀다. 수를 보고한다.
  locator 검사   slot-match 청크만(vFINAL 14번). 문서 없음·node 범위 밖 = 치명. 텍스트가 node 원문과 대조
                 불가 = UNRESOLVED(16번 패킷, arm 라벨 제거 export). row/col 차이 = 경미(탈락 사유 아님).

판정 체인(judge): 20 pins → 14/16 UNRESOLVED 표시 → 12 Hard(치명 0) → 12 Quality(hard-safe 최고 대비
−0.01, 전체·HIGH R@10) → 2 LOW all_found@10 비교(LOW ≥10 문항일 때) → 5 FINAL_TIE_SET(최고−1 이내)
→ dense-off 우선 → 11+18 C/D 동률(경미 위반 → p95 ≤5% → RSS ≤5% → 외부 서비스 수 → D)
→ A/B만 동률이면 B(PERFORMANCE_TIE_BREAK_SELECTION) → 3/8 LOW<10이면 LOW_UNDERPOWERED(의역 절차)
→ 10 B fallback 조건 → 불성립 BLOCKED. 승자는 PROVISIONAL_WINNER(17번 DEV_CHECK 전).

상태 라벨(혼용 금지): INVALID · BLOCKED · NO_SELECTION · PENDING_UNRESOLVED(후보만, 승자 없음 — 16C)
· PROVISIONAL_WINNER · OPERATIONAL_FALLBACK.
"""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

KS = (5, 10, 20)
EVAL_K = 10
QUALITY_MARGIN = 0.01
LOW_MIN = 10
TIE_MAX_DIFF = 1
REL_TIE = 0.05
DENSE_OFF = ("C", "D")
LINE_WINDOW = ("B", "D")

_LOC_RE = re.compile(
    r"^(?P<doc>[a-z]+_\d+)"
    r"(?:/\d+\.xml#node=(?P<n1>\d+)(?:&row=(?P<row>\d+)&col=(?P<col>\d+))?"
    r"|::[^:]+::n(?P<n2>\d+))$")


# ---------- 공통 ----------

def norm_text(s: str) -> str:
    return "".join(unicodedata.normalize("NFC", s or "").split())


def parse_locator(loc: str) -> tuple[str, int, int | None, int | None] | None:
    m = _LOC_RE.match(loc or "")
    if not m:
        return None
    n = m.group("n1") or m.group("n2")
    row = m.group("row")
    col = m.group("col")
    return m.group("doc"), int(n), (int(row) if row else None), (int(col) if col else None)


def span_lines(span: str, min_len: int = 6) -> list[str]:
    out = []
    for ln in (span or "").split("\n"):
        t = norm_text(ln)
        if len(t) >= min_len:
            out.append(t)
    return out


# ---------- Gold ----------

@dataclass(frozen=True)
class GoldSource:
    doc_id: str
    node_index: int
    span: str
    row: int | None = None
    col: int | None = None


@dataclass
class GoldSlot:
    slot_name: str
    sources: list[GoldSource]


@dataclass
class GoldQuestion:
    question_id: str
    gold_docs: set[str]
    slots: list[GoldSlot]
    expected_answerability: str = ""


def load_gold(path: Path | str) -> dict[str, GoldQuestion]:
    out: dict[str, GoldQuestion] = {}
    with Path(path).open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            g = json.loads(line)
            slots = []
            for s in g.get("required_evidence_slots") or []:
                sources = []
                for src in s.get("acceptable_sources") or []:
                    parsed = parse_locator(src.get("source_locator", ""))
                    if parsed is None:
                        continue
                    doc, n, row, col = parsed
                    sources.append(GoldSource(doc, n, src.get("evidence_span") or "", row, col))
                slots.append(GoldSlot(s.get("slot_name", ""), sources))
            out[g["question_id"]] = GoldQuestion(
                question_id=g["question_id"],
                gold_docs=set(g.get("gold_document_ids") or []),
                slots=slots,
                expected_answerability=g.get("expected_answerability", ""),
            )
    return out


def load_segments(conditions_path: Path | str) -> dict[str, str]:
    seg = {}
    with Path(conditions_path).open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                r = json.loads(line)
                seg[r["question_id"]] = r["segment"]
    return seg


def load_results(path: Path | str) -> dict[str, dict]:
    out = {}
    with Path(path).open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                r = json.loads(line)
                out[r["question_id"]] = r
    return out


# ---------- 문항 채점 ----------

def _result_nodes(r: Mapping[str, Any]) -> set[int]:
    nodes = {int(r.get("node_index", -1))}
    for n in r.get("node_indices") or []:
        nodes.add(int(n))
    return nodes


def slot_found(slot: GoldSlot, results: Sequence[Mapping[str, Any]], k: int
               ) -> tuple[bool, Mapping[str, Any] | None, str]:
    top = list(results)[:k]
    for r in top:
        nodes = _result_nodes(r)
        for src in slot.sources:
            if r.get("doc_id") == src.doc_id and src.node_index in nodes:
                return True, r, "node"
    for r in top:
        t = norm_text(r.get("text") or "")
        if not t:
            continue
        for src in slot.sources:
            if r.get("doc_id") != src.doc_id:
                continue
            if any(ln in t for ln in span_lines(src.span)):
                return True, r, "text"
    return False, None, ""


@dataclass
class QuestionScore:
    question_id: str
    segment: str
    n_slots: int
    excluded: bool
    found_at: dict[int, int] = field(default_factory=dict)        # k -> found slots
    all_found_at: dict[int, bool] = field(default_factory=dict)
    doc_hit_at: dict[int, bool] = field(default_factory=dict)
    slot_matches: list[dict] = field(default_factory=list)       # k=EVAL_K 기준 (locator 검사 범위)
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"question_id": self.question_id, "segment": self.segment, "n_slots": self.n_slots,
                "excluded": self.excluded,
                "found_at": {str(k): v for k, v in self.found_at.items()},
                "all_found_at": {str(k): v for k, v in self.all_found_at.items()},
                "doc_hit_at": {str(k): v for k, v in self.doc_hit_at.items()},
                "n_slot_matches": len(self.slot_matches), "error": self.error}


def score_question(gq: GoldQuestion, rec: Mapping[str, Any] | None, segment: str,
                   ks: Sequence[int] = KS) -> QuestionScore:
    n_slots = len(gq.slots)
    qs = QuestionScore(gq.question_id, segment, n_slots, excluded=(n_slots == 0))
    results = list((rec or {}).get("results") or [])
    qs.error = (rec or {}).get("error", "") if rec is not None else "missing"
    for k in ks:
        found = 0
        for slot in gq.slots:
            ok, _, _ = slot_found(slot, results, k)
            found += int(ok)
        qs.found_at[k] = found
        qs.all_found_at[k] = (n_slots > 0 and found == n_slots)
        docs = {r.get("doc_id") for r in results[:k]}
        qs.doc_hit_at[k] = bool(gq.gold_docs & docs) if gq.gold_docs else False
    for slot in gq.slots:
        ok, r, method = slot_found(slot, results, EVAL_K)
        if ok and r is not None:
            nodes = _result_nodes(r)
            src = next((x for x in slot.sources if x.doc_id == r.get("doc_id") and x.node_index in nodes), None)
            qs.slot_matches.append({"slot_name": slot.slot_name, "method": method, "result": dict(r),
                                    "gold_row_col": (src.row, src.col) if src else None})
    return qs


# ---------- locator 검사 (vFINAL 14번) ----------

def check_locators(qs: QuestionScore, store: Any) -> list[dict]:
    """slot-match 청크만 검사. store: `doc_id in store`, `store.location(doc_id).n_nodes`, `store.fetch_node`."""
    out = []
    for m in qs.slot_matches:
        r = m["result"]
        doc_id = r.get("doc_id")
        base = {"question_id": qs.question_id, "slot_name": m["slot_name"], "doc_id": doc_id,
                "node_index": r.get("node_index"), "locator": r.get("locator")}
        if doc_id not in store:
            out.append({**base, "severity": "critical", "reason": "doc_missing"})
            continue
        n_nodes = store.location(doc_id).n_nodes
        nodes = sorted(_result_nodes(r))
        bad = [n for n in nodes if not 0 <= n < n_nodes]
        if bad:
            out.append({**base, "severity": "critical", "reason": f"node_missing:{bad}"})
            continue
        text = norm_text(r.get("text") or "")
        if not text:
            # 텍스트가 없으면 "claim 미지지"를 판정할 수 없다 → 14번 "판정 불가 = UNRESOLVED".
            out.append({**base, "severity": "unresolved", "reason": "no_text_to_verify", "chunk_text": ""})
            continue
        node_text = "".join(norm_text(store.fetch_node(doc_id, n)["text"]) for n in nodes)
        head = text[:60]
        if not (head in node_text or node_text[:60] in text or (len(text) >= 20 and text in node_text)):
            out.append({**base, "severity": "unresolved", "reason": "claim_text_not_in_node",
                        "chunk_text": r.get("text", "")[:400]})
            continue
        # row/col: Gold가 (row, col)을 지정하고 청크도 (row, col)을 보고했는데 서로 다르면 경미(동일 근거·offset 차이).
        # 청크에 row/col이 없는 것은 "상이"가 아니라 더 거친 locator다 → 위반이 아니라 coarse로만 센다.
        gold_rc = m.get("gold_row_col")
        if gold_rc and gold_rc != (None, None):
            rc = (r.get("row"), r.get("col"))
            if rc == (None, None):
                out.append({**base, "severity": "coarse", "reason": "no_row_col_in_chunk"})
            elif rc != gold_rc:
                out.append({**base, "severity": "minor", "reason": f"row_col_differs:{rc}!={gold_rc}"})
    return out


# ---------- arm 리포트 ----------

def _agg(qscores: Iterable[QuestionScore], gold: Mapping[str, GoldQuestion], ks: Sequence[int]) -> dict:
    qs = [q for q in qscores if not q.excluded]
    slots_total = sum(q.n_slots for q in qs)
    out: dict[str, Any] = {"questions": len(qs), "slots_total": slots_total}
    for k in ks:
        found = sum(q.found_at.get(k, 0) for q in qs)
        out[f"slots_found@{k}"] = found
        out[f"recall@{k}"] = round(found / slots_total, 4) if slots_total else None
        out[f"all_found@{k}"] = sum(1 for q in qs if q.all_found_at.get(k))
        out[f"all_found_rate@{k}"] = round(out[f"all_found@{k}"] / len(qs), 4) if qs else None
        out[f"doc_hit@{k}"] = sum(1 for q in qs if q.doc_hit_at.get(k))
    return out


def score_arm(arm: str, results: Mapping[str, dict], gold: Mapping[str, GoldQuestion],
              segments: Mapping[str, str], run: Mapping[str, Any] | None = None,
              store: Any = None, ks: Sequence[int] = KS,
              conditions_sha: str | None = None, gold_sha: str | None = None) -> dict[str, Any]:
    qscores = [score_question(gq, results.get(qid), segments.get(qid, "?"), ks)
               for qid, gq in gold.items()]
    by_seg = {
        "ALL": _agg(qscores, gold, ks),
        "HIGH": _agg([q for q in qscores if q.segment == "HIGH"], gold, ks),
        "LOW": _agg([q for q in qscores if q.segment == "LOW"], gold, ks),
    }
    violations = []
    if store is not None:
        for q in qscores:
            violations.extend(check_locators(q, store))
    sev = {"critical": 0, "minor": 0, "unresolved": 0, "coarse": 0}
    for v in violations:
        sev[v["severity"]] += 1
    run = run or {}
    pins = {
        "conditions_sha_matches": (conditions_sha is None or
                                   (run.get("input_sha256") or {}).get("conditions") == conditions_sha),
        "run_conditions_sha": (run.get("input_sha256") or {}).get("conditions"),
        "gold_sha256": gold_sha,
        "config_sha256": run.get("config_sha256"),
        "code_sha256": run.get("code_sha256"),
    }
    return {
        "arm": arm,
        "locator_checked": store is not None,        # False면 Hard gate 미평가 — judge가 INVALID로 막는다
        "n_questions": len(qscores),
        "n_excluded_zero_slot": sum(1 for q in qscores if q.excluded),
        "n_missing_or_error": sum(1 for q in qscores if q.error),
        "segments": by_seg,
        "violations": {**sev, "items": violations},
        "latency_ms": run.get("latency_ms") or {},
        "peak_rss_mb": run.get("peak_rss_mb"),
        "external_services": run.get("external_services") or [],
        "pins": pins,
        "questions": [q.to_dict() for q in qscores],
    }


def unresolved_packets(report: Mapping[str, Any]) -> list[dict]:
    """vFINAL 16번: arm 라벨을 뺀 UNRESOLVED 패킷. Owner가 arm-blind로 원인만 판정한다.

    packet_id는 (question_id, slot, doc_id, node_index, reason, chunk_text)의 해시 — arm과 무관하고
    arm 간에 충돌하지 않는다. 두 arm이 같은 청크를 같은 사유로 올리면 같은 패킷 하나가 된다."""
    import hashlib
    packets = []
    for v in report["violations"]["items"]:
        if v["severity"] != "unresolved":
            continue
        key = "|".join(str(v.get(k, "")) for k in ("question_id", "slot_name", "doc_id", "node_index", "reason", "chunk_text"))
        pid = "u-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
        packets.append({"packet_id": pid,
                        "question_id": v["question_id"], "slot_name": v["slot_name"],
                        "doc_id": v["doc_id"], "node_index": v["node_index"],
                        "chunk_text": v.get("chunk_text", ""), "reason": v["reason"]})
    return packets


# ---------- 판정 체인 ----------

def _rel_tie(a: float | None, b: float | None) -> bool:
    if a is None or b is None:
        return True
    hi = max(abs(a), abs(b))
    return hi == 0 or abs(a - b) / hi <= REL_TIE


def _cd_tiebreak(reports: Mapping[str, dict], cands: Sequence[str], chain: list) -> str:
    """vFINAL 11+18번: 경미 위반 → latency p95 → peak RSS → 외부 서비스 수 → D."""
    def minor(a): return reports[a]["violations"]["minor"]
    def p95(a): return (reports[a].get("latency_ms") or {}).get("p95")
    def rss(a): return reports[a].get("peak_rss_mb")
    def ext(a): return len(reports[a].get("external_services") or [])
    c = list(cands)
    best = min(minor(a) for a in c); c2 = [a for a in c if minor(a) == best]
    chain.append({"step": "11 safety(minor)", "values": {a: minor(a) for a in cands}, "kept": c2})
    if len(c2) == 1:
        return c2[0]
    vals = [p95(a) for a in c2]
    if not all(_rel_tie(vals[0], v) for v in vals):
        w = min(c2, key=lambda a: p95(a) if p95(a) is not None else float("inf"))
        chain.append({"step": "18 latency p95", "values": {a: p95(a) for a in c2}, "winner": w}); return w
    chain.append({"step": "18 latency p95 (tie ≤5%)", "values": {a: p95(a) for a in c2}})
    vals = [rss(a) for a in c2]
    if not all(_rel_tie(vals[0], v) for v in vals):
        w = min(c2, key=lambda a: rss(a) if rss(a) is not None else float("inf"))
        chain.append({"step": "18 peak RSS", "values": {a: rss(a) for a in c2}, "winner": w}); return w
    chain.append({"step": "18 peak RSS (tie ≤5%)", "values": {a: rss(a) for a in c2}})
    best = min(ext(a) for a in c2); c3 = [a for a in c2 if ext(a) == best]
    chain.append({"step": "18 external services", "values": {a: ext(a) for a in c2}, "kept": c3})
    if len(c3) == 1:
        return c3[0]
    chain.append({"step": "11 all tied → D"})
    return "D"


def judge(reports: Mapping[str, dict], *, deployable: Mapping[str, bool] | None = None,
          paraphrase_all_found: Mapping[str, int] | None = None) -> dict[str, Any]:
    """reports: arm -> score_arm() 결과. deployable: vFINAL 19번 최소 배포 가능성(arm별).
    paraphrase_all_found: LOW_UNDERPOWERED일 때 의역 세트 all_found 수(arm별, vFINAL 8·9번)."""
    chain: list[dict] = []
    arms = sorted(reports)
    deployable = deployable or {}

    # 14/12 전제: locator 검사를 건너뛴 리포트로는 Hard gate를 평가할 수 없다
    unchecked = [a for a in arms if not reports[a].get("locator_checked", False)]
    chain.append({"step": "14 locator checked", "unchecked": unchecked})
    if unchecked:
        return {"status": "INVALID", "reason": f"locator check skipped: {unchecked} — hard gate not evaluated",
                "chain": chain}

    # 20 non-leak pins
    bad_pins = [a for a in arms if not reports[a]["pins"]["conditions_sha_matches"]]
    chain.append({"step": "20 pins", "bad": bad_pins})
    if bad_pins:
        return {"status": "INVALID", "reason": f"conditions SHA mismatch: {bad_pins}", "chain": chain}

    # 14/16 UNRESOLVED 표시 (arm 선택 보류 사유 — 판정은 계속하되 상태에 남긴다)
    unresolved = {a: reports[a]["violations"]["unresolved"] for a in arms}
    chain.append({"step": "16 unresolved", "counts": unresolved})

    # 12 Hard
    hard_safe = [a for a in arms if reports[a]["violations"]["critical"] == 0]
    chain.append({"step": "12 hard gate", "critical": {a: reports[a]["violations"]["critical"] for a in arms},
                  "hard_safe": hard_safe})
    if not hard_safe:
        return {"status": "BLOCKED", "reason": "no hard-safe arm", "chain": chain}

    # 12 Quality (hard-safe 최고 대비 −0.01, 전체·HIGH R@10)
    def r10(a, seg): return reports[a]["segments"][seg].get(f"recall@{EVAL_K}") or 0.0
    best_all = max(r10(a, "ALL") for a in hard_safe)
    best_high = max(r10(a, "HIGH") for a in hard_safe)
    def not_inferior(value: float, best: float) -> bool:
        # vFINAL 4·12번: 최고치보다 0.01 **이상** 낮으면 탈락 → 차이 < 0.01 이어야 통과. 소수 6자리에서 비교.
        return round(best - value, 6) < QUALITY_MARGIN
    quality = [a for a in hard_safe
               if not_inferior(r10(a, "ALL"), best_all) and not_inferior(r10(a, "HIGH"), best_high)]
    chain.append({"step": "12 quality gate", "best_all": best_all, "best_high": best_high,
                  "values": {a: {"ALL": r10(a, "ALL"), "HIGH": r10(a, "HIGH")} for a in hard_safe},
                  "passed": quality})
    if not quality:
        return {"status": "NO_SELECTION", "reason": "no arm passed quality gate", "chain": chain}

    # 2/3 LOW 주 판정
    n_low = max(reports[a]["segments"]["LOW"]["questions"] for a in quality)
    if n_low >= LOW_MIN:
        counts = {a: reports[a]["segments"]["LOW"].get(f"all_found@{EVAL_K}", 0) for a in quality}
        basis = "LOW all_found@10"
    elif paraphrase_all_found:
        counts = {a: paraphrase_all_found.get(a, 0) for a in quality}
        basis = "PARAPHRASE all_found"
    else:
        # 3·8·9번: 의역 세트 없이는 성능 승자 확정 불가 → 10번 B fallback 조건
        chain.append({"step": "3 LOW_UNDERPOWERED", "n_low": n_low})
        if "B" in quality and deployable.get("B"):
            chain.append({"step": "10 B operational fallback", "selected": "B"})
            return {"status": "OPERATIONAL_FALLBACK", "winner": "B", "selection_type": "OPERATIONAL_FALLBACK",
                    "chain": chain}
        return {"status": "BLOCKED", "reason": "LOW underpowered, no paraphrase set, B fallback not eligible",
                "chain": chain}
    best = max(counts.values())
    tie_set = [a for a in quality if best - counts[a] <= TIE_MAX_DIFF]
    chain.append({"step": f"2/5 {basis}", "counts": counts, "best": best, "final_tie_set": tie_set})

    # 5 dense-off 우선
    dense_off = [a for a in tie_set if a in DENSE_OFF]
    if len(tie_set) == 1:
        winner, sel = tie_set[0], "PERFORMANCE_WINNER"
    elif dense_off:
        chain.append({"step": "5 dense-off preferred", "dense_off": dense_off})
        winner = dense_off[0] if len(dense_off) == 1 else _cd_tiebreak(reports, dense_off, chain)
        sel = "PERFORMANCE_WINNER" if len(dense_off) == 1 else "PERFORMANCE_TIE_BREAK_SELECTION"
    else:
        # C/D 없이 A/B 동률 → B (operational simplicity), 명시
        winner = "B" if "B" in tie_set else tie_set[0]
        sel = "PERFORMANCE_TIE_BREAK_SELECTION"
        chain.append({"step": "5 A/B tie → B", "winner": winner})

    if unresolved.get(winner):
        # 16C: 관련 arm 선택 보류 — 승자가 아니라 후보로만 기록한다. Owner 판정 후 재실행.
        chain.append({"step": "16C selection held", "candidate": winner, "selection_type": sel})
        return {"status": "PENDING_UNRESOLVED", "candidate": winner, "selection_type": sel,
                "tie_set": tie_set, "counts": counts, "chain": chain}
    chain.append({"step": "winner", "winner": winner, "selection_type": sel, "status": "PROVISIONAL_WINNER"})
    return {"status": "PROVISIONAL_WINNER", "winner": winner, "selection_type": sel, "tie_set": tie_set,
            "counts": counts, "chain": chain}


def summary_table(reports: Mapping[str, dict]) -> str:
    rows = ["arm | Recall@5 | Recall@10 | Recall@20 | HIGH R@10 | LOW R@10 | LOW all_found@10 | 치명 | 경미 | 미해결 | coarse | p95(ms) | RSS(MB)",
            "---|---|---|---|---|---|---|---|---|---|---|---|---"]
    for a, r in sorted(reports.items()):
        s = r["segments"]; v = r["violations"]
        rows.append(" | ".join(str(x) for x in [
            a, s["ALL"].get("recall@5"), s["ALL"].get("recall@10"), s["ALL"].get("recall@20"),
            s["HIGH"].get("recall@10"), s["LOW"].get("recall@10"),
            f'{s["LOW"].get("all_found@10")}/{s["LOW"].get("questions")}',
            v["critical"], v["minor"], v["unresolved"], v.get("coarse", 0),
            (r.get("latency_ms") or {}).get("p95"), r.get("peak_rss_mb")]))
    return "\n".join(rows)
