"""5번 — 실호출 2탕: (A) 폐기 9문항 HCX-005 재실행(공백수리 생존율),
(B) 같은 9 + 형식실패 3문항 HCX-007(모델 스위치). 문항당 1회, 재시도 없음.

실행:
    set -a; . ./.env; set +a
    PYTHONIOENCODING=utf-8 .venv/bin/python experiments/newq/run_step5_llm.py A
    PYTHONIOENCODING=utf-8 .venv/bin/python experiments/newq/run_step5_llm.py B
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "experiments" / "retrieval_lab"))

from run_gold25_e2e import OneShotClova  # noqa: E402

from dart_corpus.evaluation.gold25 import load_gold_questions  # noqa: E402
from dart_detective import qa_service  # noqa: E402
from dart_detective.agents import qa_agent  # noqa: E402
from dart_detective.llm import LLMUnavailable  # noqa: E402

DISCARDED = ["Q04", "Q08", "Q09", "Q14", "Q15", "Q17", "Q18", "Q20", "Q22"]
FORMAT_FAIL = ["Q02", "Q19", "Q23"]
# B는 크레딧 최소화로 축소: 모델 스위치 가설(JSON 내부 손상이 모델 문제인가)은
# 형식실패 3문항이면 검증된다. 폐기 9건의 재측정은 run A(HCX-005)가 담당한다.
RUNS = {"A": ("HCX-005", DISCARDED),
        "B": ("HCX-007", FORMAT_FAIL)}
GAP = 6.0
PRICE_IN, PRICE_OUT, VAT = 1.25, 5.0, 1.1


def main() -> int:
    mode = (sys.argv[1] if len(sys.argv) > 1 else "").upper()
    if mode not in RUNS:
        print("A 또는 B를 지정하라", file=sys.stderr)
        return 2
    model, qids = RUNS[mode]
    try:
        llm = OneShotClova(model=model)
    except LLMUnavailable as exc:
        print(f"키 없음 — 호출 안 함: {exc}", file=sys.stderr)
        return 2

    questions = {q.qid: q for q in load_gold_questions(ROOT / "data" / "eval" / "gold25.jsonl")}
    retriever = qa_service.get_retriever()
    print(f"run {mode} · model={model} · 대상 {qids}", flush=True)

    rows = []
    for i, qid in enumerate(qids):
        if i:
            time.sleep(GAP)
        llm.begin()
        t0 = time.perf_counter()
        state = qa_agent.answer_question(questions[qid].question, retriever, llm=llm)
        out = state.to_dict()
        rec = llm.record
        usage = rec.get("usage") or {}
        checks = {c["check"]: c for c in out["validation"]["checks"]}
        rows.append({
            "qid": qid, "model": model,
            "llm_kept": bool(out["llm"].get("used")) and not out["llm"].get("degraded"),
            "degraded_reason": out["llm"].get("degraded_reason"),
            "llm_error": out["llm"].get("error"),
            "api": rec.get("http", "NO_CALL"),
            "json_parse": rec.get("json_parse", "N/A"),
            "validator": out["validation"]["status"],
            "fabricated": (checks.get("numbers_grounded") or {}).get("fabricated", []),
            "units_ok": (checks.get("units_consistent") or {}).get("passed"),
            "confidence": out["confidence"].get("score"),
            "input_tokens": usage.get("promptTokens"),
            "output_tokens": usage.get("completionTokens"),
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "answer_head": out["answer"][:120],
            "raw_text": rec.get("raw_text", ""),
        })
        r = rows[-1]
        print("%-4s kept=%-5s json=%-9s val=%-21s fab=%s tok=%s" % (
            qid, r["llm_kept"], str(r["json_parse"])[:9], r["validator"],
            r["fabricated"] or "0", usage.get("totalTokens")), flush=True)

    tin = sum(r["input_tokens"] or 0 for r in rows)
    tout = sum(r["output_tokens"] or 0 for r in rows)
    cost = tin / 1000 * PRICE_IN + tout / 1000 * PRICE_OUT
    summary = {"model": model, "kept": sum(1 for r in rows if r["llm_kept"]),
               "total": len(rows),
               "json_fail": sum(1 for r in rows if str(r["json_parse"]).startswith("FAIL")),
               "fabricated_total": sum(len(r["fabricated"]) for r in rows),
               "tokens": {"in": tin, "out": tout},
               "cost_krw_ex_vat": round(cost, 2),
               "cost_krw_inc_vat": round(cost * VAT, 2)}
    out_path = HERE / f"step5_run_{mode}.json"
    out_path.write_text(json.dumps({"summary": summary, "rows": rows},
                                   ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n" + json.dumps(summary, ensure_ascii=False))
    print(f"-> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
