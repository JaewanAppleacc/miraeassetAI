"""새 질문 24문항 전체를 실제 HyperCLOVA X로 1회씩 호출한다.

정답 있는 것 6 + 함정 3 + 어려운 것 1. 문항당 호출 1회, 재시도는 production 규칙
(429만 최대 1회)을 따른다. 성공할 때까지 반복하지 않는다.

실행:
    set -a; . ./.env; set +a
    PYTHONIOENCODING=utf-8 .venv/bin/python experiments/newq/run_stage_b_llm.py
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

from run_gold25_e2e import OneShotClova, numbers  # noqa: E402

from dart_detective.agents import calculator, qa_agent  # noqa: E402
from dart_detective.corpus_retriever import CorpusRetriever  # noqa: E402
from dart_detective.llm import LLMUnavailable  # noqa: E402

TARGETS = ['N01', 'N02', 'N03', 'N04', 'N05', 'N06', 'N07', 'N08', 'N09', 'N10', 'N11', 'N12', 'N13', 'N14', 'N15', 'N16', 'N17', 'N18', 'N19', 'N20', 'N21', 'N22', 'N23', 'N24']
GAP_SECONDS = 6.0
PRICE_IN, PRICE_OUT, VAT = 1.25, 5.0, 1.1
OUT = HERE / "new24_llm_results.json"


def main() -> int:
    try:
        llm = OneShotClova()
    except LLMUnavailable as exc:
        print("CLOVA 키 없음 — 호출하지 않았다: %s" % exc, file=sys.stderr)
        return 2

    rows = {json.loads(line)["qid"]: json.loads(line)
            for line in (HERE / "new_questions.jsonl").open(encoding="utf-8") if line.strip()}
    retriever = CorpusRetriever.from_paths(
        ROOT / "experiments" / "gold25_retrieval" / "doc_index.jsonl",
        HERE / "candidate_documents.jsonl",
        sorted((ROOT / "data").rglob("universe.csv"))[0],
    )
    print("model=%s prompt=%s 대상=%s" % (llm.model, qa_agent.PROMPT_VERSION, TARGETS),
          flush=True)

    out = []
    for i, qid in enumerate(TARGETS):
        if i:
            time.sleep(GAP_SECONDS)
        r = rows[qid]
        llm.begin()
        t0 = time.perf_counter()
        state = qa_agent.answer_question(r["question"], retriever, llm=llm)
        s = state.to_dict()
        rec = llm.record
        usage = rec.get("usage") or {}

        ev_blob = "\n".join(e["text"] for e in s["evidence"])
        top20 = "\n".join(c.evidence_text for c in state.retrieval_results[:20])
        allowed = set(numbers(top20)) | {n.replace(",", "")
                                         for n in calculator.allowed_numbers(state.derived)}
        unsupported = sorted({n for n in numbers(s["answer"])
                              if n not in allowed and not re.fullmatch(r"(?:19|20)\d{2}", n)})
        checks = {c["check"]: c for c in s["validation"]["checks"]}
        entry = {
            "qid": qid, "type": r["type"], "question": r["question"],
            "expect": r["expect"],
            "expect_in_answer": [e for e in r["expect"] if e in s["answer"]],
            "expect_in_evidence": [e for e in r["expect"] if e in ev_blob],
            "llm_used": s["llm"].get("used", False),
            "api": rec.get("http", "NO_CALL"),
            "json_parse": rec.get("json_parse", "N/A"),
            "schema": rec.get("schema", "N/A"),
            "validator": s["validation"]["status"],
            "degraded_reason": s["llm"].get("degraded_reason"),
            "llm_error": s["llm"].get("error"),
            "retries": getattr(llm, "last_retries", 0),
            "n_derived": len(s["derived"]),
            "fabricated": (checks.get("numbers_grounded") or {}).get("fabricated", []),
            "unsupported_numbers": unsupported,
            "warnings": s["warnings"],
            "uncertainty": s["uncertainty"],
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "input_tokens": usage.get("promptTokens"),
            "output_tokens": usage.get("completionTokens"),
            "answer": s["answer"],
            "degraded_answer": s["llm"].get("degraded_answer"),
            "raw_text": rec.get("raw_text", ""),
        }
        out.append(entry)
        print("%-4s %-20s api=%-10s json=%-9s val=%-21s 정답포함=%s/%s tok=%s %dms" % (
            qid, entry["type"], entry["api"][:10], str(entry["json_parse"])[:9],
            entry["validator"], len(entry["expect_in_answer"]), len(r["expect"]),
            usage.get("totalTokens"), entry["latency_ms"]), flush=True)

    tin = sum(e["input_tokens"] or 0 for e in out)
    tout = sum(e["output_tokens"] or 0 for e in out)
    cost = tin / 1000 * PRICE_IN + tout / 1000 * PRICE_OUT
    summary = {
        "targets": TARGETS, "api_calls": llm.total_calls,
        "llm_answers_kept": sum(1 for e in out if e["llm_used"]),
        "json_failures": sum(1 for e in out if str(e["json_parse"]).startswith("FAIL")),
        "api_failures": sum(1 for e in out if e["api"].startswith("FAIL")),
        "fabricated_total": sum(len(e["fabricated"]) for e in out),
        "validator": {v: sum(1 for e in out if e["validator"] == v)
                      for v in {e["validator"] for e in out}},
        "tokens": {"input": tin, "output": tout, "total": tin + tout},
        "cost_krw_ex_vat": round(cost, 2), "cost_krw_inc_vat": round(cost * VAT, 2),
    }
    OUT.write_text(json.dumps({"summary": summary, "rows": out},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n=== 요약")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("\n-> %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
