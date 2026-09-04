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
  locator 검사   slot-match 청크만(vFINAL 14번). 문서 없음·node 범위 밖·**명시된 row/col 상이** = 치명.
                 텍스트가 node 원문과 대조 불가 = UNRESOLVED(16번 패킷, arm 라벨 제거 export).
                 text-method 매치(동일 근거 span, node/offset만 상이) = 경미(탈락 사유 아님, 보고만).
                 Gold가 cell 지정·결과는 node-level뿐이면 coarse(본문 대조 통과 시 통과 가능).
  16번 판정 입력  Owner의 arm-blind 패킷 판정(resolutions)을 받아 COMMON_SOURCE 공통 제외(한도
                 min(5, 세트 5%), 초과 BLOCKED) · ARM_SPECIFIC slot 실패 재계산 · UNKNOWN 보류.
                 판정 없는 패킷은 자동 분류하지 않는다(UNKNOWN 취급).

판정 체인(judge): 20 pins → 14/16 UNRESOLVED 표시 → 12 Hard(치명 0) → 12 Quality(hard-safe 최고 대비
−0.01, 전체·HIGH R@10) → 2 LOW all_found@10 비교(LOW ≥10 문항일 때) → 5 FINAL_TIE_SET(최고−1 이내)
→ dense-off 우선 → 11+18 C/D 동률(경미 위반 → p95 ≤5% → RSS ≤5% → 외부 서비스 수 → D)
→ A/B만 동률이면 B(PERFORMANCE_TIE_BREAK_SELECTION) → 3/8 LOW<10이면 LOW_UNDERPOWERED(의역 절차)
→ 10 B fallback 조건 → 불성립 BLOCKED. 승자는 PROVISIONAL_WINNER(17번 DEV_CHECK 전).

상태 라벨(혼용 금지): INVALID · BLOCKED · NO_SELECTION · PENDING_UNRESOLVED(후보만, 승자 없음 — 16C)
· PARTIAL_SET_LEADER(A/B/C/D 미완비 집합의 선두 — 비공식 진단, 'winner' 없음)
· PROVISIONAL_WINNER · OPERATIONAL_FALLBACK (뒤 둘은 4-arm 완비 시에만).

different-node 규칙(A/C 검수 3차): Gold acceptable source에 없는 node의 동일 텍스트 매치는
scorer가 경미/치명을 자동 결정하지 않는다 — UNRESOLVED(duplicate_evidence_different_node)로
Owner arm-blind 판정에 넘기고, Owner의 EQUIVALENT_EVIDENCE 판정 시에만 경미로 강등한다.
다른 기간이 확정되는 경우(Gold span 연도가 청크에 없고 청크는 다른 연도)는 치명.
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
FULL_ARM_SET = frozenset({"A", "B", "C", "D"})   # 이 집합이 아니면 공식 승자 상태를 내지 않는다(vFINAL 17)
# vFINAL 후보 정의 라벨 — --final의 config 결박(arm 바꿔치기 검출)에 쓴다.
ARM_LABELS = {"A": "FIXED+FULL_DENSE", "B": "LINE_WINDOW+LOW_ONLY_DENSE",
              "C": "FIXED+DENSE_OFF", "D": "LINE_WINDOW+DENSE_OFF"}
LINE_WINDOW = ("B", "D")

_YEAR_RE = re.compile(r"(?:19|20)\d{2}")
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


def slot_found(slot: GoldSlot, results: Sequence[Mapping[str, Any]], k: int,
               banned: frozenset[tuple[str, int]] = frozenset(), store: Any = None
               ) -> tuple[bool, Mapping[str, Any] | None, str, "GoldSource | None", str]:
    """반환: (found, result, method, 매칭된 source, span_state).

    banned: 16번 B(ARM_SPECIFIC) 판정으로 무효화된 (doc_id, node_index) — 그 결과 행은
    이 slot의 근거로 세지 않는다(spec: 해당 문항을 slots-found 실패로 계산).

    node 일치 규칙(A/C 검수 2차 반영): (doc, node) 일치만으로 인정하지 않는다 — 청크가
    라인 윈도우면 같은 node의 **다른 줄들**만 담고도 인정되던 과대 계상이 있었다.
    span_state:
      verified    Gold evidence_span 한 줄이 청크 본문에 실재(정규화 대조) — 확정 근거
      blind       대조 불가(청크 text 또는 Gold span 부재) — 종전 동작, locator 검사가 처리
      unverified  span·text 둘 다 있는데 청크에 없음 + node 원문에서도 확인 불가(렌더링 차이
                  가능성) — 매치로 세되 locator 검사가 UNRESOLVED 패킷으로 올린다(16번 Owner행)
    store가 있고 Gold span이 **node 원문에는 있는데 청크에는 없으면** = 옳은 node의 다른 창
    → 근거 미포함이 확정이므로 매치가 아니다(검사 범위 규칙: retrieval false positive).
    같은 node에 acceptable source가 여러 개면 전부 대조한다(첫 번째 고정 아님) — 결과가
    row/col을 밝혔으면 그와 일치하는 source를 우선한다."""
    def ok(r: Mapping[str, Any]) -> bool:
        return (str(r.get("doc_id") or ""), int(r.get("node_index", -1))) not in banned
    top = [r for r in list(results)[:k] if ok(r)]
    best: tuple[tuple[int, bool], Mapping[str, Any], GoldSource, str] | None = None
    for r in top:
        nodes = _result_nodes(r)
        text = norm_text(r.get("text") or "")
        rc = (r.get("row"), r.get("col"))
        for src in slot.sources:
            if r.get("doc_id") != src.doc_id or src.node_index not in nodes:
                continue
            lines = span_lines(src.span)
            if not lines or not text:
                state = "blind"
            elif any(ln in text for ln in lines):
                state = "verified"
            else:
                if store is not None and src.doc_id in store:
                    node_text = norm_text(store.fetch_node(src.doc_id, src.node_index)["text"])
                    if any(ln in node_text for ln in lines):
                        continue          # 옳은 node의 다른 창 — 근거 미포함 확정, 매치 아님
                state = "unverified"
            rank = ({"verified": 2, "blind": 1, "unverified": 0}[state],
                    rc != (None, None) and (src.row, src.col) == rc)
            if best is None or rank > best[0]:
                best = (rank, r, src, state)
    if best is not None:
        _, r, src, state = best
        return True, r, "node", src, state
    for r in top:
        t = norm_text(r.get("text") or "")
        if not t:
            continue
        for src in slot.sources:
            if r.get("doc_id") != src.doc_id:
                continue
            if any(ln in t for ln in span_lines(src.span)):
                return True, r, "text", src, "verified"
    return False, None, "", None, ""


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
                   ks: Sequence[int] = KS,
                   banned: Mapping[str, frozenset] | None = None,
                   store: Any = None) -> QuestionScore:
    """banned: slot_name → 무효화된 {(doc_id, node_index)} (16번 B ARM_SPECIFIC 재계산).
    store: slot_found의 '옳은 node의 다른 창' 판별용(없으면 unverified로 보수 처리)."""
    banned = banned or {}
    n_slots = len(gq.slots)
    qs = QuestionScore(gq.question_id, segment, n_slots, excluded=(n_slots == 0))
    results = list((rec or {}).get("results") or [])
    qs.error = (rec or {}).get("error", "") if rec is not None else "missing"
    for k in ks:
        found = 0
        for slot in gq.slots:
            ok, _, _, _, _ = slot_found(slot, results, k,
                                        banned.get(slot.slot_name, frozenset()), store)
            found += int(ok)
        qs.found_at[k] = found
        qs.all_found_at[k] = (n_slots > 0 and found == n_slots)
        docs = {r.get("doc_id") for r in results[:k]}
        qs.doc_hit_at[k] = bool(gq.gold_docs & docs) if gq.gold_docs else False
    for slot in gq.slots:
        ok, r, method, src, span_state = slot_found(
            slot, results, EVAL_K, banned.get(slot.slot_name, frozenset()), store)
        if ok and r is not None:
            # norm_only: Gold span 줄이 원문 그대로는 청크에 없고 정규화(공백·구두점 제거)로만
            # 일치 — "동일 근거, offset/정규화만 상이" = 경미 보고 대상(vFINAL 14).
            raw_text = str(r.get("text") or "")
            raw_lines = [ln.strip() for ln in (src.span if src else "").split("\n") if ln.strip()]
            norm_only = (span_state == "verified" and method == "node" and bool(raw_lines)
                         and not any(ln in raw_text for ln in raw_lines))
            qs.slot_matches.append({"slot_name": slot.slot_name, "method": method, "result": dict(r),
                                    "gold_row_col": (src.row, src.col) if src else None,
                                    "gold_span": src.span if src else "",
                                    "gold_node": src.node_index if src else None,
                                    "span_state": span_state, "norm_only": norm_only})
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
        # locator 문자열 자체도 해석한다(vFINAL 14번: 해석 불가 locator는 치명 위반).
        # 별도 doc_id/node_index 필드만 검사하면 malformed 문자열이 그대로 통과한다(검수 발견 11).
        loc_str = str(r.get("locator") or "")
        if loc_str:
            parsed = parse_locator(loc_str)
            if parsed is None:
                out.append({**base, "severity": "critical", "reason": "locator_unparseable"})
                continue
            if parsed[0] != doc_id or (r.get("node_index") is not None
                                       and parsed[1] != r.get("node_index")):
                out.append({**base, "severity": "critical",
                            "reason": f"locator_field_mismatch:{parsed[0]}#{parsed[1]}"})
                continue
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
        # span 미검증 node 매치: Gold span이 청크에도 node 원문에도 확인 안 됨(렌더링 차이
        # 가능성) — 지지 여부 판정 불가 = UNRESOLVED(16번 패킷, Owner가 arm-blind 판정).
        if m.get("span_state") == "unverified":
            out.append({**base, "severity": "unresolved", "reason": "gold_span_not_verifiable",
                        "chunk_text": r.get("text", "")[:400]})
            continue
        # text-method 매치 = Gold acceptable source에 없는 **다른 node**를 지시(vFINAL 14 치명
        # 열거 항목). 다만 청크가 자기 node에서 온 것이 본문 대조로 확인됐고 Gold span 줄이 그
        # 안에 실재하므로 "동등 근거의 반복 수록"일 가능성이 있다 — scorer가 경미/치명을 자동
        # 결정하지 않고(A/C 검수 3차: 결과를 본 뒤의 완화 금지) UNRESOLVED로 Owner arm-blind
        # 판정에 넘긴다(16번). 단, Gold span의 기간(연도)이 청크에 하나도 없고 청크가 다른
        # 연도를 담고 있으면 다른 기간 근거가 확정 → 치명.
        if m.get("method") == "text":
            gold_years = {y.group() for y in _YEAR_RE.finditer(m.get("gold_span") or "")}
            chunk_years = {y.group() for y in _YEAR_RE.finditer(str(r.get("text") or ""))}
            if gold_years and chunk_years and not (gold_years & chunk_years):
                out.append({**base, "severity": "critical",
                            "reason": f"different_node_different_period:{sorted(chunk_years)}"})
            else:
                out.append({**base, "severity": "unresolved",
                            "reason": "duplicate_evidence_different_node",
                            "chunk_text": r.get("text", "")[:400],
                            "gold_node": m.get("gold_node")})
            continue
        # 동일 node·동일 근거인데 원문 그대로가 아니라 정규화(공백·구두점)로만 일치 = 경미(보고만).
        if m.get("norm_only"):
            out.append({**base, "severity": "minor", "reason": "same_evidence_offset_or_normalization"})
        # row/col(vFINAL 14번, A/C 검수 반영으로 교정): Gold가 지정한 성분을 결과도 명시했는데
        # 값이 다르면 "다른 행/열 지시" = **치명**이다. 종전의 '경미' 처리는 원문 오독 —
        # 경미는 동일 근거의 offset 차이에 한정된다. 결과가 그 성분을 아예 안 밝힌 경우는
        # 더 거친 locator(coarse)다 — 여기 도달했다는 것은 위의 본문 대조(claim_text_not_in_node)를
        # 통과해 동일 근거임이 확인됐다는 뜻이므로 통과 가능으로 기록만 한다. locator 문법에는
        # 기간 성분이 없어 "다른 기간 지시"는 검사 대상이 발생하지 않는다.
        gold_rc = m.get("gold_row_col")
        if gold_rc and gold_rc != (None, None):
            rc = (r.get("row"), r.get("col"))
            differs = any(g is not None and c is not None and g != c
                          for g, c in zip(gold_rc, rc))
            missing = any(g is not None and c is None for g, c in zip(gold_rc, rc))
            if differs:
                out.append({**base, "severity": "critical",
                            "reason": f"row_col_differs:{rc}!={gold_rc}"})
            elif missing:
                out.append({**base, "severity": "coarse", "reason": "no_row_col_in_chunk"})
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
              conditions_sha: str | None = None, gold_sha: str | None = None,
              exclude_qids: frozenset[str] = frozenset(),
              invalid: Mapping[tuple[str, str], frozenset] | None = None) -> dict[str, Any]:
    """exclude_qids: 16번 A(COMMON_SOURCE) 공통 제외 문항 — 전 arm 동일 세트로 넘겨야 한다.
    invalid: (question_id, slot_name) → 무효 {(doc_id, node_index)} — 16번 B(ARM_SPECIFIC)."""
    invalid = invalid or {}
    qscores = [score_question(gq, results.get(qid), segments.get(qid, "?"), ks,
                              banned={s.slot_name: invalid.get((qid, s.slot_name), frozenset())
                                      for s in gq.slots} if invalid else None,
                              store=store)
               for qid, gq in gold.items() if qid not in exclude_qids]
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
        "n_common_excluded": len(exclude_qids),      # 16번 A 공통 제외(전 arm 동일)
        "common_excluded_qids": sorted(exclude_qids),
        "n_arm_specific_invalidated": len(invalid),  # 16번 B slot 무효화 건수(이 arm)
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


def packet_id_of(v: Mapping[str, Any]) -> str:
    """UNRESOLVED 위반 → arm 무관 패킷 ID. export와 16번 판정 적용이 같은 계산을 쓴다."""
    import hashlib
    key = "|".join(str(v.get(k, "")) for k in ("question_id", "slot_name", "doc_id", "node_index", "reason", "chunk_text"))
    return "u-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def unresolved_packets(report: Mapping[str, Any]) -> list[dict]:
    """vFINAL 16번: arm 라벨을 뺀 UNRESOLVED 패킷. Owner가 arm-blind로 원인만 판정한다.

    packet_id는 (question_id, slot, doc_id, node_index, reason, chunk_text)의 해시 — arm과 무관하고
    arm 간에 충돌하지 않는다. 두 arm이 같은 청크를 같은 사유로 올리면 같은 패킷 하나가 된다."""
    packets = []
    for v in report["violations"]["items"]:
        if v["severity"] != "unresolved":
            continue
        packets.append({"packet_id": packet_id_of(v),
                        "question_id": v["question_id"], "slot_name": v["slot_name"],
                        "doc_id": v["doc_id"], "node_index": v["node_index"],
                        "chunk_text": v.get("chunk_text", ""), "reason": v["reason"]})
    return packets


# ---------- vFINAL 16번: Owner 판정(resolutions) 적용 ----------

# EQUIVALENT_EVIDENCE: Owner가 "동등 근거 맞음"으로 판정한 패킷(다른 node의 동일 근거 반복 등) —
# 위반이 아니었던 것으로 확정, 매치는 유지하고 경미로 강등 기록. Gold는 동결이라 acceptable
# source를 추가할 수 없으므로 16번 판정 결과로만 표현한다.
RESOLUTION_CLASSES = ("COMMON_SOURCE", "ARM_SPECIFIC", "EQUIVALENT_EVIDENCE", "UNKNOWN")


def load_resolutions(path: Path | str) -> dict[str, dict]:
    """Owner의 패킷 판정 파일: {packet_id: {"classification": ..., "note": ..., "critical": bool}}.

    classification은 RESOLUTION_CLASSES만 허용한다. "critical"은 ARM_SPECIFIC에서만 의미가
    있다(16번 B "치명 확정 시 Hard 탈락"). 파일에 없는 패킷은 UNKNOWN으로 남는다 —
    코드가 자동으로 COMMON_SOURCE를 부여하는 일은 없다(16번 A: Owner 판정 전제)."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    out: dict[str, dict] = {}
    for pid, r in data.items():
        cls = str((r or {}).get("classification") or "").upper()
        if cls not in RESOLUTION_CLASSES:
            raise ValueError(f"resolutions[{pid}].classification={cls!r} — {RESOLUTION_CLASSES} 중 하나여야 한다")
        out[pid] = {"classification": cls, "note": str((r or {}).get("note") or ""),
                    "critical": bool((r or {}).get("critical"))}
    return out


def common_exclusion_limit(n_set: int) -> int:
    """16번 A 한도: min(5문항, 세트 5%)."""
    return min(5, int(n_set * 0.05))


def adjudication_plan(reports: Mapping[str, dict], resolutions: Mapping[str, dict],
                      n_set: int) -> dict[str, Any]:
    """arm별 UNRESOLVED 위반에 Owner 판정을 대응시켜 재채점 계획을 만든다.

    반환:
      common_qids        COMMON_SOURCE 판정 패킷의 문항 — 전 arm 공통 제외 대상
      over_limit         공통 제외가 min(5, 세트 5%) 초과 → BLOCKED(16번 A)
      per_arm_invalid    arm → {(question_id, slot_name): {(doc_id, node_index)}} — ARM_SPECIFIC 무효화
      per_arm_critical   arm → [packet_id] — Owner가 치명 확정한 ARM_SPECIFIC(Hard 탈락 반영)
      unknown_per_arm    arm → 판정 없음/UNKNOWN으로 남는 패킷 수(관련 arm 보류 사유)
    """
    common_qids: set[str] = set()
    per_arm_invalid: dict[str, dict[tuple[str, str], set]] = {}
    per_arm_critical: dict[str, list[str]] = {}
    per_arm_equivalent: dict[str, list[str]] = {}
    unknown_per_arm: dict[str, int] = {}
    for arm, rep in reports.items():
        for v in rep["violations"]["items"]:
            if v["severity"] != "unresolved":
                continue
            pid = packet_id_of(v)
            res = resolutions.get(pid)
            cls = (res or {}).get("classification", "UNKNOWN")
            if cls == "COMMON_SOURCE":
                common_qids.add(v["question_id"])
            elif cls == "ARM_SPECIFIC":
                key = (v["question_id"], v["slot_name"])
                per_arm_invalid.setdefault(arm, {}).setdefault(key, set()).add(
                    (str(v["doc_id"]), int(v["node_index"] if v["node_index"] is not None else -1)))
                if res.get("critical"):
                    per_arm_critical.setdefault(arm, []).append(pid)
            elif cls == "EQUIVALENT_EVIDENCE":
                per_arm_equivalent.setdefault(arm, []).append(pid)
            else:
                unknown_per_arm[arm] = unknown_per_arm.get(arm, 0) + 1
    limit = common_exclusion_limit(n_set)
    return {
        "common_qids": sorted(common_qids),
        "limit": limit,
        "over_limit": len(common_qids) > limit,
        "per_arm_invalid": {a: {k: frozenset(s) for k, s in m.items()}
                            for a, m in per_arm_invalid.items()},
        "per_arm_critical": per_arm_critical,
        "per_arm_equivalent": per_arm_equivalent,
        "unknown_per_arm": unknown_per_arm,
    }


def apply_equivalent_evidence(report: dict, packet_ids: Sequence[str]) -> int:
    """Owner가 EQUIVALENT_EVIDENCE로 판정한 UNRESOLVED 위반을 경미로 강등한다(매치 유지).

    재채점 리포트에 제자리 적용. 반환: 강등 건수. 위반 카운트를 다시 센다."""
    wanted = set(packet_ids)
    n = 0
    for v in report["violations"]["items"]:
        if v["severity"] == "unresolved" and packet_id_of(v) in wanted:
            v["severity"] = "minor"
            v["reason"] = f"{v['reason']}:owner_equivalent_evidence"
            n += 1
    sev = {"critical": 0, "minor": 0, "unresolved": 0, "coarse": 0}
    for v in report["violations"]["items"]:
        sev[v["severity"]] += 1
    report["violations"].update(sev)
    return n


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
          paraphrase_all_found: Mapping[str, int] | None = None,
          require_arms: set[str] | frozenset[str] | None = None,
          adjudication: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """reports: arm -> score_arm() 결과. deployable: vFINAL 19번 최소 배포 가능성(arm별).
    paraphrase_all_found: LOW_UNDERPOWERED일 때 의역 세트 all_found 수(arm별, vFINAL 8·9번).
    require_arms: 최종 판정에서 {"A","B","C","D"}를 넘겨 완비를 강제한다 — 부분 arm으로도
    잠정 판정은 돌 수 있으므로(B/D 중간 판정이 그랬다), 누락 arm이 있는 채 최종 승자를
    선언하는 실수를 판정기 수준에서 막는다(검수 발견 2)."""
    chain: list[dict] = []
    arms = sorted(reports)
    deployable = deployable or {}

    if adjudication is not None:
        # 16번 판정 적용 내역(공통 제외·arm별 무효화·잔여 UNKNOWN)을 체인 맨 앞에 남긴다.
        chain.append({"step": "16 adjudication",
                      "common_excluded": adjudication.get("common_qids", []),
                      "limit": adjudication.get("limit"),
                      "arm_specific": {a: len(m) for a, m in
                                       (adjudication.get("per_arm_invalid") or {}).items()},
                      "arm_specific_critical": adjudication.get("per_arm_critical", {}),
                      "unknown_remaining": adjudication.get("unknown_per_arm", {})})
        if adjudication.get("over_limit"):
            return {"status": "BLOCKED",
                    "reason": (f"COMMON_SOURCE 공통 제외 {len(adjudication.get('common_qids', []))}건 > "
                               f"한도 {adjudication.get('limit')} (vFINAL 16번 A)"),
                    "chain": chain}

    if require_arms is not None:
        missing_arms = sorted(set(require_arms) - set(arms))
        extra_arms = sorted(set(arms) - set(require_arms))
        chain.append({"step": "0 arm completeness", "required": sorted(require_arms),
                      "missing": missing_arms, "extra": extra_arms})
        if missing_arms or extra_arms:
            return {"status": "INVALID",
                    "reason": f"arm set mismatch: missing={missing_arms} extra={extra_arms}",
                    "chain": chain}
        incomplete = {a: reports[a].get("n_missing_or_error", 0) for a in arms
                      if reports[a].get("n_missing_or_error")}
        chain.append({"step": "0 per-arm completeness", "missing_or_error": incomplete})
        if incomplete:
            return {"status": "INVALID",
                    "reason": f"arms with missing/error questions: {incomplete}", "chain": chain}

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
            if set(arms) != FULL_ARM_SET:
                return {"status": "PARTIAL_SET_LEADER", "leader": "B",
                        "selection_basis": "OPERATIONAL_FALLBACK", "arm_set": arms, "chain": chain,
                        "note": "비공식 진단 — A/B/C/D 완비 전에는 공식 선택을 선언하지 않는다"}
            return {"status": "OPERATIONAL_FALLBACK", "winner": "B", "selection_type": "OPERATIONAL_FALLBACK",
                    "arm_set": arms, "chain": chain}
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
                "tie_set": tie_set, "counts": counts, "arm_set": arms, "chain": chain}
    if set(arms) != FULL_ARM_SET:
        # vFINAL 17: PROVISIONAL_WINNER는 4-arm 실험의 결과다. 부분 집합(B/D 중간 비교 등)의
        # 선두는 비공식 진단 상태로만 기록한다(A/C 검수 3차) — 'winner' 키를 내지 않는다.
        chain.append({"step": "17 partial set", "arm_set": arms, "leader": winner, "basis": sel})
        return {"status": "PARTIAL_SET_LEADER", "leader": winner, "selection_basis": sel,
                "arm_set": arms, "tie_set": tie_set, "counts": counts, "chain": chain,
                "note": "비공식 진단 — A/B/C/D 완비 전에는 공식 PROVISIONAL_WINNER를 선언하지 않는다"}
    chain.append({"step": "winner", "winner": winner, "selection_type": sel, "status": "PROVISIONAL_WINNER"})
    return {"status": "PROVISIONAL_WINNER", "winner": winner, "selection_type": sel, "tie_set": tie_set,
            "counts": counts, "arm_set": arms, "chain": chain}


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
