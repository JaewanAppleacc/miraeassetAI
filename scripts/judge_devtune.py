"""심사위원 모드 — DEV_TUNE 101을 실서빙 경로로 돌리고, 채점 축별로 자동 판정해 문항별 결함을 태깅한다.

주최측 8개 축 중 자동 판정 가능한 것을 기계 채점한다(v4 §4 대응):
    정확성        expected_answer.value의 모든 값이 answer에 있는가 (full/partial/zero)
    근거 완전성    Gold required slot이 retrieved_context에 몇 개 실렸는가 ((doc_id,node) 또는 span 대조)
    정보한계      답변가능성(NOT_FOUND/WITHHELD/SUPPORTED)이 기대와 일치하는가
    근거 표시     answer 또는 context에 접수번호가 있는가
    근거 기반     파이프라인 검증 상태(UNSUPPORTED로 나간 답 여부) + 폴백 발동
추론 논리성·안전성·요구사항 충족(서술형)은 자동 판정이 불완전하므로 보조 지표(길이·slot 수)만 남긴다.

실패 태깅(v4 §16 어휘):
    RETRIEVAL_MISS      필수 slot이 context에 일부/전부 없음 (검색·근거선택 문제)
    VALUE_NOT_EXTRACTED slot은 context에 다 있는데 값이 answer에 없음 (LLM/조립 문제)
    ANSWERABILITY_WRONG 답변가능성 오판
    LLM_PATH_FAILED     degraded/llm_error/폴백 발동
    NARRATIVE_THIN      OPEN 서술형인데 answer가 짧음(<200자) — 수동 확인 대상

실행(HCX 필요):
    set -a; source .env; set +a
    PYTHONIOENCODING=utf-8 .venv/bin/python scripts/judge_devtune.py
출력: results/judge/wires.jsonl(응답 원문) · judge.jsonl(문항별 판정) · summary.json
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from dart_corpus.evaluation.fourarm import parse_locator, span_lines, norm_text  # noqa: E402
from dart_detective import answer_api  # noqa: E402


def value_forms(v) -> list[str]:
    """expected_answer 값 하나 → answer에서 찾을 수 있는 표기 후보들."""
    if v is None or isinstance(v, (dict, list)):
        return []
    if isinstance(v, bool):
        return []
    if isinstance(v, (int, float)):
        forms = {str(v), f"{v:,}"}
        if isinstance(v, float) and v.is_integer():
            forms |= {str(int(v)), f"{int(v):,}"}
        return sorted(forms)
    s = str(v)
    nums = re.findall(r"-?\d[\d,\.]*\d|\d", s)
    return nums[:8] if nums else ([s[:30]] if s.strip() else [])


def expected_values(g: dict) -> dict[str, list[str]]:
    ea = g.get("expected_answer") or {}
    v = ea.get("value")
    out: dict[str, list[str]] = {}
    if isinstance(v, dict):
        for k, x in v.items():
            forms = value_forms(x)
            if forms:
                out[str(k)] = forms
    else:
        forms = value_forms(v)
        if forms:
            out["value"] = forms
    return out


def context_entries(wire: dict) -> list[dict]:
    try:
        d = json.loads(wire["retrieved_context"])
        return d if isinstance(d, list) else []
    except Exception:  # noqa: BLE001
        return []


def slot_in_context(slot: dict, entries: list[dict]) -> bool:
    for src in slot.get("acceptable_sources") or []:
        parsed = parse_locator(src.get("source_locator", ""))
        lines = span_lines(src.get("evidence_span") or "")
        for e in entries:
            doc = e.get("document_id") or ""
            if parsed and doc == parsed[0]:
                ep = parse_locator(e.get("source_locator", ""))
                if ep and ep[1] == parsed[1]:
                    return True
            qt = norm_text(e.get("quoted_text") or e.get("quote_or_fact") or "")
            if qt and doc == (src.get("document_id") or ""):
                if any(ln in qt or qt in ln for ln in lines):
                    return True
    return False


def judge_one(g: dict, wire: dict, meta: dict) -> dict:
    answer = wire.get("answer") or ""
    answer_sq = norm_text(answer)
    entries = context_entries(wire)
    try:
        trace = json.loads(wire["think_trace"])
        got_ans = str((trace.get("validation") or {}).get("answerability") or "SUPPORTED")
    except Exception:  # noqa: BLE001
        got_ans = "?"
    expected_ans = g.get("expected_answerability", "SUPPORTED")
    ans_ok = (got_ans == expected_ans
              or (expected_ans == "SUPPORTED" and got_ans not in ("NOT_FOUND", "WITHHELD")))

    ev = expected_values(g)
    found = {k: any(norm_text(f) in answer_sq for f in forms) for k, forms in ev.items()}
    if not ev:
        value_score = "na"
    elif all(found.values()):
        value_score = "full"
    elif any(found.values()):
        value_score = "partial"
    else:
        value_score = "zero"

    slots = g.get("required_evidence_slots") or []
    n_in_ctx = sum(1 for s in slots if slot_in_context(s, entries))
    citation_ok = bool(re.search(r"\d{14}", answer + wire.get("retrieved_context", "")))

    tags = []
    if not ans_ok:
        tags.append("ANSWERABILITY_WRONG")
    if slots and n_in_ctx < len(slots):
        tags.append("RETRIEVAL_MISS")
    if value_score in ("zero", "partial") and slots and n_in_ctx == len(slots):
        tags.append("VALUE_NOT_EXTRACTED")
    if meta.get("fallback_stage") or meta.get("degraded") or meta.get("llm_error"):
        tags.append("LLM_PATH_FAILED")
    if g.get("answer_mode") == "OPEN" and expected_ans == "SUPPORTED" and len(answer) < 200:
        tags.append("NARRATIVE_THIN")

    return {
        "question_id": g["question_id"],
        "type": g.get("question_type"), "mode": g.get("answer_mode"),
        "difficulty": g.get("difficulty"),
        "expected_answerability": expected_ans, "got_answerability": got_ans,
        "answerability_ok": ans_ok,
        "value_score": value_score,
        "values_missing": sorted(k for k, ok in found.items() if not ok),
        "slots_in_context": f"{n_in_ctx}/{len(slots)}",
        "citation_ok": citation_ok,
        "validation_status": meta.get("validation_status"),
        "strategy": meta.get("strategy"),
        "llm_used": meta.get("llm_used"),
        "fallback_stage": meta.get("fallback_stage") or "",
        "answer_chars": len(answer),
        "tags": tags,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="심사위원 모드 101문항")
    p.add_argument("--gold", type=Path, default=REPO / "data" / "eval" / "phase1_devtune_gold.v0.1.jsonl")
    p.add_argument("--out-dir", type=Path, default=REPO / "results" / "judge")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--reuse-wires", action="store_true", help="이미 저장된 wires.jsonl 재채점")
    args = p.parse_args(argv)

    gold = [json.loads(l) for l in args.gold.open(encoding="utf-8") if l.strip()]
    if args.limit:
        gold = gold[:args.limit]
    args.out_dir.mkdir(parents=True, exist_ok=True)
    wires_path = args.out_dir / "wires.jsonl"

    wires: dict[str, tuple[dict, dict]] = {}
    if args.reuse_wires and wires_path.exists():
        for line in wires_path.open(encoding="utf-8"):
            if line.strip():
                r = json.loads(line)
                wires[r["wire"]["question_id"]] = (r["wire"], r["meta"])
    else:
        with wires_path.open("w", encoding="utf-8") as f:
            for i, g in enumerate(gold, 1):
                t0 = time.perf_counter()
                wire, meta = answer_api.answer_ex(g["question_id"], g["question"])
                meta["latency_ms"] = int((time.perf_counter() - t0) * 1000)
                meta.pop("policy", None)
                wires[g["question_id"]] = (wire, meta)
                f.write(json.dumps({"wire": wire, "meta": meta}, ensure_ascii=False) + "\n")
                if i % 10 == 0:
                    print(f"{i}/{len(gold)}", file=sys.stderr, flush=True)

    rows = []
    with (args.out_dir / "judge.jsonl").open("w", encoding="utf-8") as f:
        for g in gold:
            wire, meta = wires[g["question_id"]]
            row = judge_one(g, wire, meta)
            rows.append(row)
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    supported = [r for r in rows if r["expected_answerability"] == "SUPPORTED" and r["value_score"] != "na"]
    def count(pred):
        return sum(1 for r in rows if pred(r))
    summary = {
        "n": len(rows),
        "answerability_ok": count(lambda r: r["answerability_ok"]),
        "value": dict(collections.Counter(r["value_score"] for r in supported)),
        "value_denominator": len(supported),
        "slots_full_in_context": count(lambda r: r["slots_in_context"].split("/")[0] == r["slots_in_context"].split("/")[1] and r["slots_in_context"] != "0/0"),
        "citation_ok": count(lambda r: r["citation_ok"]),
        "tags": dict(collections.Counter(t for r in rows for t in r["tags"]).most_common()),
        "by_type_value_full": {
            t: f"{sum(1 for r in supported if r['type'] == t and r['value_score'] == 'full')}/{sum(1 for r in supported if r['type'] == t)}"
            for t in sorted({r["type"] for r in supported})},
        "fallbacks": count(lambda r: r["fallback_stage"]),
        # 게이트 발동 분포 — 커밋 산출물만으로 검증 가능하게(코덱스 검수: wires 없이는 확인 불가).
        "llm_degraded_reason": dict(collections.Counter(
            (m.get("llm_degraded_reason") or "") for _, m in wires.values()
            if m.get("llm_degraded_reason"))),
    }
    (args.out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
