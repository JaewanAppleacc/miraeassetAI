"""Phase1 DEV_TUNE 101문항 — HCX-005 켜고 끝까지. 문항당 1회, 429만 1회 재시도.

채점(자동, 보수적):
  - status: 규칙 answerability(NOT_FOUND/WITHHELD) 또는 SUPPORTED 추정 vs 기대값
  - value : 기대 정답의 숫자들이 답변에 있는지(쉼표 유무 무시). 숫자 없는 서술형은
            기대 문장의 핵심 토큰(숫자·고유명사 조각) 절반 이상 포함 여부
  - fabricated: validator가 잡은 근거 없는 숫자
실행:
    set -a; . ./.env; set +a
    PYTHONIOENCODING=utf-8 .venv/bin/python experiments/phase1/run_llm.py [--limit N]
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "experiments" / "retrieval_lab"))

from run_gold25_e2e import OneShotClova  # noqa: E402

from dart_detective.agents import qa_agent  # noqa: E402
from dart_detective.corpus_retriever import CorpusRetriever  # noqa: E402
from dart_detective.llm import LLMUnavailable  # noqa: E402

GOLD = ROOT / "data" / "eval" / "phase1_devtune_gold.v0.1.jsonl"
OUT = HERE / "llm_results.json"
GAP = 3.0
PRICE_IN, PRICE_OUT, VAT = 1.25, 5.0, 1.1


def sq(s: str) -> str:
    return re.sub(r"[\s,]", "", s or "")


def expected_numbers(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (int, float)):
        v = int(value) if float(value).is_integer() else value
        return [sq(str(abs(v)))]
    if isinstance(value, dict):
        out = []
        for v in value.values():
            out += expected_numbers(v)
        return out
    if isinstance(value, list):
        out = []
        for v in value:
            out += expected_numbers(v)
        return out
    return [sq(n) for n in re.findall(r"\d[\d,]*(?:\.\d+)?", str(value))]


def expected_tokens(value) -> list[str]:
    """서술형 기대답의 핵심 조각: 따옴표 안 문구 + 한글 4자 이상 명사구 일부."""
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    quoted = re.findall(r"'([^']{2,40})'", text)
    words = re.findall(r"[가-힣A-Za-z]{4,}", text)
    return list(dict.fromkeys(quoted + words))[:12]


def score_value(expected, answer: str) -> tuple[str, float]:
    nums = expected_numbers(expected)
    a = sq(answer)
    if nums:
        hit = sum(1 for n in nums if n and n in a)
        return ("%d/%d" % (hit, len(nums)), hit / len(nums))
    toks = expected_tokens(expected)
    if not toks:
        return ("-", 1.0)
    hit = sum(1 for t in toks if sq(t) in a)
    return ("%d/%d" % (hit, len(toks)), hit / len(toks))


def main() -> int:
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    try:
        llm = OneShotClova()
    except LLMUnavailable as exc:
        print("키 없음 — 호출 안 함: %s" % exc, file=sys.stderr)
        return 2
    retriever = CorpusRetriever.from_paths(
        ROOT / "experiments" / "gold25_retrieval" / "doc_index.jsonl",
        HERE / "candidate_documents.jsonl",
        sorted((ROOT / "data").rglob("universe.csv"))[0])
    rows = [json.loads(l) for l in GOLD.open(encoding="utf-8") if l.strip()]
    if limit:
        rows = rows[:limit]
    print("model=%s prompt=%s n=%d" % (llm.model, qa_agent.PROMPT_VERSION, len(rows)), flush=True)
    out = []
    for i, r in enumerate(rows, 1):
        if i > 1:
            time.sleep(GAP)
        llm.begin()
        t0 = time.perf_counter()
        state = qa_agent.answer_question(r["question"], retriever, llm=llm)
        s = state.to_dict()
        rec = llm.record
        usage = rec.get("usage") or {}
        checks = {c["check"]: c for c in s["validation"]["checks"]}
        rule = s.get("answerability") or ""
        status = rule or ("SUPPORTED" if s["evidence"] and s["validation"]["status"] != "UNSUPPORTED"
                          else "NOT_FOUND")
        exp_status = r["expected_answerability"]
        vlabel, vscore = score_value(r["expected_answer"].get("value"), s["answer"])
        entry = {
            "qid": r["question_id"], "type": r["question_type"], "mode": r["answer_mode"],
            "difficulty": r["difficulty"], "doc_groups": r["doc_groups"],
            "question": r["question"], "expected": r["expected_answer"],
            "status": status, "expected_status": exp_status, "status_ok": status == exp_status,
            "value_label": vlabel, "value_score": vscore,
            "value_ok": (vscore >= 0.999) if exp_status == "SUPPORTED" else None,
            "llm_used": bool(s["llm"].get("used")) and not s["llm"].get("degraded"),
            "llm_meta": {k: v for k, v in s["llm"].items() if k != "degraded_answer"},
            "api": rec.get("http", "NO_CALL"), "json_parse": rec.get("json_parse", "N/A"),
            "validator": s["validation"]["status"],
            "fabricated": (checks.get("numbers_grounded") or {}).get("fabricated", []),
            "confidence": s["confidence"].get("score"),
            "n_evidence": len(s["evidence"]), "n_derived": len(s["derived"]),
            "input_tokens": usage.get("promptTokens"), "output_tokens": usage.get("completionTokens"),
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "answer": s["answer"], "raw_text": rec.get("raw_text", ""),
        }
        out.append(entry)
        print("%3d %-18s %-6s st=%-9s%s val=%-6s llm=%-5s fab=%s tok=%s" % (
            i, entry["type"][:18], entry["mode"], status, "OK" if entry["status_ok"] else "XX",
            vlabel, entry["llm_used"], entry["fabricated"] or "0", usage.get("totalTokens")), flush=True)
        OUT.write_text(json.dumps({"rows": out}, ensure_ascii=False, indent=1), encoding="utf-8")

    tin = sum(e["input_tokens"] or 0 for e in out)
    tout = sum(e["output_tokens"] or 0 for e in out)
    cost = tin / 1000 * PRICE_IN + tout / 1000 * PRICE_OUT
    sup = [e for e in out if e["expected_status"] == "SUPPORTED"]
    summary = {
        "n": len(out), "api_calls": llm.total_calls,
        "status_ok": sum(1 for e in out if e["status_ok"]),
        "value_full": sum(1 for e in sup if e["value_ok"]),
        "value_partial": sum(1 for e in sup if not e["value_ok"] and e["value_score"] > 0),
        "value_zero": sum(1 for e in sup if e["value_score"] == 0),
        "n_supported": len(sup),
        "llm_kept": sum(1 for e in out if e["llm_used"]),
        "json_fail": sum(1 for e in out if str(e["json_parse"]).startswith("FAIL")),
        "fabricated_total": sum(len(e["fabricated"]) for e in out),
        "tokens": {"in": tin, "out": tout},
        "cost_krw_ex_vat": round(cost, 2), "cost_krw_inc_vat": round(cost * VAT, 2),
    }
    for key in ("mode", "type"):
        summary["by_" + key] = {}
        for k in sorted({e[key] for e in sup}):
            grp = [e for e in sup if e[key] == k]
            summary["by_" + key][k] = "%d/%d full" % (sum(1 for e in grp if e["value_ok"]), len(grp))
    OUT.write_text(json.dumps({"summary": summary, "rows": out}, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    print("\n" + json.dumps(summary, ensure_ascii=False, indent=1))
    print("-> %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
